import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";

import type { PoolClient } from "pg";

import { config } from "../config.js";
import { runSitemapGenerateJob } from "../jobs/sitemapGeneratePool.js";
import type { SitemapGenerateUrl } from "../workers/sitemapGenerateWorker.js";
import { buildGeneratedSitemapStoredFilename } from "./filenames.js";

// Writing the sitemap-regenerate wizard's brand-new chunk files and inserting
// their sitemap_files rows. Deliberately its own module rather than a branch
// of lastmodFileRewrites.ts: that helper rewrites an EXISTING file
// copy-on-write and repoints one row's filename; this one has no source file
// at all (every chunk is synthesized from the resolved URL list) and always
// INSERTs a fresh row.
//
// Atomic from the caller's point of view: on any failure (a chunk's disk
// write, or a later chunk's DB insert), every chunk file this call wrote is
// unlinked before the error is rethrown — the caller's transaction rollback
// then has nothing on disk left to reconcile.

export type SitemapChunkPlan = {
  // The real production filename this chunk will publish under, e.g.
  // "sitemap-1.xml" or "niin/rfq-1.xml" — from outputFilenamePattern.ts.
  displayFilename: string;
  urls: SitemapGenerateUrl[];
};

export type WrittenSitemapChunk = {
  sitemap_file_id: string;
  displayFilename: string;
  urlCount: number;
  // The caller's own outer safety net (a COMMIT that fails AFTER this call
  // returns) needs these to unlink files whose rows never made it to disk in
  // the database's eyes — everything up to that point is already handled
  // internally by this function's own cleanup.
  localPath: string;
};

export async function writeSitemapChunks(
  client: PoolClient,
  sessionId: string,
  chunks: SitemapChunkPlan[]
): Promise<WrittenSitemapChunk[]> {
  // One token for every chunk in this run, so a retry after a failure never
  // collides with stale output from an earlier attempt at the same template.
  const token = randomUUID();
  const planned = chunks.map((chunk) => {
    const storedFilename = buildGeneratedSitemapStoredFilename(
      sessionId,
      chunk.displayFilename,
      token
    );

    return {
      chunk,
      storedFilename,
      outputPath: path.join(config.uploadDir, storedFilename)
    };
  });

  async function cleanupWrittenFiles() {
    await Promise.all(
      planned.map((entry) => unlink(entry.outputPath).catch(() => {}))
    );
  }

  const settled = await Promise.allSettled(
    planned.map((entry) =>
      runSitemapGenerateJob({ outputPath: entry.outputPath, urls: entry.chunk.urls })
    )
  );
  const failure = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected"
  );

  if (failure) {
    await cleanupWrittenFiles();
    throw failure.reason;
  }

  const written: WrittenSitemapChunk[] = [];

  try {
    for (const entry of planned) {
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO sitemap_files (
            session_id, filename, total_urls, parsed_at, is_valid, is_empty,
            is_index, source_role, original_filename, is_regenerate_output
          )
          VALUES ($1, $2, $3, now(), TRUE, $4, FALSE, 'current', $5, TRUE)
          RETURNING id
        `,
        [
          sessionId,
          entry.storedFilename,
          entry.chunk.urls.length,
          entry.chunk.urls.length === 0,
          entry.chunk.displayFilename
        ]
      );

      written.push({
        sitemap_file_id: inserted.rows[0].id,
        displayFilename: entry.chunk.displayFilename,
        urlCount: entry.chunk.urls.length,
        localPath: entry.outputPath
      });
    }
  } catch (error) {
    await cleanupWrittenFiles();
    throw error;
  }

  return written;
}
