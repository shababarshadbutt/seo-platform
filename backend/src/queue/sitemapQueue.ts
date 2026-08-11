import { Queue, type JobsOptions } from "bullmq";

import { config } from "../config.js";
import { redisConnectionOptions } from "./redisConnection.js";

export const SITEMAP_QUEUE_NAME = "sitemap";
export const PARSE_SITEMAP_JOB = "parse-sitemap" as const;
export const EXTRACT_PATTERNS_JOB = "extract-patterns" as const;
export const SAMPLE_PATTERNS_JOB = "sample-patterns" as const;
export const CLEANUP_UPLOADS_JOB = "cleanup-uploads" as const;
export const WATCHDOG_STUCK_SESSIONS_JOB = "watchdog-stuck-sessions" as const;
export const PARSE_SITEMAP_BATCH_SIZE = 50;
export const PARSE_SITEMAP_BATCH_DELAY_MS = 100;
// Safety-net delay for abandoned sessions, from UPLOAD_CLEANUP_DELAY_HOURS
// (default 48). Was a hardcoded 1 hour AND the primary cleanup path — see the
// comment on config.uploadCleanupDelayMs and jobs/cleanupUploadsJob.ts.
export const CLEANUP_UPLOADS_DELAY_MS = config.uploadCleanupDelayMs;
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
  // Set by the resume endpoint: skip patterns that already have sampled_urls so
  // a resumed sample job re-fetches only patterns that never completed.
  resume?: boolean;
  // Set by the per-pattern re-check endpoint: sample EXACTLY this one pattern and
  // touch nothing about the session's lifecycle.
  //
  // WHY THIS EXISTS. Sampling was reachable only twice — at the end of extraction,
  // and from resume while sampling was still unfinished — so a completed session's
  // Status / Confidence / Redirect cells were frozen at whatever the checker
  // concluded on the first pass. Every later improvement to the checker (the WAF
  // "blocked" classification, the browser-profile retry) was invisible on existing
  // sessions, and the Check button on an unscored row could not change it: triage
  // and full verification write verify_triage_runs / verified_urls and never
  // patterns.status. This is the missing path that lets one row be re-measured.
  //
  // `resume` is IGNORED when this is set — re-checking a pattern that already has
  // rows is the entire point, so the already-sampled skip must not apply.
  pattern_id?: string;
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

// The singleton job id for a pattern re-check, exported so the status endpoint can
// look the job up by id instead of scanning the queue.
export function samplePatternJobId(sessionId: string, patternId: string) {
  return `${SAMPLE_PATTERNS_JOB}-${sessionId}-pattern-${patternId}`;
}

export async function enqueueSamplePatternsJob(data: SamplePatternsJobData) {
  const sourceId = data.sitemap_file_id ?? "session";
  // A pattern re-check gets its OWN singleton id. Sharing the session-wide id
  // would make a re-check collide with (and be silently swallowed by) the
  // session's own sample job — and vice versa.
  const jobId = data.pattern_id
    ? samplePatternJobId(data.session_id, data.pattern_id)
    : `${SAMPLE_PATTERNS_JOB}-${data.session_id}-${sourceId}`;
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
