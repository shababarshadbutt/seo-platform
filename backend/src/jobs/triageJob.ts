import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import { enumeratePopulation } from "./patternPopulation.js";
import {
  estimateFromObservations,
  planTriageExpansion,
  planTriageSample,
  TRIAGE_SAMPLE_RATE,
  type StratumObservation,
  type TriagePlan
} from "./triageSampling.js";
import { probeUrl, verifyConcurrency } from "./verifyProbe.js";
import { VERIFY_PROBLEM_STATUSES } from "./verifyUrlsJob.js";
import type { TriageSampleJobData } from "../queue/triageQueue.js";

// Sample triage: the fast, approximate read on ONE pattern.
//
// This is a TRIAGE layer, not a verification. It answers "is there a problem
// here worth spending 17 minutes on, and roughly how big?" by probing about 1%
// of the pattern — a few hundred URLs — instead of all of them. Nothing it
// produces is ever actionable: no delete path reads verify_triage_runs, and the
// UI is required to label every number from it as an estimate. Deleting still
// needs verified_urls rows from a full run, for the same reason the project
// chose measurement over inference everywhere else.
//
// The sampling design (dedupe, stratify by sub-pattern, hash-based draw,
// adaptive expansion, stratified estimator) lives in triageSampling.ts and is
// pure. This file is the I/O: enumerate, probe under the rate limiter, persist.

type SessionRow = {
  id: string;
  base_url: string;
  concurrency: number;
  user_agent: string;
};

type PatternRow = {
  id: string;
  template: string;
};

async function markFailed(runId: string, message: string) {
  await pool.query(
    "UPDATE verify_triage_runs SET status = 'FAILED', error = $2, completed_at = now() WHERE id = $1",
    [runId, message]
  );
}

// Probe one round's URLs and fold the answers back into per-stratum tallies.
async function probePlan(
  plan: TriagePlan,
  session: SessionRow,
  pattern: PatternRow,
  logger: FastifyBaseLogger,
  tallies: Map<string, StratumObservation>
) {
  const items: Array<{ label: string; url: string }> = [];

  for (const stratum of plan.strata) {
    let tally = tallies.get(stratum.label);

    if (!tally) {
      tally = {
        label: stratum.label,
        population: stratum.population,
        sampled: 0,
        hitsByStatus: new Map<number, number>()
      };
      tallies.set(stratum.label, tally);
    }

    for (const url of stratum.urls) {
      items.push({ label: stratum.label, url });
    }
  }

  await runWithBoundedConcurrency(
    items,
    verifyConcurrency(session.concurrency),
    async (item, index) => {
      const result = await probeUrl(
        session.base_url,
        item.url,
        session.user_agent,
        logger,
        {
          sessionId: session.id,
          patternId: pattern.id,
          template: pattern.template,
          sampleIndex: index
        }
      );

      return { label: item.label, status: result.httpStatus };
    },
    (settled) => {
      const tally = tallies.get(settled.label);

      if (!tally) {
        return;
      }

      tally.sampled += 1;

      if (settled.status !== null) {
        tally.hitsByStatus.set(
          settled.status,
          (tally.hitsByStatus.get(settled.status) ?? 0) + 1
        );
      }
    }
  );
}

export async function processTriageSampleJob(
  data: TriageSampleJobData,
  logger: FastifyBaseLogger
) {
  const {
    session_id: sessionId,
    pattern_id: patternId,
    run_id: runId,
    target_statuses: requestedStatuses
  } = data;

  const targetStatuses =
    requestedStatuses && requestedStatuses.length > 0
      ? requestedStatuses
      : VERIFY_PROBLEM_STATUSES;

  logger.info(
    {
      session_id: sessionId,
      pattern_id: patternId,
      run_id: runId,
      target_statuses: targetStatuses
    },
    "triage sample job started"
  );

  const startedAtMs = Date.now();

  try {
    const sessionResult = await pool.query<SessionRow>(
      "SELECT id, base_url, concurrency, user_agent FROM sessions WHERE id = $1",
      [sessionId]
    );
    const session = sessionResult.rows[0];

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const patternResult = await pool.query<PatternRow>(
      "SELECT id, template FROM patterns WHERE id = $1 AND session_id = $2",
      [patternId, sessionId]
    );
    const pattern = patternResult.rows[0];

    if (!pattern) {
      throw new Error(`Pattern not found: ${patternId}`);
    }

    await pool.query(
      "UPDATE verify_triage_runs SET status = 'RUNNING' WHERE id = $1",
      [runId]
    );

    // Same enumerator the full verification uses, so triage's denominator and
    // verification's denominator are the same number.
    const population = await enumeratePopulation(sessionId, [pattern], logger);
    const allUrls = Array.from(population.keys());

    const plan = planTriageSample(allUrls, pattern.template);

    await pool.query(
      "UPDATE verify_triage_runs SET population_total = $2, sampled_total = $3 WHERE id = $1",
      [runId, plan.populationTotal, plan.sampledTotal]
    );

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        run_id: runId,
        population_total: plan.populationTotal,
        sampled_total: plan.sampledTotal,
        strata: plan.strata.map((stratum) => ({
          label: stratum.label,
          population: stratum.population,
          sampled: stratum.urls.length
        }))
      },
      "triage sample: plan built, probing"
    );

    const tallies = new Map<string, StratumObservation>();

    await probePlan(plan, session, pattern, logger, tallies);

    // Adaptive expansion: look harder ONLY where the first round found
    // something and the estimate is too thin to quote.
    const expansion = planTriageExpansion(
      plan,
      Array.from(tallies.values()),
      targetStatuses,
      pattern.template,
      allUrls
    );
    let expanded = false;

    if (expansion) {
      expanded = true;

      logger.info(
        {
          session_id: sessionId,
          pattern_id: patternId,
          run_id: runId,
          extra_sampled: expansion.sampledTotal,
          strata: expansion.strata.map((stratum) => stratum.label)
        },
        "triage sample: anomaly detected, expanding sample"
      );

      await probePlan(expansion, session, pattern, logger, tallies);
    }

    const observations = Array.from(tallies.values());
    const estimates = estimateFromObservations(observations, targetStatuses);
    const sampledTotal = observations.reduce(
      (sum, observation) => sum + observation.sampled,
      0
    );
    const durationMs = Date.now() - startedAtMs;

    const result = {
      // The REAL rate probed, not the nominal 1%: the min/max clamps and any
      // expansion move it, and the UI quotes this number.
      sample_rate:
        plan.populationTotal > 0 ? sampledTotal / plan.populationTotal : 0,
      nominal_sample_rate: TRIAGE_SAMPLE_RATE,
      duration_ms: durationMs,
      target_statuses: targetStatuses,
      estimates: estimates.map((estimate) => ({
        http_status: estimate.httpStatus,
        observed: estimate.observed,
        estimate: estimate.estimate,
        ci_low: estimate.ciLow,
        ci_high: estimate.ciHigh
      })),
      strata: observations.map((observation) => ({
        label: observation.label,
        population: observation.population,
        sampled: observation.sampled,
        hits_by_status: Object.fromEntries(
          Array.from(observation.hitsByStatus.entries()).map(([status, count]) => [
            String(status),
            count
          ])
        )
      }))
    };

    await pool.query(
      `
        UPDATE verify_triage_runs
        SET status = 'COMPLETE',
            sampled_total = $2,
            expanded = $3,
            result = $4::jsonb,
            completed_at = now()
        WHERE id = $1
      `,
      [runId, sampledTotal, expanded, JSON.stringify(result)]
    );

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        run_id: runId,
        population_total: plan.populationTotal,
        sampled_total: sampledTotal,
        expanded,
        duration_ms: durationMs,
        estimates: result.estimates
      },
      "triage sample job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await markFailed(runId, message);
    throw error;
  }
}
