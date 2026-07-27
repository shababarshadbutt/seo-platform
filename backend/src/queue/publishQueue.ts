import { Queue } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";

// Phase 1 long-running operations: pulling a domain's sitemap set over SFTP and
// publishing a session to S3. Same reasoning as the bulk-replace queue — a
// large-domain pull or publish must never block the API event loop or trip the
// request timeout (the failure mode that burned the ZIP path in v1.27 and the
// Cleaner in v1.38).
//
// Its OWN queue, separate from bulk-replace, for two reasons: bulk-replace runs
// at concurrency 1 by design (one heavy rewrite at a time), whereas publishes
// for DIFFERENT domains must run in parallel for 10+ concurrent users. Same-
// domain safety is enforced by the per-domain lock, not by queue serialisation.
export const PUBLISH_QUEUE_NAME = "publish";
export const SFTP_PULL_JOB = "sftp-pull" as const;
export const S3_PUBLISH_JOB = "s3-publish" as const;

// How many pull/publish jobs run at once on this box. SFTP has its own tighter
// connection cap (SFTP_MAX_CONCURRENT_CONNECTIONS); this bounds total churn.
export const PUBLISH_WORKER_CONCURRENCY = 4;

export type SftpPullJobData = {
  session_id: string;
  domain: string;
};

export type S3PublishJobData = {
  session_id: string;
  domain: string;
};

export type PublishQueueData = SftpPullJobData | S3PublishJobData;
export type PublishJobName = typeof SFTP_PULL_JOB | typeof S3_PUBLISH_JOB;

export const publishQueue = new Queue<
  PublishQueueData,
  void,
  PublishJobName
>(PUBLISH_QUEUE_NAME, {
  connection: redisConnectionOptions()
});

async function reusableSingletonJob(jobId: string) {
  const existingJob = await publishQueue.getJob(jobId);

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

// One in-flight pull per session — a second click reuses the running job.
export async function enqueueSftpPullJob(data: SftpPullJobData) {
  const jobId = `${SFTP_PULL_JOB}-${data.session_id}`;
  const existing = await reusableSingletonJob(jobId);

  if (existing) {
    return existing;
  }

  return publishQueue.add(SFTP_PULL_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    // No automatic retry: a half-finished pull should be re-triggered
    // deliberately, not silently repeated against the SFTP endpoint.
    attempts: 1
  });
}

// One in-flight publish per session. Cross-user, same-DOMAIN collisions are
// rejected up front by the per-domain lock in the route, before enqueue.
export async function enqueueS3PublishJob(data: S3PublishJobData) {
  const jobId = `${S3_PUBLISH_JOB}-${data.session_id}`;
  const existing = await reusableSingletonJob(jobId);

  if (existing) {
    return existing;
  }

  return publishQueue.add(S3_PUBLISH_JOB, data, {
    jobId,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
    // Publishing overwrites production. An automatic retry could re-run a
    // partially applied publish without anyone deciding to; keep it manual.
    attempts: 1
  });
}

export async function closePublishQueue() {
  await publishQueue.close();
}
