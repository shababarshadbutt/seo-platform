import { unlink } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { parseCsvUrlList, type SkippedCsvRow } from "../sitemaps/csvUrlList.js";
import { writeCsvLegacyChunks } from "../sitemaps/csvLegacyChunkFiles.js";
import { DEFAULT_URLS_PER_FILE } from "../sitemaps/maxUrlsPerFile.js";
import { enqueueParseSitemapJobs } from "../queue/sitemapQueue.js";
import type { CsvUploadIngestJobData } from "../queue/maintenanceQueue.js";

// Background job for the sitemap-regenerate wizard's CSV upload
// (routes/sessions.ts's POST csv-upload). Moved off the HTTP request because
// parsing + building the synthetic sitemap XML for a 1M+ row CSV used to run
// entirely synchronously inside the request handler — long enough, with zero
// yields, to block the whole API process's event loop (the "stuck on
// Uploading..." bug). Modeled on jobs/maintenanceJobs.ts's
// processRestoreDeletedUrlsJob/progress-flush convention, with its own
// mark*/progress helpers since this job also needs to persist the
// `skipped` jsonb column on both the COMPLETE and FAILED paths (the shared
// helpers in maintenanceJobs.ts are file-private and don't).

type Skipped = { count: number; sample: SkippedCsvRow[] };

async function markRunning(jobRowId: string) {
  await pool.query("UPDATE maintenance_jobs SET status = 'RUNNING' WHERE id = $1", [
    jobRowId
  ]);
}

async function markChunking(jobRowId: string, filesTotal: number) {
  await pool.query(
    "UPDATE maintenance_jobs SET files_total = $2, files_done = 0 WHERE id = $1",
    [jobRowId, filesTotal]
  );
}

async function markProgress(
  jobRowId: string,
  filesDone: number,
  urlsWritten: number
) {
  await pool.query(
    "UPDATE maintenance_jobs SET files_done = $2, items_changed = $3 WHERE id = $1",
    [jobRowId, filesDone, urlsWritten]
  );
}

async function markComplete(jobRowId: string, skipped: Skipped) {
  await pool.query(
    `
      UPDATE maintenance_jobs
      SET status = 'COMPLETE', completed_at = now(), skipped = $2
      WHERE id = $1
    `,
    [jobRowId, skipped.count > 0 ? JSON.stringify(skipped) : null]
  );
}

async function markFailed(jobRowId: string, message: string, skipped?: Skipped) {
  await pool.query(
    `
      UPDATE maintenance_jobs
      SET status = 'FAILED', error = $2, skipped = $3
      WHERE id = $1
    `,
    [jobRowId, message, skipped && skipped.count > 0 ? JSON.stringify(skipped) : null]
  );
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }

  return chunks;
}

export async function processCsvUploadIngestJob(
  data: CsvUploadIngestJobData,
  logger: FastifyBaseLogger
): Promise<void> {
  const {
    session_id: sessionId,
    job_row_id: jobRowId,
    csv_temp_path: csvTempPath
  } = data;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId },
    "csv upload ingest job started"
  );

  try {
    await markRunning(jobRowId);

    const { urls, skippedCount, skippedSample } =
      await parseCsvUrlList(csvTempPath);

    await unlink(csvTempPath).catch(() => {});

    const skipped: Skipped = { count: skippedCount, sample: skippedSample };

    if (urls.length === 0) {
      await markFailed(jobRowId, "No valid URLs were found in the CSV.", skipped);
      return;
    }

    const chunks = chunkArray(urls, DEFAULT_URLS_PER_FILE);

    await markChunking(jobRowId, chunks.length);

    const written = await writeCsvLegacyChunks(sessionId, chunks, (filesDone, urlsWritten) =>
      markProgress(jobRowId, filesDone, urlsWritten)
    );

    await enqueueParseSitemapJobs(
      written.map((chunk) => ({
        sitemap_file_id: chunk.sitemap_file_id,
        session_id: sessionId
      }))
    );

    await markComplete(jobRowId, skipped);

    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        files: written.length,
        urls: urls.length,
        skipped_count: skippedCount
      },
      "csv upload ingest job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await markFailed(jobRowId, message);
    throw error;
  }
}
