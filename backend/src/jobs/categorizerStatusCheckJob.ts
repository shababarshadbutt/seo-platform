import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import { probeUrl, verifyConcurrency } from "./verifyProbe.js";
import {
  enqueueCategorizerStatusCheckContinuation,
  type CategorizerStatusCheckJobData
} from "../queue/categorizerQueue.js";
import {
  markCategorizerJobComplete,
  markCategorizerJobRunning,
  startOrResumeCategorizerJob,
  updateCategorizerJobCheckpoint,
  updateCategorizerSessionStatus
} from "./categorizerJobState.js";

// Status-check phase: HTTP-probe EVERY ingested URL (not a sample) and record
// its status, so categorization (the next phase) can exclude 404s from every
// output file. The new scalable crawler this tool was built around — see the
// architecture notes this module replaces: verifyUrlsJob.ts enumerates its
// whole population into one in-memory Map, which this deliberately does not.
//
// STREAMING, KEYSET-PAGINATED POPULATION. Never holds more than one batch
// (config.categorizerCrawl.batchSize rows) in memory at a time, however many
// tens of millions of rows categorizer_urls holds for this session.
//
// RATE LIMITING IS SHARED, NOT SEPARATE. probeUrl draws from the SAME
// per-host budget verifyUrlsJob.ts uses (config.verification.*) via
// hostRateLimiter.ts — see the long note in config.ts's categorizerCrawl
// block for why a second, independent budget for the same host would be the
// exact bug hostRateLimiter.ts exists to prevent. Only concurrency (this
// process's socket count) is configured separately.
//
// RESUMABLE BY KEYSET CURSOR. checkpoint.last_id is the highest
// categorizer_urls.id processed so far; a crash resumes with
// "WHERE id > last_id", never a re-scan. Rows left 'checking' by a hard kill
// are reset to 'pending' before resuming — in-flight work since the last
// checkpoint is assumed lost, the same assumption any crash-safe batch
// processor has to make.
//
// NOT ONE LONG-LIVED BULLMQ JOB. A run can span days, which outlives any
// sane BullMQ lock. Each job attempt works for
// config.categorizerCrawl.chunkMinutes, checkpoints, and re-enqueues its own
// continuation under the SAME singleton job id (categorizerQueue.ts) rather
// than holding one job open — so a worker restart loses at most one chunk's
// progress, not the whole run.

type CategorizerSessionRow = {
  id: string;
  base_url: string;
  user_agent: string;
};

type StatusCheckCheckpoint = {
  last_id: number;
};

type PendingUrlRow = {
  id: string;
  url: string;
};

export async function processCategorizerStatusCheckJob(
  data: CategorizerStatusCheckJobData,
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

  const jobRow = await startOrResumeCategorizerJob(sessionId, "status-check");
  const checkpoint = jobRow.checkpoint as Partial<StatusCheckCheckpoint>;
  let lastId = checkpoint.last_id ?? 0;

  await updateCategorizerSessionStatus(sessionId, "CHECKING_STATUS");

  // In-flight work since the last checkpoint is lost on a hard kill —
  // reclaim those rows rather than leaving them stuck 'checking' forever.
  await pool.query(
    `UPDATE categorizer_urls SET check_state = 'pending'
     WHERE session_id = $1 AND check_state = 'checking'`,
    [sessionId]
  );

  const totalResult = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1",
    [sessionId]
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);

  const doneResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categorizer_urls
     WHERE session_id = $1 AND check_state = 'checked'`,
    [sessionId]
  );
  let doneCount = Number(doneResult.rows[0]?.count ?? 0);

  await markCategorizerJobRunning(jobRow.id, total);
  await job?.updateProgress({
    stage: "status-check",
    current: doneCount,
    total,
    message: `Checking ${total - doneCount} of ${total} URL(s)`
  });

  const batchSize = config.categorizerCrawl.batchSize;
  const concurrency = Math.max(
    1,
    Math.min(config.categorizerCrawl.maxConcurrency, verifyConcurrency(session.base_url))
  );
  const chunkDeadlineMs = Date.now() + config.categorizerCrawl.chunkMinutes * 60 * 1000;
  let sampleIndex = 0;

  for (;;) {
    if (Date.now() > chunkDeadlineMs) {
      await enqueueCategorizerStatusCheckContinuation({ session_id: sessionId });
      logger.info(
        { session_id: sessionId, last_id: lastId, done: doneCount, total },
        "categorizer status-check: chunk time box reached, continuation enqueued"
      );

      return { continued: true, done: doneCount, total };
    }

    const batchResult = await pool.query<PendingUrlRow>(
      `
        SELECT id::text AS id, url
        FROM categorizer_urls
        WHERE session_id = $1 AND check_state <> 'checked' AND id > $2
        ORDER BY id
        LIMIT $3
      `,
      [sessionId, lastId, batchSize]
    );

    if (batchResult.rows.length === 0) {
      break;
    }

    await pool.query(
      `UPDATE categorizer_urls SET check_state = 'checking'
       WHERE session_id = $1 AND id = ANY($2::bigint[])`,
      [sessionId, batchResult.rows.map((row) => row.id)]
    );

    const results = await runWithBoundedConcurrency(
      batchResult.rows,
      concurrency,
      async (row) => {
        const result = await probeUrl(
          session.base_url,
          row.url,
          session.user_agent,
          logger,
          {
            sessionId,
            // The categorizer has no pattern concept; these are log-context
            // fields only (see SampleLogContext in sampleUrlCheck.ts), never
            // a DB foreign key, so a fixed label is safe here.
            patternId: "categorizer",
            template: "categorizer",
            sampleIndex: sampleIndex++
          }
        );

        return { id: row.id, httpStatus: result.httpStatus };
      }
    );

    const values: string[] = [];
    const params: unknown[] = [sessionId];

    for (const result of results) {
      const base = params.length;

      params.push(result.id, result.httpStatus);
      values.push(`($${base + 1}::bigint, $${base + 2}::integer)`);
    }

    await pool.query(
      `
        UPDATE categorizer_urls AS u
        SET http_status = v.http_status, check_state = 'checked', checked_at = now()
        FROM (VALUES ${values.join(", ")}) AS v(id, http_status)
        WHERE u.session_id = $1 AND u.id = v.id
      `,
      params
    );

    lastId = Number(batchResult.rows[batchResult.rows.length - 1].id);
    doneCount += batchResult.rows.length;

    await updateCategorizerJobCheckpoint(jobRow.id, { last_id: lastId }, doneCount);
    await job?.updateProgress({
      stage: "status-check",
      current: doneCount,
      total,
      message: `Checked ${doneCount} of ${total} URL(s)`
    });
  }

  await markCategorizerJobComplete(jobRow.id);
  await updateCategorizerSessionStatus(sessionId, "STATUS_CHECKED");

  logger.info(
    { session_id: sessionId, total, done: doneCount },
    "categorizer status-check complete"
  );

  await job?.updateProgress({
    stage: "done",
    current: doneCount,
    total,
    message: `Checked ${doneCount} of ${total} URL(s)`
  });

  return { done: doneCount, total };
}
