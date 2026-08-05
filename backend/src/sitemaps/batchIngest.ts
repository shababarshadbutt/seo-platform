import { randomUUID } from "node:crypto";
import { access, copyFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "./boundedConcurrency.js";
import { buildStoredUploadFilename } from "./filenames.js";
import { createStoredSitemapFile } from "./ingest.js";
import type { SitemapSourceRole } from "./ingest.js";

// Copy a set of already-on-disk sitemap files into a session's storage and ingest
// them, with BOUNDED PARALLELISM.
//
// WHY. The Cleaner -> Migration handoff did this in one sequential `for` loop
// inside the HTTP request. Each iteration is three serial I/O round trips —
// copyFile, a root-element peek, one INSERT — so the cost is per file and strictly
// additive: measured 15.6ms/file for ~1KB files and 30ms/file at ~230KB, i.e.
// minutes for a few thousand files, and the request has no way to say how far it
// got. Nothing on the backend aborts it (Fastify leaves server.timeout and
// requestTimeout at 0), but undici in the frontend's proxy gives up waiting for
// response headers after 300s and reports `TypeError: fetch failed`, which the
// proxy turns into a 502 whose body is the bare string "fetch failed".
//
// The worker-pool shape here is deliberately the same as downloadSftpFiles: a
// shared cursor consumed by N workers, progress reported by COMPLETION COUNT
// rather than index (parallel workers finish out of order, and a bar driven by
// indexes jumps around), and an index-aligned outcome array so callers can pair
// results with inputs.

export type IngestSourceFile = {
  // Absolute path of the file to copy FROM. It is left in place — the Cleaner run
  // keeps serving its ZIP until its TTL expires.
  path: string;
  // The display filename to ingest under.
  filename: string;
};

export type IngestOutcome = {
  filename: string;
  storedFilename: string;
  ok: boolean;
  // True when this file was ALREADY ingested for this session and was left alone.
  // Counts as success — the file is present and its row exists.
  skipped?: boolean;
  error?: unknown;
};

// Concurrency for the copy+insert pipeline. Four is the same ceiling the file
// rewrite pool uses: enough to keep the disk and a pooled connection busy while
// staying well inside the 10-connection DB pool, so an ingest can never starve
// the API of connections. Each unit of work holds at most one connection, and
// only for the INSERT.
export const INGEST_CONCURRENCY = 4;

// Every stored filename this session already holds for `sourceRole`. Deliberately
// NOT filtered by is_deleted: a soft-deleted file's row still exists, and a retry
// must not resurrect something the user deliberately deleted.
async function existingStoredFilenames(
  sessionId: string,
  sourceRole: string
): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1 AND source_role = $2",
    [sessionId, sourceRole]
  );

  return new Set(result.rows.map((row) => row.filename));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

export async function ingestFilesIntoSession(options: {
  sessionId: string;
  files: IngestSourceFile[];
  sourceRole?: SitemapSourceRole;
  concurrency?: number;
  // Awaited, not fire-and-forget: an unordered progress write can land after the
  // terminal one and clobber it — a defect already found on the publish path, so
  // the same discipline applies here.
  onSettled?: (
    outcome: IngestOutcome,
    completed: number,
    total: number
  ) => void | Promise<void>;
}): Promise<IngestOutcome[]> {
  const sourceRole = options.sourceRole ?? "current";

  // RESUME, rather than redoing everything a previous attempt already finished.
  //
  // Measured before this existed: retrying an 801-file handoff re-copied all 801
  // files and spent the same 6.2s doing it, for zero effect — every row already
  // existed (createStoredSitemapFile is idempotent per (session_id, filename), and
  // buildStoredUploadFilename is deterministic, so the second pass wrote the same
  // names and ON CONFLICT DO NOTHING swallowed all 801 inserts). The DB stayed
  // correct; the I/O was pure waste, and it is the per-file DB round trip that
  // dominates the cost, so the waste scales with the whole file set on every retry.
  //
  // ONE query up front instead of a per-file check: for a few thousand short
  // filenames this is a single round trip, where per-file existence checks would
  // reintroduce exactly the pattern being removed.
  const existing = await existingStoredFilenames(options.sessionId, sourceRole);

  return runWithBoundedConcurrency(
    options.files,
    options.concurrency ?? INGEST_CONCURRENCY,
    async (file): Promise<IngestOutcome> => {
      const storedFilename = buildStoredUploadFilename(
        options.sessionId,
        file.filename,
        sourceRole
      );
      const destination = path.join(config.uploadDir, storedFilename);

      // Skip only when the row AND the file are both there. A row alone is not
      // enough: the copy happens before the insert, so a row implies the copy
      // succeeded once, but the file can be gone afterwards (upload cleanup reaps
      // old uploads), and skipping then would leave a row pointing at nothing.
      // The stat is ~100x cheaper than the copy + round trip it avoids.
      //
      // This test is only sound because of the write-to-temp-then-rename below: a
      // file at its real path is ALWAYS complete, so existence is a truthful
      // completeness signal.
      if (existing.has(storedFilename) && (await fileExists(destination))) {
        return { filename: file.filename, storedFilename, ok: true, skipped: true };
      }

      // Write to a temp path in the SAME directory, then rename into place.
      //
      // WHY, and the exact hole this closes. copyFile writes straight into its
      // destination and is not atomic, so a process death mid-copy leaves a
      // TRUNCATED file at the real path. On its own that was survivable: the copy
      // precedes the insert, so a first-attempt crash leaves a partial file with no
      // row, and the resume above re-copies it. The reachable hole is the
      // re-copy — a file whose row already exists but whose file went missing (the
      // case the resume deliberately redoes). That re-copy truncates the real path
      // while the row is already committed, so a crash there leaves
      // row-present + partial-file-present, which the skip test above then reads as
      // "done" and never repairs. The sitemap is silently short for the rest of the
      // session's life.
      //
      // rename(2) is atomic within a filesystem, and Node's rename replaces an
      // existing destination (verified on this platform, where the underlying
      // MoveFileEx is called with MOVEFILE_REPLACE_EXISTING) — so the real path only
      // ever holds a fully-written file, and there is no need to guess which files
      // to conservatively redo.
      //
      // The temp keeps the session-id prefix on purpose: uploadCleanup and the usage
      // accounting both match uploadDir entries by that prefix, so a temp orphaned
      // by a crash is reaped with the session instead of lingering forever. Nothing
      // DB-driven can see it — listings and ZIPs are built from sitemap_files rows,
      // and a temp has no row.
      const tempPath = `${destination}.${randomUUID()}.part`;

      try {
        // Copy rather than move: the source set must stay where it is.
        await copyFile(file.path, tempPath);
        await rename(tempPath, destination);
      } catch (error) {
        // Only the temp is removed. The destination is deliberately NOT touched:
        // it is either absent, or a complete copy an earlier attempt recorded a row
        // for, and deleting that would turn a failed re-copy into data loss.
        await unlink(tempPath).catch(() => undefined);

        // Settled, not thrown: one unreadable file must not abandon the rest.
        return { filename: file.filename, storedFilename, ok: false, error };
      }

      try {
        await createStoredSitemapFile(
          options.sessionId,
          storedFilename,
          sourceRole,
          file.filename
        );

        return { filename: file.filename, storedFilename, ok: true };
      } catch (error) {
        // The file is complete at its real path but unrecorded. Left in place: the
        // next attempt finds no row and re-copies it (idempotent), whereas deleting
        // it could remove a copy a previous attempt's row already points at. An
        // unreferenced file is reaped by the upload cleanup.
        return { filename: file.filename, storedFilename, ok: false, error };
      }
    },
    options.onSettled
  );
}
