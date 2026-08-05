import { copyFile, unlink } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
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
  error?: unknown;
};

// Concurrency for the copy+insert pipeline. Four is the same ceiling the file
// rewrite pool uses: enough to keep the disk and a pooled connection busy while
// staying well inside the 10-connection DB pool, so an ingest can never starve
// the API of connections. Each unit of work holds at most one connection, and
// only for the INSERT.
export const INGEST_CONCURRENCY = 4;

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

      try {
        // Copy rather than move: the source set must stay where it is.
        await copyFile(file.path, destination);
        await createStoredSitemapFile(
          options.sessionId,
          storedFilename,
          sourceRole,
          file.filename
        );

        return { filename: file.filename, storedFilename, ok: true };
      } catch (error) {
        // Never leave a half-copied file behind to be parsed as a real sitemap.
        await unlink(destination).catch(() => undefined);

        // Settled, not thrown: one unreadable file must not abandon the rest.
        return { filename: file.filename, storedFilename, ok: false, error };
      }
    },
    options.onSettled
  );
}
