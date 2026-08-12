import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import {
  checkSampleUrl,
  isRealMeasurement,
  type SampleCheckResult
} from "./sampleUrlCheck.js";
import {
  acquireHostSlot,
  rateLimitHostKey,
  verificationRateLimit
} from "../http/hostRateLimiter.js";
import { createHostStrategyRun } from "../http/hostStrategyRun.js";
import { resolveSampleTarget } from "./sampleTarget.js";
// Pure scoring lives in its own module so it is unit-testable without loading
// this job (and with it a BullMQ/Redis connection). See patternScore.ts.
import { calculatePatternScore } from "./patternScore.js";
import { isSessionCancelled, markSessionComplete } from "./sessionCompletion.js";

// The per-URL HTTP checker (HEAD -> GET fallback -> soft-404 sniff) lives in
// sampleUrlCheck.ts so the full-population verifier (verifyUrlsJob.ts) and unit
// tests can reuse it without importing this job — which transitively opens a
// BullMQ/Redis connection at module load via sessionCompletion ->
// preGenerateZipQueue. Re-exported here so existing import sites keep working.
export {
  classifyRequestError,
  type SampleErrorReason
} from "./sampleUrlCheck.js";

type SessionRow = {
  id: string;
  base_url: string;
  sample_size: number;
  concurrency: number;
  user_agent: string;
};

type PatternRow = {
  id: string;
  template: string;
  total_urls: string;
  source_file: string | null;
};

type PatternUrlRow = {
  id: string;
  path: string;
  // The <loc> exactly as it appeared in the sitemap, host included. Needed
  // because base_url and the sitemap can disagree about the "www." label.
  source_url: string | null;
};


async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;

      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from(
      {
        length: workerCount
      },
      runWorker
    )
  );

  return results;
}

// A URL to negotiate this host's request strategy with.
//
// DEEP, never the bare root. Measured evidence: on weareelectromechanicals.com "/"
// was refused while /product/{param} scored GOOD in the same run — entry-point paths
// routinely get stricter treatment than deep content paths, so negotiating on "/"
// would pick a pessimistic recipe (or a false REFUSED) for the whole host.
//
// SAFETY FILTER: skip URLs already known from this pattern's prior samples to be a
// redirect or a soft-404. Those still WIN a rung — a host whose pages 301 is
// perfectly measurable — but a clean 200 is the least ambiguous evidence, and if the
// probe URL happens to be a permanent redirect off-host the negotiation would be
// judging the wrong origin.
//
// Depth is counted from slashes: "/a/b" has two, "/" has one, so >= 2 excludes the
// root and any single-segment path.
async function loadNegotiationProbeUrl(patternId: string) {
  const preferred = await pool.query<PatternUrlRow>(
    `
      SELECT pu.id, pu.path, pu.source_url
      FROM pattern_urls pu
      WHERE pu.pattern_id = $1
        AND (length(pu.path) - length(replace(pu.path, '/', ''))) >= 2
        AND NOT EXISTS (
          SELECT 1
          FROM sampled_urls su
          WHERE su.pattern_id = pu.pattern_id
            AND su.http_status_category IN ('redirect', 'soft_404')
            AND su.url LIKE '%' || pu.path
        )
      ORDER BY random()
      LIMIT 1
    `,
    [patternId]
  );

  if (preferred.rows[0]) {
    return preferred.rows[0];
  }

  // Relaxed: any deep URL, even a known redirect. Still better than the root.
  const anyDeep = await pool.query<PatternUrlRow>(
    `
      SELECT id, path, source_url
      FROM pattern_urls
      WHERE pattern_id = $1
        AND (length(path) - length(replace(path, '/', ''))) >= 2
      ORDER BY random()
      LIMIT 1
    `,
    [patternId]
  );

  return anyDeep.rows[0] ?? null;
}

async function loadSamplePool(patternId: string, sampleLimit: number) {
  if (sampleLimit <= 0) {
    return [];
  }

  const result = await pool.query<PatternUrlRow>(
    `
      SELECT id, path, source_url
      FROM pattern_urls
      WHERE pattern_id = $1
      ORDER BY random()
      LIMIT $2
    `,
    [patternId, sampleLimit]
  );

  return result.rows;
}

async function persistPatternSamples(
  patternId: string,
  results: SampleCheckResult[],
  sourceFile: string | null
) {
  const score = calculatePatternScore(results);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sampled_urls WHERE pattern_id = $1", [
      patternId
    ]);

    for (const result of results) {
      await client.query(
        `
          INSERT INTO sampled_urls (
            pattern_id,
            url,
            http_status,
            response_ms,
            is_hit,
            is_soft_404,
            checked_at,
            final_url,
            redirect_count,
            http_status_category,
            source_file,
            error_reason,
            used_fallback_profile
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11, $12)
        `,
        [
          patternId,
          result.url,
          result.httpStatus,
          result.responseMs,
          result.isHit,
          result.isSoft404,
          result.finalUrl,
          result.redirectCount,
          result.httpStatusCategory,
          sourceFile,
          result.errorReason,
          // Which profile produced this verdict (mig 043) — a pattern that needed
          // the browser fallback must not look like one that never did.
          result.usedFallbackProfile
        ]
      );
    }

    await client.query(
      `
        UPDATE patterns
        SET
          confidence_pct = $2,
          redirect_pct = $3,
          status = $4
        WHERE id = $1
      `,
      [patternId, score.confidencePct, score.redirectPct, score.status]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return score;
}

async function patternAlreadySampled(patternId: string) {
  const result = await pool.query(
    "SELECT 1 FROM sampled_urls WHERE pattern_id = $1 LIMIT 1",
    [patternId]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

// Mark every parsed, non-index file as sample-complete once sampling finishes.
// Sampling itself is pattern-scoped (sampled_urls key off pattern_id, not a
// file), so this is a coarse per-file checkpoint used by the resume endpoint to
// tell that the sample phase completed for the session. (v1.36 Fix 2)
async function markSampledFilesDone(sessionId: string) {
  await pool.query(
    `
      UPDATE sitemap_files
      SET sample_status = 'done'
      WHERE session_id = $1
        AND parsed_at IS NOT NULL
        AND is_index = FALSE
    `,
    [sessionId]
  );
}

export async function processSamplePatternsJob(
  data: {
    session_id: string;
    sitemap_file_id?: string;
    resume?: boolean;
    // Re-check exactly ONE pattern (see SamplePatternsJobData). Scoped runs are
    // deliberately inert with respect to the session's lifecycle: they do not flip
    // it to SAMPLING, do not mark files sample-complete, do not re-finalise it and
    // do not mark it FAILED. A completed session must not appear to reopen — and
    // must not sprout a Resume banner — because one row was re-measured.
    pattern_id?: string;
  },
  logger: FastifyBaseLogger
) {
  const scopedPatternId = data.pattern_id ?? null;

  if (await isSessionCancelled(data.session_id)) {
    logger.info(
      { session_id: data.session_id },
      "sample patterns job skipped — session cancelled"
    );
    return;
  }

  const sessionResult = await pool.query<SessionRow>(
    `
      SELECT id, base_url, sample_size, concurrency, user_agent
      FROM sessions
      WHERE id = $1
    `,
    [data.session_id]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new Error(`Session not found: ${data.session_id}`);
  }

  logger.info(
    {
      session_id: data.session_id,
      sitemap_file_id: data.sitemap_file_id,
      pattern_id: scopedPatternId
    },
    "sample patterns job started"
  );

  if (!scopedPatternId) {
    await pool.query("UPDATE sessions SET status = 'SAMPLING' WHERE id = $1", [
      data.session_id
    ]);
  }

  try {
    const patternsResult = await pool.query<PatternRow>(
      `
        SELECT id, template, total_urls, source_file
        FROM patterns
        WHERE session_id = $1
          AND source_role = 'current'
          AND ($2::uuid IS NULL OR id = $2::uuid)
        ORDER BY total_urls DESC, template ASC
      `,
      [data.session_id, scopedPatternId]
    );
    let sampledUrlCount = 0;
    let skippedPatternCount = 0;
    let refusedPatternCount = 0;
    let emptyPoolPatternCount = 0;
    const strategyRun = createHostStrategyRun(session.user_agent, logger, {
      sessionId: data.session_id,
      // A scoped run is the Check button re-measuring ONE pattern, which is a different
      // thing from a session's original sampling pass and has to be readable as such:
      // "the row still says Not scored after I pressed Check" is answered by the recheck
      // events, and mixing them into the sampling ones would hide it.
      phase: scopedPatternId ? "recheck" : "sampling"
    });

    // PRE-FLIGHT: negotiate the host ONCE, before any per-URL work, using a deep URL
    // from the largest pattern (patterns arrive ordered by total_urls DESC) and the
    // second-largest as a fallback when the first has no usable candidate.
    //
    // Doing it here rather than lazily inside the loop is what makes the cost bounded
    // and legible: at most three probes decide the host, and a REFUSED host is known
    // before a single pattern is touched.
    //
    // GUARDED, for the same reason resolveHostStrategy is: choosing a probe URL is
    // optional work. loadNegotiationProbeUrl is a query and resolveSampleTarget
    // parses a URL, and neither is a reason to abandon a session's measurement —
    // the run simply proceeds without a learned recipe, which is what it did
    // before this engine existed.
    try {
      for (const candidate of patternsResult.rows.slice(0, 2)) {
        const probe = await loadNegotiationProbeUrl(candidate.id);

        if (!probe) {
          continue;
        }

        const probeTarget = resolveSampleTarget(
          session.base_url,
          probe.path,
          probe.source_url
        );

        await strategyRun.forTarget(probeTarget, probeTarget);
        break;
      }
    } catch (error) {
      logger.warn(
        { session_id: data.session_id, error },
        "host pre-flight failed — sampling continues on the default request ladder"
      );
    }

    for (const pattern of patternsResult.rows) {
      // On a resumed run, patterns that already have sampled URLs completed on a
      // previous pass — skip their (expensive, network-bound) re-sampling. Never
      // applies to a scoped re-check, whose whole purpose is to overwrite rows that
      // already exist.
      if (
        !scopedPatternId &&
        data.resume &&
        (await patternAlreadySampled(pattern.id))
      ) {
        skippedPatternCount += 1;
        continue;
      }

      const totalUrls = Number(pattern.total_urls);
      const sampleLimit = Math.min(session.sample_size, totalUrls);
      const samplePool = await loadSamplePool(pattern.id, sampleLimit);

      // NEVER CALL persistPatternSamples WITH AN EMPTY RESULT SET. It DELETEs the
      // pattern's sampled_urls and then inserts what it was given, so an empty set
      // erases a real measurement from an earlier run and rewrites the row as
      // PENDING — "Not scored" — for a reason that has nothing to do with the site.
      // A pattern that was not measured on this pass instead keeps status NULL
      // (migration 002 dropped the NOT NULL and the 'PENDING' default), which
      // normalizeStatus renders as the same honest "Not scored", and a pattern that
      // already has data keeps the data it legitimately has.
      //
      // Two ways to arrive at "measured nothing", and BOTH have to return here:
      const firstSample = samplePool[0];

      // 1. NO STORED POOL. Extraction kept no candidate URLs for this pattern, so
      //    there is nothing to probe. No amount of retrying fixes it and neither
      //    does a re-check — the recheck endpoint correctly 400s on pool_total = 0
      //    and says "re-run the analysis". This branch used to fall through into
      //    persistPatternSamples([]) and take the footgun above.
      if (!firstSample) {
        emptyPoolPatternCount += 1;
        logger.warn(
          {
            session_id: data.session_id,
            pattern_id: pattern.id,
            template: pattern.template,
            total_urls: totalUrls,
            requested_sample_size: sampleLimit
          },
          "pattern has no stored sample URLs — leaving its score untouched rather than overwriting it with an empty measurement"
        );
        continue;
      }

      const patternStrategy = await strategyRun.forTarget(
        resolveSampleTarget(
          session.base_url,
          firstSample.path,
          firstSample.source_url
        )
      );

      // 2. THE CIRCUIT BREAKER. Every rung was refused for this host, so there is
      //    nothing left to learn from probing its URLs one at a time: skip the
      //    pattern outright, issuing ZERO requests.
      if (patternStrategy.skip) {
        refusedPatternCount += 1;
        logger.warn(
          {
            session_id: data.session_id,
            pattern_id: pattern.id,
            template: pattern.template,
            host: patternStrategy.host,
            edge_server: patternStrategy.edgeServer,
            last_status: patternStrategy.lastStatus
          },
          "pattern skipped — the host refused every request profile"
        );
        // ONE PER PATTERN — roughly 14 lines on a session like the one that started this
        // investigation, and it carries total_urls so the file says how much measurement
        // was actually forgone (4,020,427 URLs on that session's largest pattern).
        strategyRun.noteSkipped(patternStrategy, {
          pattern: pattern.template,
          url_count_affected: totalUrls
        });
        continue;
      }

      const results = await mapWithConcurrency(
        samplePool,
        session.concurrency,
        (sample, index) => {
          // PACE SAMPLING THROUGH THE SAME PER-HOST BUDGET AS VERIFICATION.
          //
          // 9ad4ddc6 dropped verification to 5 req/s per host after AWS WAF Bot
          // Control returned 405 + x-amzn-waf-action: captcha under sustained
          // load. It only touched verifyProbe.ts. THIS path had no pacing at all
          // — no beforeRequest hook, running at session.concurrency (default 10)
          // with zero throttling — so it reproduced the identical WAF trigger on
          // a different code path. Confirmed by data, not theory: session
          // 431cbba3, 8 of 9 affected patterns had sample_rows = 1 and
          // statuses = {405}. checkSampleUrl already re-probes a 405 HEAD with
          // GET, so a 405 surviving as the final status means GET was refused
          // too, which for a real page is essentially never legitimate.
          //
          // verificationRateLimit() rather than a new limiter: hostRateLimiter is
          // per-host and PROCESS-GLOBAL, and its own comment says triage and full
          // verification "provably share one budget per host". Sampling joining
          // that shared budget is the point — two limiters against one origin
          // would just be 2x the intended rate, which is the bug this fixes.
          //
          // Keyed on the RESOLVED target host, exactly as probeUrl does, because
          // resolveSampleTarget can send the probe to a different host than
          // base_url names (the www-equivalence rule). The host that receives the
          // traffic is the host whose budget must be charged.
          //
          // NOT passing skipRedirectFollow: that is a verification-specific
          // optimisation (verified_urls does not store the follow-up HEAD's
          // responseMs). Sampling still follows redirects fully — only the pacing
          // is new.
          const target = resolveSampleTarget(
            session.base_url,
            sample.path,
            sample.source_url
          );
          const host = rateLimitHostKey(target);

          return checkSampleUrl(
            session.base_url,
            sample.path,
            sample.source_url,
            session.user_agent,
            logger,
            {
              sessionId: data.session_id,
              patternId: pattern.id,
              template: pattern.template,
              sampleIndex: index
            },
            {
              beforeRequest: () => acquireHostSlot(host, verificationRateLimit()),
              // The learned rung goes FIRST, with the rung above it as the per-URL
              // safety net (ladderForRung). On a host that answers the browser
              // profile this is the whole saving: attempt #1 succeeds instead of
              // climbing from R0 on every single URL. Empty/absent ladder = today's
              // default pair, so an unknown host behaves exactly as before.
              profileLadder: patternStrategy.ladder.length
                ? patternStrategy.ladder
                : undefined
            }
          ).then((result) => {
            // Feeds the staleness heuristic: enough consecutive refusals on a
            // previously-OK host and the next resolve re-negotiates once.
            strategyRun.noteOutcome(host, isRealMeasurement(result));

            return result;
          });
        }
      );
      const score = await persistPatternSamples(
        pattern.id,
        results,
        pattern.source_file
      );

      sampledUrlCount += results.length;

      if (results.length < sampleLimit) {
        logger.warn(
          {
            session_id: data.session_id,
            pattern_id: pattern.id,
            template: pattern.template,
            requested_sample_size: sampleLimit,
            actual_sample_size: results.length
          },
          "pattern sample pool smaller than requested sample size"
        );
      }

      logger.info(
        {
          session_id: data.session_id,
          pattern_id: pattern.id,
          template: pattern.template,
          sample_count: results.length,
          confidence_pct: score.confidencePct,
          redirect_pct: score.redirectPct,
          status: score.status
        },
        "pattern sampling completed"
      );
    }

    if (!scopedPatternId) {
      await markSampledFilesDone(data.session_id);
      await markSessionComplete(data.session_id);
    }

    logger.info(
      {
        session_id: data.session_id,
        sitemap_file_id: data.sitemap_file_id,
        pattern_id: scopedPatternId,
        resume: Boolean(data.resume),
        pattern_count: patternsResult.rowCount,
        skipped_pattern_count: skippedPatternCount,
        // Patterns that issued ZERO requests because their host refused every
        // profile. On a fully-refused site this is every pattern, and the run costs
        // three probes instead of a full sample pass per pattern.
        refused_pattern_count: refusedPatternCount,
        // Patterns with no stored sample pool. Distinct from refused: nothing about
        // the SITE is implied, and a re-check cannot help them. If this equals
        // pattern_count the whole run was a no-op and extraction is the suspect.
        empty_pool_pattern_count: emptyPoolPatternCount,
        host_strategies: strategyRun.resolved().map((strategy) => ({
          host: strategy.host,
          verdict: strategy.verdict,
          rung: strategy.rung,
          edge_server: strategy.edgeServer
        })),
        sampled_url_count: sampledUrlCount
      },
      "sample patterns job completed"
    );
  } catch (error) {
    // Record the failure so the UI can offer a Resume that re-samples only the
    // patterns that never completed. (v1.36 Fix 2)
    //
    // NOT for a scoped re-check: marking a long-completed session FAILED because
    // one re-measured row hit a network error would offer a Resume that re-samples
    // nothing (every pattern already has rows) and would misreport the session.
    // The job still throws, so BullMQ retries and the failure is in the logs.
    if (!scopedPatternId) {
      await pool.query(
        "UPDATE sessions SET status = 'FAILED', last_failed_at = now() WHERE id = $1",
        [data.session_id]
      );
    }

    throw error;
  }
}
