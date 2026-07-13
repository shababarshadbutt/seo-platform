import { Queue, type JobsOptions } from "bullmq";

import { redisConnectionOptions } from "./redisConnection.js";

export const SITEMAP_QUEUE_NAME = "sitemap";
export const PARSE_SITEMAP_JOB = "parse-sitemap" as const;
export const EXTRACT_PATTERNS_JOB = "extract-patterns" as const;
export const SAMPLE_PATTERNS_JOB = "sample-patterns" as const;
export const CLEANUP_UPLOADS_JOB = "cleanup-uploads" as const;
export const WATCHDOG_STUCK_SESSIONS_JOB = "watchdog-stuck-sessions" as const;
export const PARSE_SITEMAP_BATCH_SIZE = 50;
export const PARSE_SITEMAP_BATCH_DELAY_MS = 100;
export const CLEANUP_UPLOADS_DELAY_MS = 60 * 60 * 1000;
export const WATCHDOG_STUCK_SESSIONS_INTERVAL_MS = 2 * 60 * 1000;

export type ParseSitemapJobData = {
  sitemap_file_id: string;
  session_id: string;
};

export type ExtractPatternsJobData = {
  sitemap_file_id: string;
  session_id: string;
};

export type SamplePatternsJobData = {
  session_id: string;
  sitemap_file_id?: string;
};

export type CleanupUploadsJobData = {
  session_id: string;
  sitemap_file_id?: string;
};

export type WatchdogStuckSessionsJobData = Record<string, never>;

export type SitemapJobData =
  | ParseSitemapJobData
  | ExtractPatternsJobData
  | SamplePatternsJobData
  | CleanupUploadsJobData
  | WatchdogStuckSessionsJobData;
export type SitemapJobName =
  | typeof PARSE_SITEMAP_JOB
  | typeof EXTRACT_PATTERNS_JOB
  | typeof SAMPLE_PATTERNS_JOB
  | typeof CLEANUP_UPLOADS_JOB
  | typeof WATCHDOG_STUCK_SESSIONS_JOB;

export const sitemapQueue = new Queue<
  SitemapJobData,
  void,
  SitemapJobName
>(
  SITEMAP_QUEUE_NAME,
  {
    connection: redisConnectionOptions()
  }
);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSitemapJobOptions(data: ParseSitemapJobData): JobsOptions {
  return {
    jobId: `${PARSE_SITEMAP_JOB}-${data.sitemap_file_id}`,
    removeOnComplete: {
      count: 1000
    },
    removeOnFail: {
      count: 1000
    },
    attempts: 1
  };
}

async function reusableSingletonJob(jobId: string) {
  const existingJob = await sitemapQueue.getJob(jobId);

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

export async function enqueueParseSitemapJobs(
  jobs: ParseSitemapJobData[],
  batchSize = PARSE_SITEMAP_BATCH_SIZE,
  batchDelayMs = PARSE_SITEMAP_BATCH_DELAY_MS
) {
  const enqueuedJobs = [];

  for (let index = 0; index < jobs.length; index += batchSize) {
    const batch = jobs.slice(index, index + batchSize);

    enqueuedJobs.push(
      ...(await sitemapQueue.addBulk(
        batch.map((data) => ({
          name: PARSE_SITEMAP_JOB,
          data,
          opts: parseSitemapJobOptions(data)
        }))
      ))
    );

    if (index + batchSize < jobs.length) {
      await sleep(batchDelayMs);
    }
  }

  return enqueuedJobs;
}

export async function enqueueParseSitemapJob(data: ParseSitemapJobData) {
  const [job] = await enqueueParseSitemapJobs([data], 1, 0);

  return job;
}

export async function enqueueExtractPatternsJob(data: ExtractPatternsJobData) {
  const jobId = `${EXTRACT_PATTERNS_JOB}-${data.session_id}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return sitemapQueue.add(EXTRACT_PATTERNS_JOB, data, {
    jobId,
    removeOnComplete: {
      count: 1000
    },
    removeOnFail: {
      count: 1000
    },
    attempts: 3
  });
}

export async function enqueueSamplePatternsJob(data: SamplePatternsJobData) {
  const sourceId = data.sitemap_file_id ?? "session";
  const jobId = `${SAMPLE_PATTERNS_JOB}-${data.session_id}-${sourceId}`;
  const existingJob = await reusableSingletonJob(jobId);

  if (existingJob) {
    return existingJob;
  }

  return sitemapQueue.add(SAMPLE_PATTERNS_JOB, data, {
    jobId,
    removeOnComplete: {
      count: 1000
    },
    removeOnFail: {
      count: 1000
    },
    attempts: 3
  });
}

export async function enqueueCleanupUploadsJob(
  data: CleanupUploadsJobData,
  delayMs = CLEANUP_UPLOADS_DELAY_MS
) {
  return sitemapQueue.add(CLEANUP_UPLOADS_JOB, data, {
    jobId: `${CLEANUP_UPLOADS_JOB}-${data.session_id}`,
    delay: delayMs,
    removeOnComplete: {
      count: 1000
    },
    removeOnFail: {
      count: 1000
    },
    attempts: 1
  });
}

export async function enqueueWatchdogStuckSessionsJob() {
  return sitemapQueue.add(
    WATCHDOG_STUCK_SESSIONS_JOB,
    {},
    {
      jobId: WATCHDOG_STUCK_SESSIONS_JOB,
      repeat: {
        every: WATCHDOG_STUCK_SESSIONS_INTERVAL_MS
      },
      removeOnComplete: {
        count: 10
      },
      removeOnFail: {
        count: 100
      },
      attempts: 1
    }
  );
}

// Remove all not-yet-running jobs for a session (parse / extract / sample /
// cleanup). Active (locked) jobs are intentionally left alone — they finish on
// their own and the worker's cancellation guard makes them exit without effect.
export async function removeSessionJobs(sessionId: string) {
  const pendingJobs = await sitemapQueue.getJobs([
    "waiting",
    "delayed",
    "paused",
    "prioritized"
  ]);
  let removedCount = 0;

  for (const job of pendingJobs) {
    const data = job?.data as { session_id?: string } | undefined;

    if (!job || data?.session_id !== sessionId) {
      continue;
    }

    try {
      await job.remove();
      removedCount += 1;
    } catch {
      // Job may have started or been removed between listing and removal.
    }
  }

  return removedCount;
}

export async function closeSitemapQueue() {
  await sitemapQueue.close();
}
