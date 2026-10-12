import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import { calculatePatternScore } from "./patternScore.js";
import type { SampleCheckResult } from "./sampleUrlCheck.js";
import { probeUrl, verifyConcurrency } from "./verifyProbe.js";
import {
  enqueueCategorizerStatusSampleContinuation,
  type CategorizerStatusSampleJobData
} from "../queue/categorizerQueue.js";
import {
  markCategorizerJobComplete,
  markCategorizerJobRunning,
  startOrResumeCategorizerJob,
  updateCategorizerJobCheckpoint,
  updateCategorizerSessionStatus
} from "./categorizerJobState.js";

// Status-check phase, "sampled" mode (the default — see
// categorizerStatusCheckJob.ts for the full, opt-in alternative). Runs AFTER
// categorize: instead of HTTP-probing every URL (not viable past the shared
// WAF-safe 5 req/s ceiling at tens-of-millions-of-URLs scale), it probes a
// small random sample PER CATEGORY and scores that category's confidence —
// the same sample-score-act shape patterns.ts/patternScore.ts already use.
//
// SCORING REUSES calculatePatternScore VERBATIM (patternScore.ts), not a
// categorizer-specific reimplementation: probeUrl returns the exact same
// SampleCheckResult shape the pattern sampler scores, so there is nothing
// categorizer-specific to account for — a blocked result must not count as a
// failure here either, for the same reason it mustn't there.
//
// WHAT A SAMPLE RESULT DOES TO A URL/CATEGORY:
//   - A sampled URL confirmed 404 is flipped straight to
//     category_state='excluded' — categorizerGenerateJob.ts already only
//     reads category_state='categorized', so this alone drops it from every
//     output file with no change to that job.
//   - Every other sampled URL just gets its real check_state='checked' +
//     http_status recorded.
//   - The REST of the category (not sampled) is marked check_state='skipped'
//     — an enum value that has existed since migration 063 but nothing wrote
//     until now. It means "trusted via this category's sample, never
//     individually checked" — distinct from both a checked-good row and a
//     checked-404 row, so a UI reading check_state can't mistake "we didn't
//     look" for either "fine" or "dead".
//   - If the category's sample scores BAD (below patternStatusForConfidence's
//     50% floor), the WHOLE category — sampled and unsampled rows alike — is
//     flipped to category_state='excluded', dropping it from output
//     entirely, same mechanism as a single excluded URL.
//
// RESUMABLE BY categorizer_categories ROW, not a keyset cursor: a category
// that already has a row there was already scored (same
// skip-already-sampled-on-resume precedent as samplePatternsJob.ts's
// patternAlreadySampled) and is excluded from the next batch of categories to
// process. Categories are few relative to URLs (tens, not millions), so
// re-querying "which categories still need scoring" each chunk is cheap — no
// keyset cursor needed the way the per-URL phases require one.

type CategorizerSessionRow = {
  id: string;
  base_url: string;
  user_agent: string;
};

type SampleRow = {
  id: string;
  url: string;
};

export async function processCategorizerStatusSampleJob(
  data: CategorizerStatusSampleJobData,
  logger: FastifyBaseLogger,
  job?: Job
) {
  const { session_id: sessionId } = data;

  const sessionResult = await pool.query<CategorizerSessionRow>(
    "SELECT id, base_url, user_agent FROM categorizer_sessions WHERE id = $1",
    [sessionId]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new Error(`Categorizer session not found: ${sessionId}`);
  }

  const jobRow = await startOrResumeCategorizerJob(sessionId, "status-check", "sampled");

  await updateCategorizerSessionStatus(sessionId, "CHECKING_STATUS");

  const totalResult = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT category)::text AS count
     FROM categorizer_urls
     WHERE session_id = $1 AND category_state = 'categorized'`,
    [sessionId]
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);

  await markCategorizerJobRunning(jobRow.id, total);

  const sampleSize = config.categorizerCrawl.sampleSizePerCategory;
  const concurrency = Math.max(
    1,
    Math.min(config.categorizerCrawl.maxConcurrency, verifyConcurrency(session.base_url))
  );
  const chunkDeadlineMs = Date.now() + config.categorizerCrawl.chunkMinutes * 60 * 1000;
  let doneCount = jobRow.items_done;
  let sampleIndex = 0;

  for (;;) {
    if (Date.now() > chunkDeadlineMs) {
      await enqueueCategorizerStatusSampleContinuation({ session_id: sessionId });
      logger.info(
        { session_id: sessionId, done: doneCount, total },
        "categorizer status-sample: chunk time box reached, continuation enqueued"
      );

      return { continued: true, done: doneCount, total };
    }

    // Remaining categories = categorized, but not yet scored. Re-derived
    // every chunk rather than keyset-paginated, since a category once scored
    // drops out of this query on its own (no cursor to maintain).
    const remaining = await pool.query<{ category: string }>(
      `
        SELECT DISTINCT u.category
        FROM categorizer_urls u
        WHERE u.session_id = $1 AND u.category_state = 'categorized'
          AND NOT EXISTS (
            SELECT 1 FROM categorizer_categories c
            WHERE c.session_id = u.session_id AND c.category = u.category
          )
        ORDER BY u.category
        LIMIT 1
      `,
      [sessionId]
    );

    const category = remaining.rows[0]?.category;

    if (!category) {
      break;
    }

    const sample = await pool.query<SampleRow>(
      `
        SELECT id::text AS id, url
        FROM categorizer_urls
        WHERE session_id = $1 AND category = $2 AND category_state = 'categorized'
        ORDER BY random()
        LIMIT $3
      `,
      [sessionId, category, sampleSize]
    );

    if (sample.rows.length === 0) {
      // Nothing to sample (a race with another writer, or a category that
      // somehow has zero categorized rows left) — never persist a score off
      // an empty sample, same guard samplePatternsJob.ts's
      // persistPatternSamples needs. Move on; this category is picked up
      // again if it genuinely gains rows later.
      doneCount += 1;
      continue;
    }

    const results = await runWithBoundedConcurrency(
      sample.rows,
      concurrency,
      async (row): Promise<SampleCheckResult & { id: string }> => {
        const result = await probeUrl(
          session.base_url,
          row.url,
          session.user_agent,
          logger,
          {
            sessionId,
            patternId: "categorizer",
            template: "categorizer-sample",
            sampleIndex: sampleIndex++
          }
        );

        return { ...result, id: row.id };
      }
    );

    const score = calculatePatternScore(results);
    const deadCount = results.filter((result) => result.httpStatus === 404).length;
    const blockedCount = results.filter(
      (result) => result.httpStatusCategory === "blocked"
    ).length;

    const values: string[] = [];
    const params: unknown[] = [sessionId];

    for (const result of results) {
      const base = params.length;
      const categoryState = result.httpStatus === 404 ? "excluded" : "categorized";

      params.push(result.id, result.httpStatus, categoryState);
      values.push(`($${base + 1}::bigint, $${base + 2}::integer, $${base + 3})`);
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `
          UPDATE categorizer_urls AS u
          SET http_status = v.http_status, check_state = 'checked', checked_at = now(),
              category_state = v.category_state
          FROM (VALUES ${values.join(", ")}) AS v(id, http_status, category_state)
          WHERE u.session_id = $1 AND u.id = v.id
        `,
        params
      );

      // The rest of the category: trusted via this sample, never
      // individually probed.
      await client.query(
        `
          UPDATE categorizer_urls
          SET check_state = 'skipped'
          WHERE session_id = $1 AND category = $2 AND category_state = 'categorized'
            AND id <> ALL($3::bigint[])
        `,
        [sessionId, category, sample.rows.map((row) => row.id)]
      );

      await client.query(
        `
          INSERT INTO categorizer_categories
            (session_id, category, status, confidence_pct, sample_size, checked_count, dead_count, blocked_count, sampled_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
          ON CONFLICT (session_id, category) DO UPDATE SET
            status = EXCLUDED.status,
            confidence_pct = EXCLUDED.confidence_pct,
            sample_size = EXCLUDED.sample_size,
            checked_count = EXCLUDED.checked_count,
            dead_count = EXCLUDED.dead_count,
            blocked_count = EXCLUDED.blocked_count,
            sampled_at = EXCLUDED.sampled_at
        `,
        [
          sessionId,
          category,
          score.status,
          score.confidencePct,
          sample.rows.length,
          results.length,
          deadCount,
          blockedCount
        ]
      );

      if (score.status === "BAD") {
        // A low-confidence category is dropped whole, not URL-by-URL — the
        // sample wasn't large enough to tell which specific unsampled URLs
        // are the dead ones, only that the category as a whole looks dead.
        await client.query(
          `
            UPDATE categorizer_urls
            SET category_state = 'excluded'
            WHERE session_id = $1 AND category = $2 AND category_state <> 'excluded'
          `,
          [sessionId, category]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    doneCount += 1;

    await updateCategorizerJobCheckpoint(jobRow.id, {}, doneCount);
    await job?.updateProgress({
      stage: "status-sample",
      current: doneCount,
      total,
      message: `Sampled ${doneCount} of ${total} categor${doneCount === 1 ? "y" : "ies"} (${category}: ${score.status}, ${score.confidencePct}% confidence)`
    });
  }

  await markCategorizerJobComplete(jobRow.id);
  await updateCategorizerSessionStatus(sessionId, "STATUS_CHECKED");

  logger.info(
    { session_id: sessionId, total, done: doneCount },
    "categorizer status-sample complete"
  );

  return { done: doneCount, total };
}
