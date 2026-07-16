import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  buildDeletedUrlsStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "./filenames.js";
import { removeUrlBlocksFromFile } from "./deleteUrls.js";
import { parseSitemapSource } from "./parser.js";

type CurrentFile = {
  id: string;
  filename: string;
  url_deletion_original_path: string | null;
  displayName: string;
};

export type DeletionProgress = (
  filesDone: number,
  filesTotal: number,
  urlsRemoved: number
) => Promise<void> | void;

// All local (on-disk) current sitemap files for a session, with their display
// label resolved once. URL-sourced rows (no local copy) are excluded — they
// cannot be edited.
async function loadCurrentFiles(sessionId: string): Promise<CurrentFile[]> {
  const result = await pool.query<{
    id: string;
    filename: string;
    url_deletion_original_path: string | null;
  }>(
    `
      SELECT id, filename, url_deletion_original_path
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
      ORDER BY filename ASC
    `,
    [sessionId]
  );

  return result.rows
    .filter((row) => !isHttpUrl(row.filename))
    .map((row) => ({
      ...row,
      displayName: displaySourceFilename(sessionId, row.filename)
    }));
}

// URLs currently marked deleted that apply to a given display file: either a
// global deletion (deleted_from_files IS NULL — the top-level "Delete URLs"
// job) or one explicitly scoped to this file (the per-file drawer flow).
async function deletedUrlsForFile(
  sessionId: string,
  displayName: string
): Promise<Set<string>> {
  const result = await pool.query<{ url: string }>(
    `
      SELECT s.url
      FROM sampled_urls s
      JOIN patterns p ON p.id = s.pattern_id
      WHERE p.session_id = $1
        AND s.is_deleted_from_sitemap = true
        AND (s.deleted_from_files IS NULL OR $2 = ANY(s.deleted_from_files))
    `,
    [sessionId, displayName]
  );

  return new Set(result.rows.map((row) => row.url));
}

async function repointToOriginal(file: CurrentFile) {
  const original = file.url_deletion_original_path ?? file.filename;
  const originalTotal = (await parseSitemapSource(original)).totalUrls;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE sitemap_files SET filename = $1, url_deletion_original_path = NULL, total_urls = $2 WHERE id = $3",
      [original, originalTotal, file.id]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Remove the now-orphaned edited copy — never the preserved original.
  if (file.filename !== original) {
    await unlink(path.join(config.uploadDir, file.filename)).catch(() => {});
  }
}

// Rebuild the given files (or every current file) from their originals to match
// the session's current deleted-set. Call after any change to the deleted-set.
// `scope`: an explicit list of display filenames, or "all" for every file.
export async function rebuildSessionDeletions(options: {
  sessionId: string;
  scope: "all" | string[];
  onProgress?: DeletionProgress;
}): Promise<{ filesChanged: number; urlsRemoved: number }> {
  const allFiles = await loadCurrentFiles(options.sessionId);
  const files =
    options.scope === "all"
      ? allFiles
      : allFiles.filter((file) =>
          (options.scope as string[]).includes(file.displayName)
        );

  let filesChanged = 0;
  let urlsRemoved = 0;
  let filesDone = 0;

  for (const file of files) {
    const original = file.url_deletion_original_path ?? file.filename;
    const originalPath = path.join(config.uploadDir, original);

    let exists = true;

    try {
      await access(originalPath);
    } catch {
      exists = false;
    }

    if (!exists) {
      filesDone += 1;
      await options.onProgress?.(filesDone, files.length, urlsRemoved);
      continue;
    }

    const deleted = await deletedUrlsForFile(options.sessionId, file.displayName);

    if (deleted.size === 0) {
      // No deletions remain for this file — restore it to its original.
      if (file.url_deletion_original_path) {
        await repointToOriginal(file);
        filesChanged += 1;
      }

      filesDone += 1;
      await options.onProgress?.(filesDone, files.length, urlsRemoved);
      continue;
    }

    const isGzip = original.toLowerCase().endsWith(".gz");
    const newStored = buildDeletedUrlsStoredFilename(
      options.sessionId,
      file.displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);

    let removedCount = 0;
    let keptCount = 0;

    try {
      const result = await removeUrlBlocksFromFile({
        inputPath: originalPath,
        outputPath,
        isGzip,
        targetUrls: deleted
      });
      removedCount = result.removedCount;
      keptCount = result.keptCount;
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    if (removedCount === 0) {
      // None of the deleted URLs are actually in this file — discard the copy
      // and make sure the file points at its clean original.
      await unlink(outputPath).catch(() => {});

      if (file.url_deletion_original_path) {
        await repointToOriginal(file);
        filesChanged += 1;
      }

      filesDone += 1;
      await options.onProgress?.(filesDone, files.length, urlsRemoved);
      continue;
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE sitemap_files SET filename = $1, url_deletion_original_path = $2, total_urls = $3 WHERE id = $4",
        [newStored, original, keptCount, file.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      await unlink(outputPath).catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Delete the previous edited copy (never the preserved original).
    if (file.filename !== original) {
      await unlink(path.join(config.uploadDir, file.filename)).catch(() => {});
    }

    filesChanged += 1;
    urlsRemoved += removedCount;
    filesDone += 1;
    await options.onProgress?.(filesDone, files.length, urlsRemoved);
  }

  return { filesChanged, urlsRemoved };
}
