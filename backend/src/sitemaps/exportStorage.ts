import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";

// Accounting of a session's export blobs. READ-ONLY, mirrors uploadStorage.ts.
//
// Two sources, because export files come from two different naming schemes:
//   - Pre-generated ZIPs and transform-sample files are named
//     "<session-uuid>-...", the same convention as uploads (see
//     jobs/preGenerateZipJob.ts), so they're found by filename prefix.
//   - CSV/XLSX/PDF report files are named from the session's DISPLAY NAME, not
//     its UUID (see exports/sessionExports.ts:exportFilename), so they can
//     only be found via the `exports` table's file_path column.
//
// Unlike uploadStorage.ts this module does query the database — there's no
// way to attribute a report file to a session from its filename alone.

const UUID_LENGTH = 36;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExportUsage = {
  bytes: number;
  file_count: number;
};

function sessionIdFromStoredFilename(filename: string): string | null {
  if (filename.length <= UUID_LENGTH || filename[UUID_LENGTH] !== "-") {
    return null;
  }

  const candidate = filename.slice(0, UUID_LENGTH);

  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

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

function addUsage(
  usage: Map<string, ExportUsage>,
  sessionId: string,
  bytes: number
) {
  const current = usage.get(sessionId) ?? { bytes: 0, file_count: 0 };

  current.bytes += bytes;
  current.file_count += 1;
  usage.set(sessionId, current);
}

// Export usage of every session that currently has export blobs on disk,
// keyed by lowercased session id. ONE directory scan + ONE table scan for
// every session, not a query per session (same reasoning as
// allSessionUploadUsage: the History page lists dozens of sessions).
export async function allSessionExportUsage(): Promise<Map<string, ExportUsage>> {
  const usage = new Map<string, ExportUsage>();
  const entries = await readExportDirEntries();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const sessionId = sessionIdFromStoredFilename(entry.name);

    if (!sessionId) {
      continue;
    }

    try {
      const size = (await stat(path.join(config.exportDir, entry.name))).size;

      addUsage(usage, sessionId, size);
    } catch {
      // Raced with a deletion; contributes nothing to current usage.
      continue;
    }
  }

  const reportRows = await pool.query<{ session_id: string; file_path: string }>(
    "SELECT session_id, file_path FROM exports"
  );

  for (const row of reportRows.rows) {
    try {
      const size = (await stat(row.file_path)).size;

      addUsage(usage, row.session_id.toLowerCase(), size);
    } catch {
      continue;
    }
  }

  return usage;
}

// One session's export usage. Used by the post-publish "what will this free"
// prompt and the manual reclaim endpoint's response, alongside
// sessionUploadUsage.
export async function sessionExportUsage(
  sessionId: string
): Promise<ExportUsage> {
  const usage: ExportUsage = { bytes: 0, file_count: 0 };
  const entries = await readExportDirEntries();
  const prefix = `${sessionId.toLowerCase()}-`;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith(prefix)) {
      continue;
    }

    try {
      usage.bytes += (await stat(path.join(config.exportDir, entry.name))).size;
      usage.file_count += 1;
    } catch {
      continue;
    }
  }

  const reportRows = await pool.query<{ file_path: string }>(
    "SELECT file_path FROM exports WHERE session_id = $1::uuid",
    [sessionId]
  );

  for (const row of reportRows.rows) {
    try {
      usage.bytes += (await stat(row.file_path)).size;
      usage.file_count += 1;
    } catch {
      continue;
    }
  }

  return usage;
}
