import { randomUUID } from "node:crypto";

import { Queue } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";
import type { CategorizerPhase } from "../jobs/categorizerJobState.js";

// The Sitemap Categorizer tool's background work: ingest (pull + parse every
// sitemap file for a domain), status-check (HTTP-probe every ingested URL),
// categorize (classify every non-404 URL), and generate (write the output
// sitemap set + index). Its OWN queue, separate from publishQueue, because
// concurrency needs differ sharply: a status-check run can occupy a worker
// slot for days (see categorizerStatusCheckJob.ts's continuation-re-enqueue
// design), which must not starve the SFTP/S3 pulls and publishes other
// sessions are waiting on.
export const CATEGORIZER_QUEUE_NAME = "sitemap-categorizer";

export const CATEGORIZER_INGEST_JOB = "categorizer-ingest" as const;
export const CATEGORIZER_STATUS_CHECK_JOB = "categorizer-status-check" as const;
export const CATEGORIZER_CATEGORIZE_JOB = "categorizer-categorize" as const;
export const CATEGORIZER_GENERATE_JOB = "categorizer-generate" as const;

// How many categorizer phase-jobs run at once. Low: these are heavy,
// long-running, per-session operations (one session's status-check or
// generate phase can occupy a slot for a long time), not the bursty
// short-lived jobs other queues run many of in parallel.
export const CATEGORIZER_WORKER_CONCURRENCY = 2;

export type CategorizerIngestJobData = { session_id: string };
export type CategorizerStatusCheckJobData = { session_id: string };
export type CategorizerCategorizeJobData = { session_id: string };
export type CategorizerGenerateJobData = { session_id: string };

export type CategorizerQueueData =
  | CategorizerIngestJobData
  | CategorizerStatusCheckJobData
  | CategorizerCategorizeJobData
  | CategorizerGenerateJobData;
export type CategorizerJobName =
  | typeof CATEGORIZER_INGEST_JOB
  | typeof CATEGORIZER_STATUS_CHECK_JOB
  | typeof CATEGORIZER_CATEGORIZE_JOB
  | typeof CATEGORIZER_GENERATE_JOB;

// worker.ts's queue-level "failed" handler only gets a BullMQ job (name +
// data.session_id), not a CategorizerPhase string — this is how it recovers
// one from the other to call markActiveCategorizerJobFailed.
export const JOB_NAME_TO_PHASE: Record<CategorizerJobName, CategorizerPhase> = {
  [CATEGORIZER_INGEST_JOB]: "ingest",
  [CATEGORIZER_STATUS_CHECK_JOB]: "status-check",
  [CATEGORIZER_CATEGORIZE_JOB]: "categorize",
  [CATEGORIZER_GENERATE_JOB]: "generate"
};

export const categorizerQueue = new Queue<
  CategorizerQueueData,
  void,
  CategorizerJobName
>(CATEGORIZER_QUEUE_NAME, {
  connection: redisConnectionOptions()
});

// Same idempotent-singleton shape as publishQueue.ts's reusableSingletonJob: a
// completed/failed job is cleared so a retry can enqueue a fresh one under the
// same id, and a still-running job is returned as-is so a second click (or a
// continuation enqueue racing a route call) attaches to it instead of
// double-running the phase.
async function reusableSingletonJob(jobId: string) {
  const existingJob = await categorizerQueue.getJob(jobId);

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

function singletonJobId(jobName: CategorizerJobName, sessionId: string) {
  return `${jobName}-${sessionId}`;
}

async function enqueueSingleton(
  jobName: CategorizerJobName,
  data: CategorizerQueueData
) {
  const jobId = singletonJobId(jobName, data.session_id);
  const existing = await reusableSingletonJob(jobId);

  if (existing) {
    return existing;
  }

  return categorizerQueue.add(jobName, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    // No automatic retry on any categorizer phase: each phase is resumable
    // from its own durable checkpoint (categorizer_jobs.checkpoint), so a
    // re-run is a deliberate "resume" action, not a silent repeat of
    // possibly-already-done work.
    attempts: 1
  });
}

export async function enqueueCategorizerIngestJob(
  data: CategorizerIngestJobData
) {
  return enqueueSingleton(CATEGORIZER_INGEST_JOB, data);
}

export async function enqueueCategorizerStatusCheckJob(
  data: CategorizerStatusCheckJobData
) {
  return enqueueSingleton(CATEGORIZER_STATUS_CHECK_JOB, data);
}

export async function enqueueCategorizerCategorizeJob(
  data: CategorizerCategorizeJobData
) {
  return enqueueSingleton(CATEGORIZER_CATEGORIZE_JOB, data);
}

export async function enqueueCategorizerGenerateJob(
  data: CategorizerGenerateJobData
) {
  return enqueueSingleton(CATEGORIZER_GENERATE_JOB, data);
}

// A chunked phase's own time-box continuation, called from WITHIN the
// currently-executing job for that exact phase+session. Deliberately bypasses
// enqueueSingleton/reusableSingletonJob: that helper only adds a new job when
// the existing singleton-id job is "completed" or "failed", but here the
// existing job is the CALLER ITSELF, still "active" — so reusableSingletonJob
// would just hand back that same job and add nothing, silently dropping the
// continuation (the bug this function exists to fix). A fresh, random job id
// guarantees BullMQ always adds real, runnable work.
//
// Safe without a BullMQ-level lock because categorizer_jobs already has one:
// categorizer_jobs_one_active_per_phase (migration 064) plus
// startOrResumeCategorizerJob's "pick up the active PENDING/RUNNING row"
// logic means whichever BullMQ job/attempt picks this up resumes the same
// durable checkpoint, regardless of job id.
async function enqueueContinuation(
  jobName: CategorizerJobName,
  data: CategorizerQueueData
) {
  return categorizerQueue.add(jobName, data, {
    jobId: `${jobName}-${data.session_id}-${randomUUID()}`,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    attempts: 1
  });
}

export async function enqueueCategorizerStatusCheckContinuation(
  data: CategorizerStatusCheckJobData
) {
  return enqueueContinuation(CATEGORIZER_STATUS_CHECK_JOB, data);
}

export async function enqueueCategorizerCategorizeContinuation(
  data: CategorizerCategorizeJobData
) {
  return enqueueContinuation(CATEGORIZER_CATEGORIZE_JOB, data);
}

export async function enqueueCategorizerGenerateContinuation(
  data: CategorizerGenerateJobData
) {
  return enqueueContinuation(CATEGORIZER_GENERATE_JOB, data);
}

export async function closeCategorizerQueue() {
  await categorizerQueue.close();
}
