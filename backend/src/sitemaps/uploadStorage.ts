import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";

// Accounting of a session's upload blobs. READ-ONLY, and deliberately free of
// any database or queue import.
//
// The deletion half lives in uploadCleanup.ts. They were one module until
// importing it pulled the whole BullMQ queue graph (via sessionCompletion) into
// anything that only wanted to know a directory's size — which kept a Redis
// connection open and hung the test process. Reading sizes is pure filesystem
// work and now says so.

// Stored upload filenames are always "<session-uuid>-<role/marker...><name>", set
// by buildStoredUploadFilename. A UUID is a fixed 36 characters followed by the
// separating hyphen, which is what makes grouping by session a prefix read rather
// than a database join.
const UUID_LENGTH = 36;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UploadUsage = {
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

// Disk usage of every session that currently has blobs on disk, keyed by session
// id. ONE directory scan for all sessions rather than a scan per session: the
// History page lists dozens of sessions and a per-row scan would be O(sessions ×
// files) over a directory holding thousands of files.
export async function allSessionUploadUsage(): Promise<Map<string, UploadUsage>> {
  const entries = await readUploadDirEntries();
  const usage = new Map<string, UploadUsage>();

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const sessionId = sessionIdFromStoredFilename(entry.name);

    if (!sessionId) {
      continue;
    }

    let size: number;

    try {
      size = (await stat(path.join(config.uploadDir, entry.name))).size;
    } catch {
      // Raced with a deletion; it contributes nothing to current usage.
      continue;
    }

    const current = usage.get(sessionId) ?? { bytes: 0, file_count: 0 };

    current.bytes += size;
    current.file_count += 1;
    usage.set(sessionId, current);
  }

  return usage;
}

// Disk usage of one session. Used by the post-publish dialog, which must state
// the real number it is about to free rather than an estimate.
export async function sessionUploadUsage(
  sessionId: string
): Promise<UploadUsage> {
  const entries = await readUploadDirEntries();
  const prefix = `${sessionId.toLowerCase()}-`;
  const usage: UploadUsage = { bytes: 0, file_count: 0 };

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().startsWith(prefix)) {
      continue;
    }

    try {
      usage.bytes += (await stat(path.join(config.uploadDir, entry.name))).size;
      usage.file_count += 1;
    } catch {
      continue;
    }
  }

  return usage;
}
