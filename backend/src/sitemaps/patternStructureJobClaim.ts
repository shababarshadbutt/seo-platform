import { createHash } from "node:crypto";

import { pool } from "../db/pool.js";

// Claiming a pattern structure job, and the retry-after-timeout problem it exists
// to solve.
//
// THE BUG. Rename / transform / transform-undo used to run inside the HTTP
// request. On a large pattern that takes minutes (823 files measured at 136s), the
// frontend's 180s timeout fires first — but nothing cancels the server, which
// commits as normal. The user is shown a failure for work that SUCCEEDED, and the
// natural next move is to press the button again. That retry then met one of:
//
//   * "Another pattern in this session already uses the structure ..." — the
//     patterns_unique_template_per_session_role guard, which is true but
//     describes the user's OWN completed operation, so it reads as nonsense.
//   * "new_template must differ from the current template" — same thing for
//     rename, equally confusing.
//   * silently doing the whole rewrite AGAIN. Harmless for a static-segment
//     rename (the second pass no longer matches), but a transform whose param rule
//     is a `replace` compounds: find "item" → "item-x" applied twice yields
//     "item-x-x". No error, corrupted URLs.
//
// THE FIX. Every operation is fingerprinted from its inputs. Before starting one:
//   * an in-flight job with the SAME fingerprint means this is a retry → attach
//     the caller to it and report progress;
//   * an in-flight job with a DIFFERENT fingerprint means a genuinely different
//     operation is mid-flight → refuse with a message naming it;
//   * a recently COMPLETED job with the same fingerprint means the retry arrived
//     after the original finished → replay its result and say so, instead of
//     re-applying it.
// The authoritative concurrency guard is the partial unique index from migration
// 037, not these reads: two simultaneous requests can both pass the lookup, and
// the loser's INSERT violates the index, which is handled as an attach.

export const PATTERN_STRUCTURE_ACTIVE_STATUSES = ["PENDING", "RUNNING"] as const;

// How long after a job completes a same-fingerprint request is still treated as a
// retry rather than a fresh operation. Comfortably longer than the client timeout
// that caused the retry, short enough that deliberately re-running the same
// transform later still works.
const RETRY_WINDOW_MINUTES = 15;

export type PatternStructureKind = "RENAME" | "TRANSFORM" | "TRANSFORM_UNDO";

export type PatternStructureJobRow = {
  id: string;
  kind: string;
  status: string;
  files_total: number;
  files_done: number;
  urls_rewritten: string;
  result: unknown;
  error: string | null;
  started_at: Date;
  completed_at: Date | null;
};

const KIND_LABELS: Record<string, string> = {
  RENAME: "a pattern rename",
  TRANSFORM: "a structure transform",
  TRANSFORM_UNDO: "a transform undo"
};

export function describeKind(kind: string): string {
  return KIND_LABELS[kind] ?? "an operation";
}

// Stable hash of everything that defines the operation. Arrays are sorted so a
// client that sends the same file selection in a different order still looks like
// the same request.
export function patternStructureFingerprint(
  kind: PatternStructureKind,
  inputs: Record<string, unknown>
): string {
  const normalise = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return [...value].map(normalise).sort();
    }

    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalise(entry)]);
    }

    return value ?? null;
  };

  return createHash("sha256")
    .update(JSON.stringify([kind, normalise(inputs)]))
    .digest("hex");
}

async function activeJobForPattern(patternId: string) {
  const result = await pool.query<PatternStructureJobRow & {
    request_fingerprint: string;
  }>(
    `
      SELECT id, kind, status, files_total, files_done, urls_rewritten, result,
             error, started_at, completed_at, request_fingerprint
      FROM pattern_structure_jobs
      WHERE pattern_id = $1 AND status IN ('PENDING', 'RUNNING')
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [patternId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

export async function recentlyCompletedJob(
  patternId: string,
  fingerprint: string
) {
  const result = await pool.query<PatternStructureJobRow>(
    `
      SELECT id, kind, status, files_total, files_done, urls_rewritten, result,
             error, started_at, completed_at
      FROM pattern_structure_jobs
      WHERE pattern_id = $1
        AND request_fingerprint = $2
        AND status = 'COMPLETE'
        AND completed_at > now() - ($3 || ' minutes')::interval
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [patternId, fingerprint, String(RETRY_WINDOW_MINUTES)]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

// The most recent completed job of a given kind for this pattern, fingerprint
// aside. Needed where a retry cannot be fingerprint-matched because the operation
// consumed the very row that identifies it: transform-undo deletes the
// pattern_transforms row it targeted, so a retry has nothing left to hash and
// would otherwise surface "no transform to undo" for an undo that just worked.
export async function recentlyCompletedJobOfKind(
  patternId: string,
  kind: PatternStructureKind
) {
  const result = await pool.query<PatternStructureJobRow>(
    `
      SELECT id, kind, status, files_total, files_done, urls_rewritten, result,
             error, started_at, completed_at
      FROM pattern_structure_jobs
      WHERE pattern_id = $1
        AND kind = $2
        AND status = 'COMPLETE'
        AND completed_at > now() - ($3 || ' minutes')::interval
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [patternId, kind, String(RETRY_WINDOW_MINUTES)]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}

export type ClaimOutcome =
  // A job row was created; the caller should enqueue it.
  | { outcome: "created"; jobId: string; filesTotal: number }
  // This exact operation is already running — the caller polls the same job.
  | { outcome: "attached"; jobId: string; job: PatternStructureJobRow | null }
  // This exact operation already finished (the retry-after-timeout case).
  | { outcome: "already_completed"; jobId: string; job: PatternStructureJobRow }
  // A DIFFERENT operation is mid-flight on this pattern.
  | { outcome: "busy"; jobId: string; kind: string };

function isActiveJobIndexViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };

  return (
    candidate.code === "23505" &&
    candidate.constraint === "pattern_structure_jobs_one_active_per_pattern"
  );
}

// Reserve the right to run `kind` on `patternId`, or explain why we are not
// starting a second one.
export async function claimPatternStructureJob(options: {
  sessionId: string;
  patternId: string;
  kind: PatternStructureKind;
  fingerprint: string;
  params: Record<string, unknown>;
  filesTotal: number;
}): Promise<ClaimOutcome> {
  const active = await activeJobForPattern(options.patternId);

  if (active) {
    return active.request_fingerprint === options.fingerprint
      ? { outcome: "attached", jobId: active.id, job: active }
      : { outcome: "busy", jobId: active.id, kind: active.kind };
  }

  const completed = await recentlyCompletedJob(
    options.patternId,
    options.fingerprint
  );

  if (completed) {
    return {
      outcome: "already_completed",
      jobId: completed.id,
      job: completed
    };
  }

  try {
    const inserted = await pool.query<{ id: string }>(
      `
        INSERT INTO pattern_structure_jobs
          (session_id, pattern_id, kind, request_fingerprint, params,
           files_total, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
        RETURNING id
      `,
      [
        options.sessionId,
        options.patternId,
        options.kind,
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

    // Lost the race against a concurrent request. Re-read and treat it the same
    // way the lookup above would have.
    const raced = await activeJobForPattern(options.patternId);

    if (!raced) {
      // The winner finished between the violation and this read.
      const justCompleted = await recentlyCompletedJob(
        options.patternId,
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
      : { outcome: "busy", jobId: raced.id, kind: raced.kind };
  }
}

// The status payload the frontend polls. `result` carries the exact body the old
// synchronous route returned, so a caller can treat a finished job's result the
// way it used to treat the 200.
export function serialisePatternStructureJob(job: PatternStructureJobRow) {
  return {
    job_id: job.id,
    kind: job.kind,
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

export async function latestPatternStructureJob(patternId: string) {
  const result = await pool.query<PatternStructureJobRow>(
    `
      SELECT id, kind, status, files_total, files_done, urls_rewritten, result,
             error, started_at, completed_at
      FROM pattern_structure_jobs
      WHERE pattern_id = $1
      ORDER BY started_at DESC
      LIMIT 1
    `,
    [patternId]
  );

  return result.rowCount === 0 ? null : result.rows[0];
}
