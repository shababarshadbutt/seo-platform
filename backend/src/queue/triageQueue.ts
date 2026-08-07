import { Queue } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";

// Sample triage runs on its OWN queue, separate from the verification queue.
//
// WHY NOT the verification queue. That queue is concurrency 1 by design (one
// full-population sweep at a time). A triage request landing behind a running
// 17-minute verification would wait 17 minutes to deliver a 15-second answer,
// which destroys the entire point of having a fast triage layer.
//
// Running the two concurrently does NOT double the load on the client's web
// server, and that is not an accident: pacing is enforced per target HOST in
// http/hostRateLimiter.ts, process-globally, so a triage sample and a full
// verification aimed at the same origin draw from one shared budget. Queue
// isolation buys responsiveness; the rate limiter — not the queue — is what
// bounds the traffic.
//
// Concurrency stays 1 here too: two triages at once would only compete for the
// same host budget and finish no sooner, and the unique partial index in
// migration 040 already forbids two in-flight triages for one pattern.
export const TRIAGE_QUEUE_NAME = "verify-triage";
export const TRIAGE_SAMPLE_JOB = "triage-sample" as const;

export type TriageSampleJobData = {
  session_id: string;
  pattern_id: string;
  // verify_triage_runs.id — the row this job reports into.
  run_id: string;
  // Statuses the caller asked about (e.g. [404]); null = every problem status.
  target_statuses: number[] | null;
};

export type TriageJobName = typeof TRIAGE_SAMPLE_JOB;

export const triageQueue = new Queue<TriageSampleJobData, void, TriageJobName>(
  TRIAGE_QUEUE_NAME,
  {
    connection: redisConnectionOptions()
  }
);

async function reusableSingletonJob(jobId: string) {
  const existingJob = await triageQueue.getJob(jobId);

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

export async function enqueueTriageSampleJob(data: TriageSampleJobData) {
  // One in-flight triage per PATTERN (not per session): triaging two different
  // patterns of the same session concurrently is fine and useful, and they
  // still share the per-host rate budget.
  const jobId = `${TRIAGE_SAMPLE_JOB}-${data.pattern_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return triageQueue.add(TRIAGE_SAMPLE_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    // No retries: a triage is cheap to re-request by hand, and an automatic
    // retry would silently re-probe the client's server after a failure whose
    // cause (WAF block, origin down) makes a second attempt actively unwelcome.
    attempts: 1
  });
}

export async function closeTriageQueue() {
  await triageQueue.close();
}
