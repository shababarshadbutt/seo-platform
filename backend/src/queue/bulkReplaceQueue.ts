import { Queue } from "bullmq";

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
};

export type BulkReplaceQueueData =
  | BulkReplaceJobData
  | BulkReplaceUndoJobData
  | ApplyRedirectsJobData;
export type BulkReplaceJobName =
  | typeof BULK_REPLACE_JOB
  | typeof BULK_REPLACE_UNDO_JOB
  | typeof APPLY_REDIRECTS_JOB;

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

export async function closeBulkReplaceQueue() {
  await bulkReplaceQueue.close();
}
