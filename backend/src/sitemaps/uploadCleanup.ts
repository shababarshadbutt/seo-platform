import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { resetParsedSitemapCount } from "../jobs/sessionCompletion.js";
import type { UploadUsage } from "./uploadStorage.js";

// Deletion of a session's upload blobs. The read-only accounting side is in
// uploadStorage.ts, which stays free of database and queue imports.
//
// ONE mechanism, deliberately. There are two ways a session's files get reclaimed
// — the delayed safety-net job and an explicit user-confirmed request — and they
// must not be two implementations of "delete a session's files". Both call
// deleteSessionUploads() below, so what the History page reports, what the
// post-publish dialog frees, and what the timer eventually removes can never
// disagree about scope.
//
// SCOPE: file blobs in the uploads directory only. No database row, no
// sitemap_files record, no pattern, no history is touched. A cleaned session is
// still fully browsable and still has its reports; what it loses is Undo (the
// original bytes are what undo restores) and the ability to publish or re-download
// without re-ingesting.

async function readUploadDirEntries() {
  try {
    return await readdir(config.uploadDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

// Delete one session's upload blobs and stamp uploads_cleaned_at.
//
// The ONLY place files are removed for a session — the delayed job and the
// explicit route both come here. Returns what was actually freed so a caller can
// report a real figure instead of the estimate it showed beforehand.
export async function deleteSessionUploads(
  sessionId: string,
  logger: FastifyBaseLogger,
  // What triggered this, for the log line: an explicit user action and a timer
  // firing on a forgotten session are very different events to read back later.
  trigger: "user" | "safety-net"
): Promise<UploadUsage> {
  const entries = await readUploadDirEntries();
  const prefix = `${sessionId.toLowerCase()}-`;
  const freed: UploadUsage = { bytes: 0, file_count: 0 };

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith(prefix)) {
      continue;
    }

    const entryPath = path.join(config.uploadDir, entry.name);
    let size = 0;

    try {
      size = (await stat(entryPath)).size;
    } catch {
      // Already gone; nothing to free and nothing to unlink.
      continue;
    }

    try {
      await unlink(entryPath);
      freed.bytes += size;
      freed.file_count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Deliberately NOT part of a transaction with anything, and deliberately not a
  // DELETE: the session row, its sitemap_files rows, its patterns and its reports
  // all stay. This column is the record that the blobs are gone, which is what
  // the publish path checks before it refuses.
  await pool.query(
    "UPDATE sessions SET uploads_cleaned_at = NOW() WHERE id = $1::uuid",
    [sessionId]
  );

  // The Redis parsed-count key is derived state about files that no longer exist.
  await resetParsedSitemapCount(sessionId);

  logger.info(
    {
      session_id: sessionId,
      trigger,
      freed_bytes: freed.bytes,
      freed_file_count: freed.file_count
    },
    "session upload files cleaned"
  );

  return freed;
}
