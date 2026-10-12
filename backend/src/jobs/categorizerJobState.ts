// Durable phase/progress bookkeeping shared by all four Sitemap Categorizer
// phases (ingest, status-check, categorize, generate) — see migration 064.
//
// Resumability is a KEYSET CURSOR in `checkpoint`, not a re-scan: a crashed
// status-check or categorize run resumes with "WHERE id > checkpoint.last_id
// ORDER BY id", never by re-deriving which rows are left. This module only
// stores/retrieves that cursor; each phase decides its own checkpoint shape.

import { pool } from "../db/pool.js";

export type CategorizerPhase = "ingest" | "status-check" | "categorize" | "generate";
export type CategorizerJobStatus =
  | "PENDING"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETE"
  | "FAILED";

export type CategorizerJobRow = {
  id: string;
  session_id: string;
  phase: CategorizerPhase;
  status: CategorizerJobStatus;
  checkpoint: Record<string, unknown>;
  items_total: number;
  items_done: number;
  error: string | null;
};

const JOB_COLUMNS =
  "id, session_id, phase, status, checkpoint, items_total, items_done, error";

// The most recent job row for (session, phase), or null if the phase has
// never been started. Used to gate a later phase on an earlier one's
// completion (e.g. categorize must not start until status-check is COMPLETE
// — see categorizerCategorizeJob.ts) without caring about its checkpoint.
export async function latestCategorizerJob(
  sessionId: string,
  phase: CategorizerPhase
): Promise<CategorizerJobRow | null> {
  const result = await pool.query<CategorizerJobRow>(
    `SELECT ${JOB_COLUMNS}
     FROM categorizer_jobs
     WHERE session_id = $1 AND phase = $2
     ORDER BY started_at DESC
     LIMIT 1`,
    [sessionId, phase]
  );

  return result.rows[0] ?? null;
}

// The row a phase processor should work against: its ACTIVE (PENDING/
// RUNNING) row if one exists, so a crashed-and-resumed run continues from its
// checkpoint — or a freshly created row otherwise, so an explicit re-run
// after COMPLETE/FAILED starts the phase over rather than replaying a stale
// checkpoint. Relies on the BullMQ singleton job id (one job per
// session+phase, see categorizerQueue.ts) to keep two callers from racing
// this past the table's one-active-row-per-phase unique index.
export async function startOrResumeCategorizerJob(
  sessionId: string,
  phase: CategorizerPhase
): Promise<CategorizerJobRow> {
  const active = await pool.query<CategorizerJobRow>(
    `SELECT ${JOB_COLUMNS}
     FROM categorizer_jobs
     WHERE session_id = $1 AND phase = $2 AND status IN ('PENDING', 'RUNNING')
     LIMIT 1`,
    [sessionId, phase]
  );

  if (active.rows[0]) {
    return active.rows[0];
  }

  const created = await pool.query<CategorizerJobRow>(
    `INSERT INTO categorizer_jobs (session_id, phase, status)
     VALUES ($1, $2, 'PENDING')
     RETURNING ${JOB_COLUMNS}`,
    [sessionId, phase]
  );

  return created.rows[0];
}

export async function markCategorizerJobRunning(
  jobId: string,
  itemsTotal?: number
) {
  await pool.query(
    `UPDATE categorizer_jobs
     SET status = 'RUNNING', items_total = COALESCE($2, items_total), updated_at = now()
     WHERE id = $1`,
    [jobId, itemsTotal ?? null]
  );
}

export async function updateCategorizerJobCheckpoint(
  jobId: string,
  checkpoint: Record<string, unknown>,
  itemsDone: number
) {
  await pool.query(
    `UPDATE categorizer_jobs
     SET checkpoint = $2::jsonb, items_done = $3, updated_at = now()
     WHERE id = $1`,
    [jobId, JSON.stringify(checkpoint), itemsDone]
  );
}

export async function markCategorizerJobComplete(jobId: string) {
  await pool.query(
    `UPDATE categorizer_jobs
     SET status = 'COMPLETE', completed_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
}

export async function markCategorizerJobFailed(jobId: string, message: string) {
  await pool.query(
    `UPDATE categorizer_jobs
     SET status = 'FAILED', error = $2, updated_at = now()
     WHERE id = $1`,
    [jobId, message]
  );
}

// Used by worker.ts's queue-level "failed" handler, which only has a BullMQ
// job (session_id + job name, mapped to a phase via JOB_NAME_TO_PHASE) — not
// the categorizer_jobs.id markCategorizerJobFailed needs. Scoped to the
// active (PENDING/RUNNING) row so a failure reported for an already-resumed
// or already-retried phase can't clobber a newer attempt's row.
export async function markActiveCategorizerJobFailed(
  sessionId: string,
  phase: CategorizerPhase,
  message: string
) {
  await pool.query(
    `UPDATE categorizer_jobs
     SET status = 'FAILED', error = $3, updated_at = now()
     WHERE session_id = $1 AND phase = $2 AND status IN ('PENDING', 'RUNNING')`,
    [sessionId, phase, message]
  );
}

export async function updateCategorizerSessionStatus(
  sessionId: string,
  status: string
) {
  await pool.query(
    "UPDATE categorizer_sessions SET status = $2, updated_at = now() WHERE id = $1",
    [sessionId, status]
  );
}
