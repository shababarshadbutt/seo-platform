import { Queue } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";

// Bulk pattern-replace runs on its OWN queue + single-concurrency worker, kept
// separate from the shared "sitemap" queue so a heavy multi-million-URL rewrite
// can never starve parse/extract/sample jobs, and so at most one bulk replace
// runs at a time.
export const BULK_REPLACE_QUEUE_NAME = "bulk-replace";
export const BULK_REPLACE_JOB = "bulk-replace" as const;
export const BULK_REPLACE_UNDO_JOB = "bulk-replace-undo" as const;

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

export type BulkReplaceQueueData = BulkReplaceJobData | BulkReplaceUndoJobData;
export type BulkReplaceJobName =
  | typeof BULK_REPLACE_JOB
  | typeof BULK_REPLACE_UNDO_JOB;

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

export async function closeBulkReplaceQueue() {
  await bulkReplaceQueue.close();
}
