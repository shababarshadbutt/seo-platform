import { Queue } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";

// Session-level maintenance operations (bulk URL deletion + restore, and
// trailing-slash fix + undo) run on their OWN queue at concurrency 1, kept
// separate from the parse/extract/sample queue and from bulk-replace so a heavy
// multi-file rewrite can never starve them and at most one maintenance op runs
// per worker at a time.
export const MAINTENANCE_QUEUE_NAME = "maintenance";
export const DELETE_PROBLEM_URLS_JOB = "delete-problem-urls" as const;
export const RESTORE_DELETED_URLS_JOB = "restore-deleted-urls" as const;
export const FIX_TRAILING_SLASHES_JOB = "fix-trailing-slashes" as const;
export const FIX_TRAILING_SLASHES_UNDO_JOB =
  "fix-trailing-slashes-undo" as const;

export type DeleteProblemUrlsJobData = {
  session_id: string;
  // maintenance_jobs.id — the progress/status row this job drives.
  job_row_id: string;
  // Display filenames to delete problem URLs from (file-first modal).
  file_displays: string[];
  // Which confirmed HTTP statuses to delete (subset of 301/302/307/308/404).
  // Ignored when `urls` is set.
  statuses: number[];
  // Explicit source URLs to delete instead of a status filter — used by the Fix
  // Redirect URLs modal's Delete action (v1.42.1). Reuses the same deletion
  // pipeline; only URLs backed by a sampled_urls row are removable.
  urls?: string[];
  // Verify-then-delete (migration 038): when true, the candidate rows come from
  // verified_urls (the FULL verified population) instead of sampled_urls, so
  // deletion is no longer capped at the sampled preview. Absent/false → the
  // sampled behaviour above, unchanged.
  use_verified?: boolean;
  // Optional pattern scope for the verified path (the per-pattern Fix modal).
  pattern_id?: string;
};

export type RestoreDeletedUrlsJobData = {
  session_id: string;
  job_row_id: string;
};

export type FixTrailingSlashesJobData = {
  session_id: string;
  job_row_id: string;
  // Display filenames to restrict the rewrite to; null → every affected file.
  selected_files: string[] | null;
};

export type FixTrailingSlashesUndoJobData = {
  session_id: string;
  job_row_id: string;
};

export type MaintenanceQueueData =
  | DeleteProblemUrlsJobData
  | RestoreDeletedUrlsJobData
  | FixTrailingSlashesJobData
  | FixTrailingSlashesUndoJobData;

export type MaintenanceJobName =
  | typeof DELETE_PROBLEM_URLS_JOB
  | typeof RESTORE_DELETED_URLS_JOB
  | typeof FIX_TRAILING_SLASHES_JOB
  | typeof FIX_TRAILING_SLASHES_UNDO_JOB;

export const maintenanceQueue = new Queue<
  MaintenanceQueueData,
  void,
  MaintenanceJobName
>(MAINTENANCE_QUEUE_NAME, {
  connection: redisConnectionOptions()
});

// Reuse an active singleton job, or clear a finished one so the session-scoped
// jobId is free to enqueue again. Progress/history lives in maintenance_jobs,
// not the BullMQ job, so dropping a finished job loses nothing.
async function reusableSingletonJob(jobId: string) {
  const existingJob = await maintenanceQueue.getJob(jobId);

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

async function enqueueSingleton(
  name: MaintenanceJobName,
  data: MaintenanceQueueData
) {
  // One in-flight maintenance op per session per kind.
  const jobId = `${name}-${data.session_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return maintenanceQueue.add(name, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    attempts: 3
  });
}

export function enqueueDeleteProblemUrlsJob(data: DeleteProblemUrlsJobData) {
  return enqueueSingleton(DELETE_PROBLEM_URLS_JOB, data);
}

export function enqueueRestoreDeletedUrlsJob(data: RestoreDeletedUrlsJobData) {
  return enqueueSingleton(RESTORE_DELETED_URLS_JOB, data);
}

export function enqueueFixTrailingSlashesJob(data: FixTrailingSlashesJobData) {
  return enqueueSingleton(FIX_TRAILING_SLASHES_JOB, data);
}

export function enqueueFixTrailingSlashesUndoJob(
  data: FixTrailingSlashesUndoJobData
) {
  return enqueueSingleton(FIX_TRAILING_SLASHES_UNDO_JOB, data);
}

export async function closeMaintenanceQueue() {
  await maintenanceQueue.close();
}
