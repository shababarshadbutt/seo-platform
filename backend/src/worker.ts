import Fastify from "fastify";
import { Worker } from "bullmq";

// Install the TLS policy (corporate SSL-proxy handling) before anything makes
// an outbound request. (v1.39 Fix 1)
import "./http/tlsDispatcher.js";
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
  APPLY_REDIRECTS_JOB,
  BULK_REPLACE_JOB,
  BULK_REPLACE_QUEUE_NAME,
  BULK_REPLACE_UNDO_JOB,
  closeBulkReplaceQueue,
  type ApplyRedirectsJobData,
  type BulkReplaceJobData,
  type BulkReplaceUndoJobData,
  type BulkReplaceQueueData,
  type BulkReplaceJobName
} from "./queue/bulkReplaceQueue.js";
import {
  DELETE_PROBLEM_URLS_JOB,
  FIX_TRAILING_SLASHES_JOB,
  FIX_TRAILING_SLASHES_UNDO_JOB,
  MAINTENANCE_QUEUE_NAME,
  RESTORE_DELETED_URLS_JOB,
  closeMaintenanceQueue,
  type DeleteProblemUrlsJobData,
  type FixTrailingSlashesJobData,
  type FixTrailingSlashesUndoJobData,
  type MaintenanceJobName,
  type MaintenanceQueueData,
  type RestoreDeletedUrlsJobData
} from "./queue/maintenanceQueue.js";
import {
  CLEANUP_ZIPS_JOB,
  PRE_GENERATE_ZIP_JOB,
  PRE_GENERATE_ZIP_QUEUE_NAME,
  closePreGenerateZipQueue,
  enqueueCleanupZipsJob,
  type PreGenerateZipJobData,
  type PreGenerateZipJobName,
  type PreGenerateZipQueueData
} from "./queue/preGenerateZipQueue.js";
import { redisConnectionOptions } from "./queue/redisConnection.js";
import {
  processBulkReplaceJob,
  processBulkReplaceUndoJob
} from "./jobs/bulkReplaceJob.js";
import { processApplyRedirectsJob } from "./jobs/applyRedirectsJob.js";
import {
  processCleanupZipsJob,
  processPreGenerateZipJob
} from "./jobs/preGenerateZipJob.js";
import {
  processDeleteProblemUrlsJob,
  processFixTrailingSlashesJob,
  processFixTrailingSlashesUndoJob,
  processRestoreDeletedUrlsJob
} from "./jobs/maintenanceJobs.js";
import { destroyZipPool } from "./jobs/zipPool.js";
import { destroyFileRewritePool } from "./jobs/fileRewritePool.js";
import { processCleanupUploadsJob } from "./jobs/cleanupUploadsJob.js";
import { processExtractPatternsJob } from "./jobs/extractPatternsJob.js";
import { processParseSitemapJob } from "./jobs/parseSitemapJob.js";
import { processSamplePatternsJob } from "./jobs/samplePatternsJob.js";
import { processWatchdogStuckSessionsJob } from "./jobs/watchdogStuckSessionsJob.js";

// Parse/extract/sample jobs run here. Raised 5 → 10 so large sessions (hundreds
// of independent per-file parse jobs) drain the queue about twice as fast
// (v1.33 Fix 2).
const SITEMAP_WORKER_CONCURRENCY = 10;

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
// Session-level maintenance (bulk URL delete/restore, trailing-slash fix/undo)
// on its own concurrency-1 queue, same isolation rationale as bulk replace.
let maintenanceWorker: Worker<
  MaintenanceQueueData,
  void,
  MaintenanceJobName
> | null = null;
// Download-ZIP pre-generation + daily cleanup on its own concurrency-1 queue, so
// a heavy 1000-file archive write never starves the other workers.
let preGenerateZipWorker: Worker<
  PreGenerateZipQueueData,
  void,
  PreGenerateZipJobName
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

        if (job.name === APPLY_REDIRECTS_JOB) {
          await processApplyRedirectsJob(
            job.data as ApplyRedirectsJobData,
            app.log
          );
          return;
        }

        throw new Error(`Unsupported job: ${job.name}`);
      },
      {
        connection: redisConnectionOptions(),
        concurrency: 1,
        // Bulk replace can run for tens of minutes on 900+ file sessions. The
        // default 30s job lock expires long before it finishes (the event loop
        // is busy rewriting files), so BullMQ wrongly declares the job stalled
        // and re-runs / fails it. A 60-minute lock covers the longest realistic
        // run. (v1.32)
        lockDuration: 60 * 60 * 1000
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
    maintenanceWorker = new Worker<
      MaintenanceQueueData,
      void,
      MaintenanceJobName
    >(
      MAINTENANCE_QUEUE_NAME,
      async (job) => {
        if (job.name === DELETE_PROBLEM_URLS_JOB) {
          await processDeleteProblemUrlsJob(
            job.data as DeleteProblemUrlsJobData,
            app.log
          );
          return;
        }

        if (job.name === RESTORE_DELETED_URLS_JOB) {
          await processRestoreDeletedUrlsJob(
            job.data as RestoreDeletedUrlsJobData,
            app.log
          );
          return;
        }

        if (job.name === FIX_TRAILING_SLASHES_JOB) {
          await processFixTrailingSlashesJob(
            job.data as FixTrailingSlashesJobData,
            app.log
          );
          return;
        }

        if (job.name === FIX_TRAILING_SLASHES_UNDO_JOB) {
          await processFixTrailingSlashesUndoJob(
            job.data as FixTrailingSlashesUndoJobData,
            app.log
          );
          return;
        }

        throw new Error(`Unsupported job: ${job.name}`);
      },
      {
        connection: redisConnectionOptions(),
        concurrency: 1,
        // Trailing-slash fix / URL delete on 900+ file sessions runs for many
        // minutes. Without a long lock the default 30s expires mid-run, BullMQ
        // marks the job stalled, and it gets re-run or failed even though the
        // original execution is still working — which is how a fix could stamp
        // trailing_slash_fixed_at without actually completing. 60-minute lock.
        // (v1.32)
        lockDuration: 60 * 60 * 1000
      }
    );
    maintenanceWorker.on("failed", (job, error) => {
      app.log.error(
        {
          job_id: job?.id,
          job_name: job?.name,
          session_id: (job?.data as { session_id?: string } | undefined)
            ?.session_id,
          error
        },
        "maintenance worker job failed"
      );
    });
    preGenerateZipWorker = new Worker<
      PreGenerateZipQueueData,
      void,
      PreGenerateZipJobName
    >(
      PRE_GENERATE_ZIP_QUEUE_NAME,
      async (job) => {
        if (job.name === PRE_GENERATE_ZIP_JOB) {
          await processPreGenerateZipJob(
            job.data as PreGenerateZipJobData,
            app.log
          );
          return;
        }

        if (job.name === CLEANUP_ZIPS_JOB) {
          await processCleanupZipsJob(app.log);
          return;
        }

        throw new Error(`Unsupported job: ${job.name}`);
      },
      {
        connection: redisConnectionOptions(),
        concurrency: 1
      }
    );
    preGenerateZipWorker.on("failed", (job, error) => {
      app.log.error(
        {
          job_id: job?.id,
          job_name: job?.name,
          session_id: (job?.data as { session_id?: string } | undefined)
            ?.session_id,
          error
        },
        "pre-generate-zip worker job failed"
      );
    });
    await enqueueWatchdogStuckSessionsJob();
    await enqueueCleanupZipsJob();
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
  await maintenanceWorker?.close();
  await preGenerateZipWorker?.close();
  await destroyZipPool();
  await destroyFileRewritePool();
  await closeSitemapQueue();
  await closeBulkReplaceQueue();
  await closeMaintenanceQueue();
  await closePreGenerateZipQueue();
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
