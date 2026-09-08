import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import type { ExportUsage } from "./exportStorage.js";

async function readExportDirEntries() {
  try {
    return await readdir(config.exportDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

// Deletion of a session's export blobs: the exportDir counterpart to
// uploadCleanup.ts's deleteSessionUploads. Two sources, mirroring
// exportStorage.ts's accounting:
//   - filename-prefixed entries in exportDir (pre-generated ZIPs and
//     transform-sample files, named "<session-uuid>-...")
//   - rows in the `exports` table (CSV/XLSX/PDF reports, named from the
//     session's display name, so only findable via file_path)
//
// Called from the SAME two trigger points as deleteSessionUploads (the manual
// "reclaim storage" route and the 48h safety-net job) so uploads and exports
// are always reclaimed together as one action, rather than two that can drift
// apart — before this, exports/ was never touched by anything.
//
// SCOPE: file blobs and the `exports` table rows that pointed at them (a row
// with no backing file is nothing but a stale download link). sessions,
// sitemap_files and patterns are untouched, exactly like uploads cleanup.
export async function deleteSessionExports(
  sessionId: string,
  logger: FastifyBaseLogger,
  trigger: "user" | "safety-net"
): Promise<ExportUsage> {
  const freed: ExportUsage = { bytes: 0, file_count: 0 };
  const entries = await readExportDirEntries();
  const prefix = `${sessionId.toLowerCase()}-`;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith(prefix)) {
      continue;
    }

    const entryPath = path.join(config.exportDir, entry.name);
    let size = 0;

    try {
      size = (await stat(entryPath)).size;
    } catch {
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

  const reportRows = await pool.query<{ id: string; file_path: string }>(
    "SELECT id, file_path FROM exports WHERE session_id = $1::uuid",
    [sessionId]
  );

  for (const row of reportRows.rows) {
    let size = 0;

    try {
      size = (await stat(row.file_path)).size;
    } catch {
      continue;
    }

    try {
      await unlink(row.file_path);
      freed.bytes += size;
      freed.file_count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // Every report row for this session is stale after the pass above (its file
  // is gone whether the unlink ran, raced with a prior deletion, or was
  // already missing) — so the whole set is dropped rather than only the ones
  // this call actually unlinked.
  await pool.query("DELETE FROM exports WHERE session_id = $1::uuid", [
    sessionId
  ]);

  logger.info(
    {
      session_id: sessionId,
      trigger,
      freed_bytes: freed.bytes,
      freed_file_count: freed.file_count
    },
    "session export files cleaned"
  );

  return freed;
}
