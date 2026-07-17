import { Queue } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";

// Pre-generation of download ZIPs. A concurrency-1 queue (see worker.ts) so
// heavy multi-file archives are written to disk one at a time and never starve
// the parse/extract/sample workers. The daily cleanup job also lives here.
export const PRE_GENERATE_ZIP_QUEUE_NAME = "pre-generate-zip";
export const PRE_GENERATE_ZIP_JOB = "pre-generate-zip" as const;
export const CLEANUP_ZIPS_JOB = "cleanup-zips" as const;

// Delete cached ZIPs (and clear their DB paths) after this age.
export const ZIP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ZIP_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type PreGenerateZipJobData = {
  session_id: string;
  type: "all" | "edited";
};

export type CleanupZipsJobData = Record<string, never>;

export type PreGenerateZipQueueData =
  | PreGenerateZipJobData
  | CleanupZipsJobData;

export type PreGenerateZipJobName =
  | typeof PRE_GENERATE_ZIP_JOB
  | typeof CLEANUP_ZIPS_JOB;

export const preGenerateZipQueue = new Queue<
  PreGenerateZipQueueData,
  void,
  PreGenerateZipJobName
>(PRE_GENERATE_ZIP_QUEUE_NAME, {
  connection: redisConnectionOptions()
});

// Reuse an in-flight job for this (session, type); clear a finished one so the
// singleton jobId is free to enqueue again after an invalidation.
async function reusableSingletonJob(jobId: string) {
  const existingJob = await preGenerateZipQueue.getJob(jobId);

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

export async function enqueuePreGenerateZipJob(data: PreGenerateZipJobData) {
  const jobId = `${PRE_GENERATE_ZIP_JOB}-${data.session_id}-${data.type}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return preGenerateZipQueue.add(PRE_GENERATE_ZIP_JOB, data, {
    jobId,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 200 },
    attempts: 2
  });
}

export async function enqueueCleanupZipsJob() {
  return preGenerateZipQueue.add(
    CLEANUP_ZIPS_JOB,
    {},
    {
      jobId: CLEANUP_ZIPS_JOB,
      repeat: { every: ZIP_CLEANUP_INTERVAL_MS },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
      attempts: 1
    }
  );
}

export async function closePreGenerateZipQueue() {
  await preGenerateZipQueue.close();
}
