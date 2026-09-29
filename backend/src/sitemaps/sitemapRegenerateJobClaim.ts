import { pool } from "../db/pool.js";
import { canonicalFingerprint } from "./patternStructureJobClaim.js";

// Claiming a sitemap regenerate job — the session-scoped counterpart of
// claimLastmodUpdateJob. Same retry-after-timeout problem, same fix: this can
// run for minutes over a large CSV (it writes every chunk file, then
// publishes), so a client that gives up and retries must attach to the same
// job rather than regenerate and republish. Keyed by session_id, since the
// job always operates on the whole site's URL set for that session.

export const SITEMAP_REGENERATE_ACTIVE_STATUSES = [
  "PENDING",
  "RUNNING",
  "PUBLISHING"
] as const;

// Same window lastmod_update_jobs uses: comfortably longer than the client
// timeout that causes the retry, short enough that a deliberate re-run later
// still works.
const RETRY_WINDOW_MINUTES = 15;

export type SitemapRegenerateJobRow = {
  id: string;
  status: string;
  urls_total: number;
  urls_written: string;
  files_total: number;
  files_done: number;
  result: unknown;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
};

export function sitemapRegenerateFingerprint(
  inputs: Record<string, unknown>
): string {
  return canonicalFingerprint("SITEMAP_REGENERATE", inputs);
}

async function activeJobForSession(sessionId: string) {
  const result = await pool.query<
    SitemapRegenerateJobRow & { request_fingerprint: string }
  >(
    `
      SELECT id, status, urls_total, urls_written, files_total, files_done,
             result, error, started_at, completed_at, request_fingerprint
      FROM sitemap_regenerate_jobs
      WHERE session_id = $1 AND status IN ('PENDING', 'RUNNING', 'PUBLISHING')
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

export async function recentlyCompletedSitemapRegenerateJob(
  sessionId: string,
  fingerprint: string
) {
  const result = await pool.query<SitemapRegenerateJobRow>(
    `
      SELECT id, status, urls_total, urls_written, files_total, files_done,
             result, error, started_at, completed_at
      FROM sitemap_regenerate_jobs
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

export type SitemapRegenerateClaimOutcome =
  | { outcome: "created"; jobId: string; urlsTotal: number; filesTotal: number }
  | { outcome: "attached"; jobId: string; job: SitemapRegenerateJobRow | null }
  | { outcome: "already_completed"; jobId: string; job: SitemapRegenerateJobRow }
  | { outcome: "busy"; jobId: string };

function isActiveJobIndexViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };

  return (
    candidate.code === "23505" &&
    candidate.constraint === "sitemap_regenerate_jobs_one_active_per_session"
  );
}

export async function claimSitemapRegenerateJob(options: {
  sessionId: string;
  fingerprint: string;
  params: Record<string, unknown>;
  urlsTotal: number;
  filesTotal: number;
}): Promise<SitemapRegenerateClaimOutcome> {
  const active = await activeJobForSession(options.sessionId);

  if (active) {
    return active.request_fingerprint === options.fingerprint
      ? { outcome: "attached", jobId: active.id, job: active }
      : { outcome: "busy", jobId: active.id };
  }

  const completed = await recentlyCompletedSitemapRegenerateJob(
    options.sessionId,
    options.fingerprint
  );

  if (completed) {
    return { outcome: "already_completed", jobId: completed.id, job: completed };
  }

  try {
    const inserted = await pool.query<{ id: string }>(
      `
        INSERT INTO sitemap_regenerate_jobs
          (session_id, request_fingerprint, params, urls_total, files_total, status)
        VALUES ($1, $2, $3, $4, $5, 'PENDING')
        RETURNING id
      `,
      [
        options.sessionId,
        options.fingerprint,
        JSON.stringify(options.params),
        options.urlsTotal,
        options.filesTotal
      ]
    );

    return {
      outcome: "created",
      jobId: inserted.rows[0].id,
      urlsTotal: options.urlsTotal,
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
      const justCompleted = await recentlyCompletedSitemapRegenerateJob(
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

export function serialiseSitemapRegenerateJob(job: SitemapRegenerateJobRow) {
  return {
    job_id: job.id,
    status: job.status,
    urls_total: job.urls_total,
    urls_written: Number(job.urls_written),
    files_total: job.files_total,
    files_done: job.files_done,
    result: job.result,
    error: job.error,
    started_at: job.started_at,
    completed_at: job.completed_at
  };
}

export async function latestSitemapRegenerateJob(sessionId: string) {
  const result = await pool.query<SitemapRegenerateJobRow>(
    `
      SELECT id, status, urls_total, urls_written, files_total, files_done,
             result, error, started_at, completed_at
      FROM sitemap_regenerate_jobs
      WHERE session_id = $1
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}
