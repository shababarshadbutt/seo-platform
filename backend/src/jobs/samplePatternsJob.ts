import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { checkSampleUrl, type SampleCheckResult } from "./sampleUrlCheck.js";
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
            error_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11)
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
          result.errorReason
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
  data: { session_id: string; sitemap_file_id?: string; resume?: boolean },
  logger: FastifyBaseLogger
) {
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
      sitemap_file_id: data.sitemap_file_id
    },
    "sample patterns job started"
  );

  await pool.query("UPDATE sessions SET status = 'SAMPLING' WHERE id = $1", [
    data.session_id
  ]);

  try {
    const patternsResult = await pool.query<PatternRow>(
      `
        SELECT id, template, total_urls, source_file
        FROM patterns
        WHERE session_id = $1
          AND source_role = 'current'
        ORDER BY total_urls DESC, template ASC
      `,
      [data.session_id]
    );
    let sampledUrlCount = 0;
    let skippedPatternCount = 0;

    for (const pattern of patternsResult.rows) {
      // On a resumed run, patterns that already have sampled URLs completed on a
      // previous pass — skip their (expensive, network-bound) re-sampling.
      if (data.resume && (await patternAlreadySampled(pattern.id))) {
        skippedPatternCount += 1;
        continue;
      }

      const totalUrls = Number(pattern.total_urls);
      const sampleLimit = Math.min(session.sample_size, totalUrls);
      const samplePool = await loadSamplePool(pattern.id, sampleLimit);
      const results = await mapWithConcurrency(
        samplePool,
        session.concurrency,
        (sample, index) =>
          checkSampleUrl(
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
            }
          )
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

    await markSampledFilesDone(data.session_id);
    await markSessionComplete(data.session_id);

    logger.info(
      {
        session_id: data.session_id,
        sitemap_file_id: data.sitemap_file_id,
        resume: Boolean(data.resume),
        pattern_count: patternsResult.rowCount,
        skipped_pattern_count: skippedPatternCount,
        sampled_url_count: sampledUrlCount
      },
      "sample patterns job completed"
    );
  } catch (error) {
    // Record the failure so the UI can offer a Resume that re-samples only the
    // patterns that never completed. (v1.36 Fix 2)
    await pool.query(
      "UPDATE sessions SET status = 'FAILED', last_failed_at = now() WHERE id = $1",
      [data.session_id]
    );
    throw error;
  }
}
