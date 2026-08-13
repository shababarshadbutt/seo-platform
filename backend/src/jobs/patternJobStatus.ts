import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import type { PatternRewriteWarning } from "../sitemaps/patternFileRewrites.js";

// Status bookkeeping for the three pattern structure jobs. Kept beside
// jobs/maintenanceJobs.ts (which owns the same table for the session-level
// kinds) rather than inside it, because these also write pattern_id, payload,
// result, files_skipped and warnings — columns the older kinds never touch.

// How often the progress COUNTERS are persisted. Cheap, and the UI polls every
// 2s, so this stays fine-grained.
const PROGRESS_FLUSH_EVERY = 10;

// How often a progress LOG LINE is emitted. Much coarser than the DB flush: a
// 4,000-file run would otherwise write 400 log lines for information nobody
// reads at that resolution.
const LOG_MIN_INTERVAL_MS = 2000;
const LOG_MIN_FRACTION = 0.05;

export type PatternJobResult = Record<string, unknown>;

// Pure so it can be tested without a database. A 4,000-file run calls progress
// 400 times (every PROGRESS_FLUSH_EVERY files); without this it would emit 400
// log lines nobody reads at that resolution.
//
// First and last are ALWAYS emitted — a run has to be visible in the log even
// if it is short. Everything in between must clear BOTH gates.
export function shouldLogProgress(state: {
  filesDone: number;
  filesTotal: number;
  lastLoggedAt: number;
  lastLoggedFiles: number;
  now: number;
}): boolean {
  if (state.lastLoggedAt === 0) {
    return true;
  }

  if (state.filesDone >= state.filesTotal) {
    return true;
  }

  const steppedEnough =
    state.filesDone - state.lastLoggedFiles >=
    Math.ceil(state.filesTotal * LOG_MIN_FRACTION);
  const waitedEnough = state.now - state.lastLoggedAt >= LOG_MIN_INTERVAL_MS;

  return steppedEnough && waitedEnough;
}

export async function markPatternJobRunning(
  jobRowId: string,
  filesTotal: number
) {
  await pool.query(
    `
      UPDATE maintenance_jobs
      SET status = 'RUNNING', files_total = $2, files_done = 0, items_changed = 0,
          files_skipped = 0, warnings = '[]'::jsonb, error = NULL
      WHERE id = $1
    `,
    [jobRowId, filesTotal]
  );
}

export async function markPatternJobComplete(
  jobRowId: string,
  outcome: {
    filesDone: number;
    itemsChanged: number;
    filesSkipped: number;
    warnings: PatternRewriteWarning[];
    result: PatternJobResult;
  }
) {
  await pool.query(
    `
      UPDATE maintenance_jobs
      SET status = 'COMPLETE', files_done = $2, items_changed = $3,
          files_skipped = $4, warnings = $5::jsonb, result = $6::jsonb,
          completed_at = now()
      WHERE id = $1
    `,
    [
      jobRowId,
      outcome.filesDone,
      outcome.itemsChanged,
      outcome.filesSkipped,
      JSON.stringify(outcome.warnings),
      JSON.stringify(outcome.result)
    ]
  );
}

export async function markPatternJobFailed(jobRowId: string, message: string) {
  await pool.query(
    `
      UPDATE maintenance_jobs
      SET status = 'FAILED', error = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, message]
  );
}

// Progress writer for PatternRewriteContext.progress.
//
// It runs on the shared `pool`, NEVER on the job's transaction client. The
// whole point is that the status endpoint can read "340 of 491" while that
// transaction is still open, and that the number survives a ROLLBACK so a
// failed job still shows where it stopped. Handing this the transaction client
// would silently defer every update to COMMIT.
export function patternJobProgress(jobRowId: string, logger: FastifyBaseLogger) {
  let lastLoggedAt = 0;
  let lastLoggedFiles = 0;

  return async (filesDone: number, filesTotal: number, itemsChanged: number) => {
    const isFinal = filesDone >= filesTotal;

    if (filesDone % PROGRESS_FLUSH_EVERY === 0 || isFinal) {
      await pool.query(
        "UPDATE maintenance_jobs SET files_done = $2, items_changed = $3 WHERE id = $1",
        [jobRowId, filesDone, itemsChanged]
      );
    }

    const now = Date.now();

    if (
      !shouldLogProgress({
        filesDone,
        filesTotal,
        lastLoggedAt,
        lastLoggedFiles,
        now
      })
    ) {
      return;
    }

    lastLoggedAt = now;
    lastLoggedFiles = filesDone;
    logger.info(
      {
        job_row_id: jobRowId,
        files_done: filesDone,
        files_total: filesTotal,
        urls_rewritten: itemsChanged
      },
      "pattern job progress"
    );
  };
}

// The message the UI shows for a failed job. Raw Postgres text ("duplicate key
// value violates unique constraint ...") is shown verbatim in the modal, so a
// raced template collision gets translated back into the sentence the
// synchronous route used to return as a 400.
export function patternJobFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // migrations/008_comparison_partial_urls.sql:39 —
  // patterns_unique_template_per_session_role.
  if (
    message.includes("duplicate key value") &&
    message.includes("patterns_unique_template_per_session")
  ) {
    return "Another pattern in this session already uses that template.";
  }

  return message;
}
