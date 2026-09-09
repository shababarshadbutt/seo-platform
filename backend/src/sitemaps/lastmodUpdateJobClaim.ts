import { pool } from "../db/pool.js";
import { canonicalFingerprint } from "./patternStructureJobClaim.js";

// Claiming a lastmod update job — the session-scoped counterpart of
// claimPatternStructureJob. Same retry-after-timeout problem, same fix: this
// can run for minutes over a large session (it rewrites every file the scope
// selects, then publishes), so a client that gives up and retries must attach
// to the same job rather than re-rewrite and re-publish. Keyed by session_id,
// not pattern_id, since scope can be "every file" or "a manual selection" with
// no single pattern to hang off.

export const LASTMOD_UPDATE_ACTIVE_STATUSES = [
  "PENDING",
  "RUNNING",
  "PUBLISHING"
] as const;

// Same window pattern_structure_jobs uses: comfortably longer than the client
// timeout that causes the retry, short enough that a deliberate re-run later
// still works.
const RETRY_WINDOW_MINUTES = 15;

export type LastmodUpdateJobRow = {
  id: string;
  status: string;
  files_total: number;
  files_done: number;
  urls_rewritten: string;
  result: unknown;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
};

export function lastmodUpdateFingerprint(inputs: Record<string, unknown>): string {
  return canonicalFingerprint("LASTMOD_UPDATE", inputs);
}

async function activeJobForSession(sessionId: string) {
  const result = await pool.query<
    LastmodUpdateJobRow & { request_fingerprint: string }
  >(
    `
      SELECT id, status, files_total, files_done, urls_rewritten, result, error,
             started_at, completed_at, request_fingerprint
      FROM lastmod_update_jobs
      WHERE session_id = $1 AND status IN ('PENDING', 'RUNNING', 'PUBLISHING')
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

export async function recentlyCompletedLastmodUpdateJob(
  sessionId: string,
  fingerprint: string
) {
  const result = await pool.query<LastmodUpdateJobRow>(
    `
      SELECT id, status, files_total, files_done, urls_rewritten, result, error,
             started_at, completed_at
      FROM lastmod_update_jobs
      WHERE session_id = $1
        AND request_fingerprint = $2
        AND status = 'COMPLETE'
        AND completed_at > now() - ($3 || ' minutes')::interval
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [sessionId, fingerprint, String(RETRY_WINDOW_MINUTES)]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

export type LastmodUpdateClaimOutcome =
  | { outcome: "created"; jobId: string; filesTotal: number }
  | { outcome: "attached"; jobId: string; job: LastmodUpdateJobRow | null }
  | { outcome: "already_completed"; jobId: string; job: LastmodUpdateJobRow }
  | { outcome: "busy"; jobId: string };

function isActiveJobIndexViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };

  return (
    candidate.code === "23505" &&
    candidate.constraint === "lastmod_update_jobs_one_active_per_session"
  );
}

export async function claimLastmodUpdateJob(options: {
  sessionId: string;
  fingerprint: string;
  params: Record<string, unknown>;
  filesTotal: number;
}): Promise<LastmodUpdateClaimOutcome> {
  const active = await activeJobForSession(options.sessionId);

  if (active) {
    return active.request_fingerprint === options.fingerprint
      ? { outcome: "attached", jobId: active.id, job: active }
      : { outcome: "busy", jobId: active.id };
  }

  const completed = await recentlyCompletedLastmodUpdateJob(
    options.sessionId,
    options.fingerprint
  );

  if (completed) {
    return { outcome: "already_completed", jobId: completed.id, job: completed };
  }

  try {
    const inserted = await pool.query<{ id: string }>(
      `
        INSERT INTO lastmod_update_jobs
          (session_id, request_fingerprint, params, files_total, status)
        VALUES ($1, $2, $3, $4, 'PENDING')
        RETURNING id
      `,
      [
        options.sessionId,
        options.fingerprint,
        JSON.stringify(options.params),
        options.filesTotal
      ]
    );

    return {
      outcome: "created",
      jobId: inserted.rows[0].id,
      filesTotal: options.filesTotal
    };
  } catch (error) {
    if (!isActiveJobIndexViolation(error)) {
      throw error;
    }

    // Lost the race against a concurrent request — re-read and resolve the
    // same way the lookup above would have.
    const raced = await activeJobForSession(options.sessionId);

    if (!raced) {
      const justCompleted = await recentlyCompletedLastmodUpdateJob(
        options.sessionId,
        options.fingerprint
      );

      if (justCompleted) {
        return {
          outcome: "already_completed",
          jobId: justCompleted.id,
          job: justCompleted
        };
      }

      throw error;
    }

    return raced.request_fingerprint === options.fingerprint
      ? { outcome: "attached", jobId: raced.id, job: raced }
      : { outcome: "busy", jobId: raced.id };
  }
}

export function serialiseLastmodUpdateJob(job: LastmodUpdateJobRow) {
  return {
    job_id: job.id,
    status: job.status,
    files_total: job.files_total,
    files_done: job.files_done,
    urls_rewritten: Number(job.urls_rewritten),
    result: job.result,
    error: job.error,
    started_at: job.started_at,
    completed_at: job.completed_at
  };
}

export async function latestLastmodUpdateJob(sessionId: string) {
  const result = await pool.query<LastmodUpdateJobRow>(
    `
      SELECT id, status, files_total, files_done, urls_rewritten, result, error,
             started_at, completed_at
      FROM lastmod_update_jobs
      WHERE session_id = $1
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}
