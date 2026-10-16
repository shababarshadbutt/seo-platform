import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { writeBatchWithFaultIsolation } from "../sitemaps/batchWriteFaultIsolation.js";
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

// Status-check phase, "full" mode: HTTP-probe EVERY ingested URL (not a
// sample) and record its status. This is the opt-in "advanced" path — the
// default is categorizerStatusSampleJob.ts's per-category sampled check,
// which is viable at tens-of-millions-of-URLs scale where a full sweep is
// not. Runs AFTER categorize now (not before): categorization only needs
// path shape, not status, so it moved ahead of this phase — see
// categorizerCategorizeJob.ts.
//
// The new scalable crawler this tool was built around — see the architecture
// notes this module replaces: verifyUrlsJob.ts enumerates its whole
// population into one in-memory Map, which this deliberately does not.
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

type StatusResult = {
  id: string;
  url: string;
  httpStatus: number | null;
};

async function markCheckingBatch(sessionId: string, rows: PendingUrlRow[]): Promise<void> {
  await pool.query(
    `UPDATE categorizer_urls SET check_state = 'checking'
     WHERE session_id = $1 AND id = ANY($2::bigint[])`,
    [sessionId, rows.map((row) => row.id)]
  );
}

async function writeStatusBatch(sessionId: string, rows: StatusResult[]): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [sessionId];

  for (const row of rows) {
    const base = params.length;

    params.push(row.id, row.httpStatus);
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
}

// Matches by (session_id, url) — NOT id — so recovering a row that failed its
// own ::bigint cast doesn't immediately hit that same cast failure again.
async function markStatusRowFailed(
  sessionId: string,
  url: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  await pool.query(
    `UPDATE categorizer_urls SET check_state = 'failed', error = $3
     WHERE session_id = $1 AND url = $2`,
    [sessionId, url, message]
  );
}

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

  const jobRow = await startOrResumeCategorizerJob(sessionId, "status-check", "full");
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
        WHERE session_id = $1 AND check_state NOT IN ('checked', 'failed') AND id > $2
        ORDER BY id
        LIMIT $3
      `,
      [sessionId, lastId, batchSize]
    );

    if (batchResult.rows.length === 0) {
      break;
    }

    // A row whose own id can't even be written as 'checking' (the same
    // cast-failure class this whole mechanism exists for) is isolated here,
    // before it ever reaches an HTTP probe — no point probing a URL this
    // batch can't record a result for.
    const checkingFailedUrls = new Set<string>();

    await writeBatchWithFaultIsolation(
      batchResult.rows,
      (rows) => markCheckingBatch(sessionId, rows),
      async (row, error) => {
        checkingFailedUrls.add(row.url);
        logger.warn(
          {
            session_id: sessionId,
            url: row.url,
            error: error instanceof Error ? error.message : String(error)
          },
          "categorizer status-check: row failed to mark 'checking', skipping probe and marking failed"
        );
        await markStatusRowFailed(sessionId, row.url, error);
      }
    );

    const eligibleRows = batchResult.rows.filter((row) => !checkingFailedUrls.has(row.url));

    const results = await runWithBoundedConcurrency(
      eligibleRows,
      concurrency,
      async (row): Promise<StatusResult> => {
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

        return { id: row.id, url: row.url, httpStatus: result.httpStatus };
      }
    );

    await writeBatchWithFaultIsolation(
      results,
      (rows) => writeStatusBatch(sessionId, rows),
      async (row, error) => {
        logger.warn(
          {
            session_id: sessionId,
            url: row.url,
            error: error instanceof Error ? error.message : String(error)
          },
          "categorizer status-check: row failed to write its result, marking failed and continuing"
        );
        await markStatusRowFailed(sessionId, row.url, error);
      }
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

  // Recomputed from the table rather than accumulated in-memory — same
  // reasoning as categorizerCategorizeJob.ts: a chunked run can span several
  // job attempts, and an in-memory counter would reset on each continuation.
  const failedResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND check_state = 'failed'`,
    [sessionId]
  );
  const failedCount = Number(failedResult.rows[0]?.count ?? 0);

  await markCategorizerJobComplete(jobRow.id, failedCount);
  await updateCategorizerSessionStatus(sessionId, "STATUS_CHECKED");

  logger.info(
    { session_id: sessionId, total, done: doneCount, failed: failedCount },
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
