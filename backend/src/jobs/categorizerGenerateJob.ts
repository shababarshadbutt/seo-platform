import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { runSitemapGenerateJob } from "./sitemapGeneratePool.js";
import { renderCategoryChunkFilename } from "../sitemaps/categoryOutputFilename.js";
import { buildCategorizerSitemapIndexXml } from "../sitemaps/categorizerIndex.js";
import {
  enqueueCategorizerGenerateJob,
  type CategorizerGenerateJobData
} from "../queue/categorizerQueue.js";
import {
  latestCategorizerJob,
  markCategorizerJobComplete,
  markCategorizerJobRunning,
  startOrResumeCategorizerJob,
  updateCategorizerJobCheckpoint,
  updateCategorizerSessionStatus
} from "./categorizerJobState.js";

// Generate phase: chunk every categorized, non-404 URL into output sitemap
// files (<=session.max_urls_per_file each, first chunk per category
// unsuffixed, overflow numbered — categoryOutputFilename.ts) and a
// sitemap-index.xml referencing all of them.
//
// RESUMABLE WITHOUT A SEPARATE COMPLETION LIST. A URL's own
// categorizer_urls.output_file column IS the "already written" marker
// (NULL = not yet chunked into a file) — so a resumed run just re-queries
// "WHERE output_file IS NULL" per category rather than tracking completed
// chunks in the checkpoint. The next chunk's number for a category is
// likewise re-derived from categorizer_output_files (MAX(chunk_index) + 1),
// not carried in the checkpoint, so the two sources of truth can't drift.
//
// The one window where output_file and categorizer_output_files COULD
// briefly disagree is between writing a chunk file to disk and the DB
// transaction that records it — a crash in that narrow window leaves an
// orphaned, unreferenced file on disk (harmless: it's never in the index or
// the zip) and the chunk is simply rewritten under a fresh chunk_index on
// resume. The file write and the two DB writes that make a chunk "done" are
// wrapped in one transaction so they can't disagree about HALF of a chunk
// being recorded.

type CategorizerSessionRow = {
  id: string;
  base_url: string;
  max_urls_per_file: number;
};

type GenerateCheckpoint = {
  category?: string;
};

export async function processCategorizerGenerateJob(
  data: CategorizerGenerateJobData,
  logger: FastifyBaseLogger,
  job?: Job
) {
  const { session_id: sessionId } = data;

  const sessionResult = await pool.query<CategorizerSessionRow>(
    "SELECT id, base_url, max_urls_per_file FROM categorizer_sessions WHERE id = $1",
    [sessionId]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new Error(`Categorizer session not found: ${sessionId}`);
  }

  const categorizeJob = await latestCategorizerJob(sessionId, "categorize");

  if (!categorizeJob || categorizeJob.status !== "COMPLETE") {
    throw new Error(
      "Cannot generate before the categorize phase has completed for this session"
    );
  }

  const jobRow = await startOrResumeCategorizerJob(sessionId, "generate");

  await updateCategorizerSessionStatus(sessionId, "GENERATING");
  await mkdir(config.exportDir, { recursive: true });

  const totalResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categorizer_urls
     WHERE session_id = $1 AND category_state = 'categorized'`,
    [sessionId]
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);

  await markCategorizerJobRunning(jobRow.id, total);

  const categoriesResult = await pool.query<{ category: string }>(
    `SELECT DISTINCT category FROM categorizer_urls
     WHERE session_id = $1 AND category_state = 'categorized'
     ORDER BY category`,
    [sessionId]
  );
  const categories = categoriesResult.rows.map((row) => row.category);

  const chunkDeadlineMs = Date.now() + config.categorizerCrawl.chunkMinutes * 60 * 1000;
  let doneCount = jobRow.items_done;

  for (const category of categories) {
    for (;;) {
      if (Date.now() > chunkDeadlineMs) {
        await enqueueCategorizerGenerateJob({ session_id: sessionId });
        logger.info(
          { session_id: sessionId, category, done: doneCount, total },
          "categorizer generate: chunk time box reached, continuation enqueued"
        );

        return { continued: true, done: doneCount, total };
      }

      const batch = await pool.query<{ id: string; url: string }>(
        `
          SELECT id::text AS id, url
          FROM categorizer_urls
          WHERE session_id = $1 AND category = $2 AND output_file IS NULL
          ORDER BY id
          LIMIT $3
        `,
        [sessionId, category, session.max_urls_per_file]
      );

      if (batch.rows.length === 0) {
        break;
      }

      const nextChunkResult = await pool.query<{ next: string }>(
        `SELECT COALESCE(MAX(chunk_index), 0) + 1 AS next
         FROM categorizer_output_files
         WHERE session_id = $1 AND category = $2`,
        [sessionId, category]
      );
      const chunkIndex = Number(nextChunkResult.rows[0]?.next ?? 1);
      const filename = renderCategoryChunkFilename(category, chunkIndex);
      const storedFilename = `categorizer-${sessionId}-${filename}`;
      const outputPath = path.join(config.exportDir, storedFilename);

      await runSitemapGenerateJob({
        outputPath,
        urls: batch.rows.map((row) => ({ loc: row.url, lastmod: null }))
      });

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE categorizer_urls SET output_file = $3
           WHERE session_id = $1 AND id = ANY($2::bigint[])`,
          [sessionId, batch.rows.map((row) => row.id), filename]
        );
        await client.query(
          `
            INSERT INTO categorizer_output_files
              (session_id, category, chunk_index, filename, url_count, stored_path, written_at)
            VALUES ($1, $2, $3, $4, $5, $6, now())
            ON CONFLICT (session_id, category, chunk_index) DO UPDATE SET
              filename = EXCLUDED.filename,
              url_count = EXCLUDED.url_count,
              stored_path = EXCLUDED.stored_path,
              written_at = now()
          `,
          [sessionId, category, chunkIndex, filename, batch.rows.length, storedFilename]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      doneCount += batch.rows.length;

      const checkpoint: GenerateCheckpoint = { category };

      await updateCategorizerJobCheckpoint(jobRow.id, checkpoint, doneCount);
      await job?.updateProgress({
        stage: "generate",
        current: doneCount,
        total,
        message: `Wrote ${filename} (${doneCount} of ${total} URL(s))`
      });
    }
  }

  const outputFilesResult = await pool.query<{ filename: string }>(
    `SELECT filename FROM categorizer_output_files
     WHERE session_id = $1
     ORDER BY category, chunk_index`,
    [sessionId]
  );

  const indexXml = buildCategorizerSitemapIndexXml({
    baseUrl: session.base_url,
    displayNames: outputFilesResult.rows.map((row) => row.filename),
    today: new Date().toISOString().slice(0, 10)
  });
  const indexStoredFilename = `categorizer-${sessionId}-sitemap-index.xml`;

  await writeFile(path.join(config.exportDir, indexStoredFilename), indexXml, "utf8");

  await markCategorizerJobComplete(jobRow.id);
  await updateCategorizerSessionStatus(sessionId, "COMPLETE");

  logger.info(
    {
      session_id: sessionId,
      total,
      done: doneCount,
      files: outputFilesResult.rows.length
    },
    "categorizer generate complete"
  );

  return { done: doneCount, total, files: outputFilesResult.rows.length };
}
