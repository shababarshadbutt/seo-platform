import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { normalizationVariants } from "../sitemaps/digitNormalization.js";
import {
  isHealthy,
  summarizeEvidence,
  type ProbedUrl,
  type ProbedVariant
} from "../sitemaps/normalizationEvidence.js";
import type { NormalizationProbeJobData } from "../queue/triageQueue.js";
import {
  probeEnvironmentLogFields,
  resolveProbeEnvironment
} from "./probeEnvironment.js";
import { probeUrl } from "./verifyProbe.js";

// Does the normalized spelling of a padded URL actually exist?
//
// The tool cannot answer that by reasoning about the string. "page-3-00" could
// normalize to "page-3-0" or to "page-3", and only the site knows which it serves.
// So this asks: it probes the URL as written and each normalized reading of it,
// and records what answered.
//
// WHAT IT DOES NOT DO: change anything. It writes evidence into
// normalization_probe_runs, which the Fix modal reads to RANK the redirect
// candidates an operator ticks. Nothing here rewrites a sitemap, and a run that
// finds a clear answer still leaves the applying to a person.

// BOUNDED, and this is the number that matters.
//
// Every sampled URL costs one probe for the original plus one per distinct
// reading — two or three requests. Against the 5 requests/second a WAF typically
// allows, 20 URLs is ~10 seconds of traffic; the whole pattern would be hours. The
// rule is inferred from this sample and then widened, exactly as every other
// redirect rule in this codebase is.
const PROBE_SAMPLE = 20;

// How many rows to read before filtering for padding. The pool is already capped
// per pattern, but a pattern whose URLs are mostly unpadded should not force a
// scan of all of them to find twenty that qualify.
const CANDIDATE_SCAN_LIMIT = 2000;

type SessionRow = {
  id: string;
  base_url: string;
  user_agent: string;
  staging_base_url: string | null;
};

async function markFailed(runId: string, message: string) {
  await pool.query(
    `UPDATE normalization_probe_runs
     SET status = 'FAILED', error = $2, completed_at = now()
     WHERE id = $1`,
    [runId, message]
  );
}

export async function processNormalizationProbeJob(
  data: NormalizationProbeJobData,
  logger: FastifyBaseLogger
): Promise<void> {
  const { session_id: sessionId, pattern_id: patternId, run_id: runId } = data;

  try {
    const sessionResult = await pool.query<SessionRow>(
      `SELECT id, base_url, user_agent, staging_base_url
       FROM sessions WHERE id = $1`,
      [sessionId]
    );
    const session = sessionResult.rows[0];

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const patternResult = await pool.query<{ template: string }>(
      "SELECT template FROM patterns WHERE id = $1 AND session_id = $2",
      [patternId, sessionId]
    );
    const pattern = patternResult.rows[0];

    if (!pattern) {
      throw new Error(`Pattern not found: ${patternId}`);
    }

    // PINNED FOR THE RUN, like every other probing job. Throws when 2.0 is on with
    // no derivable staging origin rather than quietly measuring production — and
    // that matters more here than anywhere else, because the normalized URLs are
    // expected to exist ONLY on the new site. A run that silently asked production
    // would report every variant dead and read as "the normalization is wrong".
    const env = await resolveProbeEnvironment(session);

    await pool.query(
      `UPDATE normalization_probe_runs
       SET status = 'RUNNING', checked_on_staging = $2
       WHERE id = $1`,
      [runId, env.isStaging]
    );

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        run_id: runId,
        ...probeEnvironmentLogFields(env)
      },
      "normalization probe: environment resolved"
    );

    const poolResult = await pool.query<{ source_url: string }>(
      `SELECT source_url
       FROM pattern_urls
       WHERE session_id = $1 AND pattern_id = $2
       LIMIT ${CANDIDATE_SCAN_LIMIT}`,
      [sessionId, patternId]
    );

    // Only URLs that carry a zero-padded token are worth a request. Everything
    // else generates no variant, so probing it would spend the client's rate
    // budget to learn nothing.
    const candidates = poolResult.rows
      .map((row) => row.source_url)
      .filter((sourceUrl) => normalizationVariants(sourceUrl).length > 0);
    const sample = candidates.slice(0, PROBE_SAMPLE);

    const probed: ProbedUrl[] = [];
    let requests = 0;

    for (const [index, sourceUrl] of sample.entries()) {
      const context = {
        sessionId,
        patternId,
        template: pattern.template,
        sampleIndex: index
      };
      // detectSoft404 is ON here and off nearly everywhere else. This job asks
      // "does this URL I invented exist?", and a site that answers every path with
      // a styled 200 not-found page would otherwise mark every variant live — and
      // could get a whole pattern rewritten onto URLs that do not exist.
      const options = {
        stagingOrigin: env.stagingOrigin,
        detectSoft404: true
      };

      const originalResult = await probeUrl(
        session.base_url,
        sourceUrl,
        session.user_agent,
        logger,
        context,
        options
      );

      requests += 1;

      const variants: ProbedVariant[] = [];

      for (const variant of normalizationVariants(sourceUrl)) {
        const variantResult = await probeUrl(
          session.base_url,
          variant.path,
          session.user_agent,
          logger,
          context,
          options
        );

        requests += 1;
        variants.push({
          kind: variant.kind,
          url: variant.path,
          status: variantResult.httpStatus,
          healthy: isHealthy(variantResult.httpStatus, variantResult.isSoft404)
        });
      }

      probed.push({
        source: sourceUrl,
        original: {
          status: originalResult.httpStatus,
          healthy: isHealthy(
            originalResult.httpStatus,
            originalResult.isSoft404
          )
        },
        variants
      });
    }

    const summary = summarizeEvidence(probed);

    await pool.query(
      `UPDATE normalization_probe_runs
       SET status = 'COMPLETE',
           candidates_total = $2,
           sampled_total = $3,
           requests_total = $4,
           result = $5::jsonb,
           completed_at = now()
       WHERE id = $1`,
      [
        runId,
        candidates.length,
        probed.length,
        requests,
        JSON.stringify({
          urls: probed,
          totals: summary.totals,
          by_kind: summary.byKind,
          pairs: summary.pairs,
          recommended: summary.recommended
        })
      ]
    );

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        run_id: runId,
        candidates: candidates.length,
        sampled: probed.length,
        requests,
        ...summary.totals,
        recommended: summary.recommended
      },
      "normalization probe: complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { session_id: sessionId, pattern_id: patternId, run_id: runId, err: message },
      "normalization probe job failed"
    );
    await markFailed(runId, message);
  }
}
