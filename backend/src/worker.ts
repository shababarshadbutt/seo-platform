import Fastify from "fastify";
import { Worker } from "bullmq";

import { config } from "./config.js";
import { closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import {
  CLEANUP_UPLOADS_JOB,
  closeSitemapQueue,
  enqueueWatchdogStuckSessionsJob,
  EXTRACT_PATTERNS_JOB,
  PARSE_SITEMAP_JOB,
  SAMPLE_PATTERNS_JOB,
  SITEMAP_QUEUE_NAME,
  WATCHDOG_STUCK_SESSIONS_JOB,
  type CleanupUploadsJobData,
  type ExtractPatternsJobData,
  type ParseSitemapJobData,
  type SamplePatternsJobData,
  type SitemapJobData,
  type SitemapJobName
} from "./queue/sitemapQueue.js";
import {
  BULK_REPLACE_JOB,
  BULK_REPLACE_QUEUE_NAME,
  BULK_REPLACE_UNDO_JOB,
  closeBulkReplaceQueue,
  type BulkReplaceJobData,
  type BulkReplaceUndoJobData,
  type BulkReplaceQueueData,
  type BulkReplaceJobName
} from "./queue/bulkReplaceQueue.js";
import { redisConnectionOptions } from "./queue/redisConnection.js";
import {
  processBulkReplaceJob,
  processBulkReplaceUndoJob
} from "./jobs/bulkReplaceJob.js";
import { processCleanupUploadsJob } from "./jobs/cleanupUploadsJob.js";
import { processExtractPatternsJob } from "./jobs/extractPatternsJob.js";
import { processParseSitemapJob } from "./jobs/parseSitemapJob.js";
import { processSamplePatternsJob } from "./jobs/samplePatternsJob.js";
import { processWatchdogStuckSessionsJob } from "./jobs/watchdogStuckSessionsJob.js";

const SITEMAP_WORKER_CONCURRENCY = 5;

const app = Fastify({
  logger: true
});
let parseWorker: Worker<
  SitemapJobData,
  void,
  SitemapJobName
> | null = null;
// Bulk pattern replace runs on its own queue at concurrency 1 so a heavy
// multi-million-URL rewrite never starves parse/extract/sample jobs and at most
// one bulk operation runs at a time.
let bulkReplaceWorker: Worker<
  BulkReplaceQueueData,
  void,
  BulkReplaceJobName
> | null = null;

function jobDataContext(data: SitemapJobData | undefined) {
  const maybeData = data as
    | Partial<ParseSitemapJobData & CleanupUploadsJobData>
    | undefined;

  return {
    session_id: maybeData?.session_id,
    sitemap_file_id: maybeData?.sitemap_file_id
  };
}

app.get("/health", async () => ({
  ok: true,
  service: "worker",
  status: parseWorker ? "running" : "starting",
  redisUrl: config.redisUrl.replace(/\/\/.*@/, "//***@")
}));

async function start() {
  try {
    await runMigrations(app.log);
    parseWorker = new Worker<SitemapJobData, void, SitemapJobName>(
      SITEMAP_QUEUE_NAME,
      async (job) => {
        if (job.name === PARSE_SITEMAP_JOB) {
          app.log.info(
            {
              job_id: job.id,
              session_id: job.data.session_id,
              sitemap_file_id: job.data.sitemap_file_id
            },
            "parse sitemap job handler received job"
          );
          await processParseSitemapJob(job.data as ParseSitemapJobData, app.log);
          return;
        }

        if (job.name === EXTRACT_PATTERNS_JOB) {
          await processExtractPatternsJob(
            job.data as ExtractPatternsJobData,
            app.log
          );
          return;
        }

        if (job.name === SAMPLE_PATTERNS_JOB) {
          await processSamplePatternsJob(job.data as SamplePatternsJobData, app.log);
          return;
        }

        if (job.name === CLEANUP_UPLOADS_JOB) {
          await processCleanupUploadsJob(
            job.data as CleanupUploadsJobData,
            app.log
          );
          return;
        }

        if (job.name === WATCHDOG_STUCK_SESSIONS_JOB) {
          await processWatchdogStuckSessionsJob(app.log);
          return;
        }

        throw new Error(`Unsupported job: ${job.name}`);
      },
      {
        connection: redisConnectionOptions(),
        concurrency: SITEMAP_WORKER_CONCURRENCY
      }
    );
    parseWorker.on("failed", (job, error) => {
      app.log.error(
        {
          job_id: job?.id,
          job_name: job?.name,
          ...jobDataContext(job?.data),
          error
        },
        "sitemap worker job failed"
      );
    });
    parseWorker.on("completed", (job) => {
      app.log.info(
        {
          job_id: job.id,
          job_name: job.name,
          ...jobDataContext(job.data)
        },
        "sitemap worker job acknowledged"
      );
    });
    bulkReplaceWorker = new Worker<
      BulkReplaceQueueData,
      void,
      BulkReplaceJobName
    >(
      BULK_REPLACE_QUEUE_NAME,
      async (job) => {
        if (job.name === BULK_REPLACE_JOB) {
          await processBulkReplaceJob(job.data as BulkReplaceJobData, app.log);
          return;
        }

        if (job.name === BULK_REPLACE_UNDO_JOB) {
          await processBulkReplaceUndoJob(
            job.data as BulkReplaceUndoJobData,
            app.log
          );
          return;
        }

        throw new Error(`Unsupported job: ${job.name}`);
      },
      {
        connection: redisConnectionOptions(),
        concurrency: 1
      }
    );
    bulkReplaceWorker.on("failed", (job, error) => {
      app.log.error(
        {
          job_id: job?.id,
          job_name: job?.name,
          session_id: (job?.data as { session_id?: string } | undefined)
            ?.session_id,
          error
        },
        "bulk replace worker job failed"
      );
    });
    await enqueueWatchdogStuckSessionsJob();
    await app.listen({
      port: config.workerHealthPort,
      host: "0.0.0.0"
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

async function close() {
  await parseWorker?.close();
  await bulkReplaceWorker?.close();
  await closeSitemapQueue();
  await closeBulkReplaceQueue();
  await app.close();
  await closePool();
}

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

void start();
