import { Queue } from "bullmq";

import type { RedirectRule } from "../sitemaps/redirectRule.js";
import type { ResolvedStructureFilter } from "../sitemaps/structureClusters.js";

import { redisConnectionOptions } from "./redisConnection.js";

// Bulk pattern-replace runs on its OWN queue + single-concurrency worker, kept
// separate from the shared "sitemap" queue so a heavy multi-million-URL rewrite
// can never starve parse/extract/sample jobs, and so at most one bulk replace
// runs at a time.
export const BULK_REPLACE_QUEUE_NAME = "bulk-replace";
export const BULK_REPLACE_JOB = "bulk-replace" as const;
export const BULK_REPLACE_UNDO_JOB = "bulk-replace-undo" as const;
// Widened apply-redirects for large patterns (> FILE_REWRITE_PARALLEL_THRESHOLD
// files) runs here too (v1.42): same dedicated single-concurrency queue, so a
// heavy whole-pattern file rewrite never blocks the API event loop or starves
// parse/extract/sample jobs.
export const APPLY_REDIRECTS_JOB = "apply-redirects" as const;
// Pattern rename / structure transform / transform undo (v1.48). Same reason
// again: each rewrites every file the pattern spans, which measured 136s on an
// 823-file session — past what any HTTP client should wait on. Sharing this
// single-concurrency queue is deliberate: bulk replace, apply-redirects and these
// all rewrite the SAME sitemap files, so serialising them is what keeps two
// whole-pattern rewrites from interleaving their copy-on-write file swaps.
export const PATTERN_RENAME_JOB = "pattern-rename" as const;
export const PATTERN_TRANSFORM_JOB = "pattern-transform" as const;
export const PATTERN_TRANSFORM_UNDO_JOB = "pattern-transform-undo" as const;
// Read-only full-population measurement of a transform. Shares the queue, the
// job row and the one-per-pattern guard with the operations it measures, so a
// dry run and an apply can never be in flight for the same pattern at once.
export const PATTERN_TRANSFORM_DRY_RUN_JOB = "pattern-transform-dry-run" as const;

export type BulkReplaceJobData = {
  session_id: string;
  // bulk_replace_jobs.id — the progress/status row this job drives.
  job_row_id: string;
  from_pattern: string;
  to_pattern: string;
  // Display filenames to restrict the rewrite to. null → all of the pattern's
  // files.
  selected_files: string[] | null;
};

export type BulkReplaceUndoJobData = {
  session_id: string;
  job_row_id: string;
};

// Background apply-redirects (v1.42). The client sends WHICH rows to change; the
// job re-derives the rule and destinations server-side (see applyRedirectsJob).
export type ApplyRedirectsJobData = {
  session_id: string;
  pattern_id: string;
  // Sampled_urls ids whose confirmed destination to adopt. null → all redirects.
  url_ids: string[] | null;
  // Unsampled source URLs to rewrite by the inferred rule.
  inferred_urls: string[];
  // Structure scope (v1.66), already RESOLVED against the pattern template by
  // the route so the worker never parses a template. null → whole pattern.
  structure_filters?: ResolvedStructureFilter[] | null;
  // Rules a human approved (v1.72), already validated by the route against the
  // candidates the server derived from its own confirmed pairs. The job applies
  // these INSTEAD of deriving its own — deriveRedirectRule returns null for
  // exactly the disagreeing pairs that make an approval necessary, so a job that
  // re-derived would silently do nothing.
  approved_rules?: RedirectRule[] | null;
};

// Pattern structure operations. Everything the worker needs is in the
// pattern_structure_jobs row (params jsonb), so the payload stays a pointer to
// it — the row is the single source of truth for both progress and inputs.
export type PatternStructureJobData = {
  session_id: string;
  pattern_id: string;
  // pattern_structure_jobs.id — the progress/status row this job drives.
  job_row_id: string;
};

export type BulkReplaceQueueData =
  | BulkReplaceJobData
  | BulkReplaceUndoJobData
  | ApplyRedirectsJobData
  | PatternStructureJobData;
export type BulkReplaceJobName =
  | typeof BULK_REPLACE_JOB
  | typeof BULK_REPLACE_UNDO_JOB
  | typeof APPLY_REDIRECTS_JOB
  | typeof PATTERN_RENAME_JOB
  | typeof PATTERN_TRANSFORM_JOB
  | typeof PATTERN_TRANSFORM_UNDO_JOB
  | typeof PATTERN_TRANSFORM_DRY_RUN_JOB;

export const bulkReplaceQueue = new Queue<
  BulkReplaceQueueData,
  void,
  BulkReplaceJobName
>(BULK_REPLACE_QUEUE_NAME, {
  connection: redisConnectionOptions()
});

// Reuse an active singleton job, or clear a finished one so the session-scoped
// jobId is free to enqueue again (repeat apply/undo cycles). Progress/history
// lives in the bulk_replace_jobs table, not the BullMQ job, so dropping a
// finished job loses nothing.
async function reusableSingletonJob(jobId: string) {
  const existingJob = await bulkReplaceQueue.getJob(jobId);

  if (!existingJob) {
    return null;
  }

  const state = await existingJob.getState();

  if (state === "completed" || state === "failed") {
    await existingJob.remove();
    return null;
  }

  return existingJob;
}

// One in-flight bulk operation per session: the jobId is session-scoped, so a
// second enqueue while one is active reuses the running job.
export async function enqueueBulkReplaceJob(data: BulkReplaceJobData) {
  const jobId = `${BULK_REPLACE_JOB}-${data.session_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return bulkReplaceQueue.add(BULK_REPLACE_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    // Resumable: on crash the job retries and skips files already rewritten.
    attempts: 3
  });
}

export async function enqueueBulkReplaceUndoJob(data: BulkReplaceUndoJobData) {
  const jobId = `${BULK_REPLACE_UNDO_JOB}-${data.session_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return bulkReplaceQueue.add(BULK_REPLACE_UNDO_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    attempts: 3
  });
}

// One in-flight apply-redirects per pattern: a second enqueue while one runs
// reuses it. Retries resume safely — re-applying an already-rewritten file is a
// no-op (its <loc> no longer matches the old URL).
export async function enqueueApplyRedirectsJob(data: ApplyRedirectsJobData) {
  const jobId = `${APPLY_REDIRECTS_JOB}-${data.pattern_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return bulkReplaceQueue.add(APPLY_REDIRECTS_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    attempts: 3
  });
}

// One in-flight structure operation per pattern. The jobId is pattern-scoped (not
// pattern+kind): a rename, a transform and an undo all rewrite the same files, so
// only one may be queued for a pattern at a time. The authoritative guard is the
// partial unique index in migration 037 — this just avoids duplicate BullMQ jobs.
//
// The dry run is on this list even though it writes nothing: measuring a
// transform while another operation is rewriting the same files would measure a
// moving target, and applying while a measurement is still running would make
// the measurement it is gated on describe the wrong state.
export async function enqueuePatternStructureJob(
  name:
    | typeof PATTERN_RENAME_JOB
    | typeof PATTERN_TRANSFORM_JOB
    | typeof PATTERN_TRANSFORM_UNDO_JOB
    | typeof PATTERN_TRANSFORM_DRY_RUN_JOB,
  data: PatternStructureJobData
) {
  const jobId = `pattern-structure-${data.pattern_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return bulkReplaceQueue.add(name, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    // NO retries. Unlike bulk replace (whose per-file rewrite is idempotent —
    // a redone file no longer matches the from-pattern), a transform's replace
    // rules can compound when re-applied, and its undo bookkeeping is one level
    // deep. A half-finished transform must surface as FAILED for the user to
    // undo deliberately, not be silently re-run from the top.
    attempts: 1
  });
}

export async function closeBulkReplaceQueue() {
  await bulkReplaceQueue.close();
}
