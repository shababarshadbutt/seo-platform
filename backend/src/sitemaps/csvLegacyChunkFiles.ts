import { unlink } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { runSitemapGenerateJob } from "../jobs/sitemapGeneratePool.js";
import type { SitemapGenerateUrl } from "../workers/sitemapGenerateWorker.js";
import { buildStoredUploadFilename } from "./filenames.js";
import { createStoredSitemapFile } from "./ingest.js";

// Writes the sitemap-regenerate wizard's CSV-derived URL list as several
// 'legacy' sitemap_files rows instead of one giant synthetic file, so the
// write itself runs in parallel across the existing sitemapGeneratePool
// worker threads (the same pool the wizard's own "Output files" step already
// uses via sitemapChunkFiles.ts's writeSitemapChunks) instead of blocking the
// caller building one huge in-memory XML string on the main thread.
//
// Downstream (extractPatternsJob.ts, samplePatternsJob.ts) already scopes
// every query by session_id + source_role across ALL matching sitemap_files
// rows, not a single file id, so N legacy chunks here are mechanically
// identical to the N 'current' files an ordinary S3 pull already produces —
// no changes needed there.
//
// Atomic from the caller's point of view, same contract as
// writeSitemapChunks: on any failure (a chunk's disk write, or a later
// chunk's DB insert), every chunk file this call wrote is unlinked, and any
// sitemap_files rows already inserted this call are deleted, before the
// error is rethrown — a failed ingest leaves zero legacy rows behind.

export type WrittenCsvLegacyChunk = {
  sitemap_file_id: string;
  urlCount: number;
};

export async function writeCsvLegacyChunks(
  sessionId: string,
  chunks: string[][],
  onChunkWritten?: (
    filesDone: number,
    urlsWritten: number
  ) => Promise<void> | void
): Promise<WrittenCsvLegacyChunk[]> {
  const planned = chunks.map((urls, index) => {
    const displayName = `csv-urls-${String(index + 1).padStart(4, "0")}.xml`;
    const storedFilename = buildStoredUploadFilename(
      sessionId,
      displayName,
      "legacy"
    );

    return {
      urls,
      displayName,
      storedFilename,
      outputPath: path.join(config.uploadDir, storedFilename),
      generateUrls: urls.map(
        (loc): SitemapGenerateUrl => ({ loc, lastmod: null })
      )
    };
  });

  async function cleanupWrittenFiles() {
    await Promise.all(
      planned.map((entry) => unlink(entry.outputPath).catch(() => {}))
    );
  }

  let filesDone = 0;
  let urlsWritten = 0;

  const settled = await Promise.allSettled(
    planned.map((entry) =>
      runSitemapGenerateJob({
        outputPath: entry.outputPath,
        urls: entry.generateUrls
      }).then(async (result) => {
        filesDone += 1;
        urlsWritten += result.writtenCount;
        await onChunkWritten?.(filesDone, urlsWritten);
      })
    )
  );

  const failure = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected"
  );

  if (failure) {
    await cleanupWrittenFiles();
    throw failure.reason;
  }

  const written: WrittenCsvLegacyChunk[] = [];

  try {
    for (const entry of planned) {
      const stored = await createStoredSitemapFile(
        sessionId,
        entry.storedFilename,
        "legacy",
        entry.displayName
      );

      written.push({
        sitemap_file_id: stored.sitemap_file_id,
        urlCount: entry.urls.length
      });
    }
  } catch (error) {
    await cleanupWrittenFiles();

    if (written.length > 0) {
      await pool.query("DELETE FROM sitemap_files WHERE id = ANY($1::uuid[])", [
        written.map((entry) => entry.sitemap_file_id)
      ]);
    }

    throw error;
  }

  return written;
}
