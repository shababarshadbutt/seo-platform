import { Queue } from "bullmq";

import type { ResolvedStructureFilter } from "../sitemaps/structureClusters.js";

import { redisConnectionOptions } from "./redisConnection.js";

// Full-population URL verification runs on its OWN queue, deliberately NOT on
// the maintenance queue: verifying every URL of a large session is
// network-bound and can run for HOURS (hundreds of thousands of HEAD/GET
// probes), while maintenance ops (URL delete/restore, trailing-slash fix) are
// minutes-long disk rewrites a user is actively waiting on. Sharing the
// concurrency-1 maintenance worker would let one long verification block every
// delete and restore behind it. Concurrency stays 1 here too — at most one
// verification per worker — the isolation is from OTHER kinds of work, not from
// itself. Progress/history lives in maintenance_jobs (kind 'verify-urls'), not
// in BullMQ, exactly like the maintenance queue.
export const VERIFICATION_QUEUE_NAME = "verification";
export const VERIFY_URLS_JOB = "verify-urls" as const;

export type VerifyUrlsJobData = {
  session_id: string;
  // maintenance_jobs.id — the progress/status row this job drives. For kind
  // 'verify-urls', files_total/files_done carry URL counts (see 038 migration).
  job_row_id: string;
  // Patterns (source_role 'current') whose URLs to verify; null → every current
  // pattern of the session. The Fix modal ALWAYS sends exactly one id — sending
  // null from there is the bug this release fixes.
  pattern_ids: string[] | null;
  // Structure scope (v1.55): resolved filters limiting the population to one of
  // the pattern's detected sub-structures, as picked in the Fix modal's "Limit
  // this edit to". Applies to every pattern in pattern_ids — the modal always
  // sends exactly one. null → the whole pattern.
  // Optional like every other structureFilters field in the codebase, so an
  // unscoped enqueue reads exactly as it did before v1.55.
  structure_filters?: ResolvedStructureFilter[] | null;
  // Statuses the caller asked about, for a status-scoped run ("Verify 404s").
  // Narrows what the completion count REPORTS, not what gets probed: a URL's
  // status cannot be known without checking it. null → every problem status.
  target_statuses: number[] | null;
};

export type VerificationJobName = typeof VERIFY_URLS_JOB;

export const verificationQueue = new Queue<
  VerifyUrlsJobData,
  void,
  VerificationJobName
>(VERIFICATION_QUEUE_NAME, {
  connection: redisConnectionOptions()
});

// Reuse an active singleton job, or clear a finished one so the session-scoped
// jobId is free to enqueue again. Progress/history lives in maintenance_jobs,
// not the BullMQ job, so dropping a finished job loses nothing. (Same shape as
// maintenanceQueue's reusableSingletonJob.)
async function reusableSingletonJob(jobId: string) {
  const existingJob = await verificationQueue.getJob(jobId);

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

// Stable id for a verification's SCOPE.
//
// This used to be the session id alone, which meant a whole-session run and a
// pattern-scoped run were the same BullMQ job: whichever arrived second was
// silently dropped as a duplicate, and its caller polled a job that was
// verifying something else entirely. Sorting makes the id independent of the
// order the caller listed its patterns in, so the same scope always dedupes.
export function verifyScopeJobId(
  sessionId: string,
  patternIds: string[] | null
): string {
  if (!patternIds || patternIds.length === 0) {
    return `${VERIFY_URLS_JOB}-${sessionId}`;
  }

  return `${VERIFY_URLS_JOB}-${sessionId}-${[...patternIds].sort().join("_")}`;
}

export async function enqueueVerifyUrlsJob(data: VerifyUrlsJobData) {
  // One in-flight verification per (session, scope). Still at most one RUNNING
  // at a time overall — the queue is concurrency 1 — this only controls what
  // counts as a duplicate request.
  const jobId = verifyScopeJobId(data.session_id, data.pattern_ids);
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return verificationQueue.add(VERIFY_URLS_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    attempts: 3
  });
}

export async function closeVerificationQueue() {
  await verificationQueue.close();
}
