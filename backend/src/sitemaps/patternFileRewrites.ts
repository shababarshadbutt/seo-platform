import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";

import { config } from "../config.js";
import {
  PATTERN_FILES_PER_THREAD,
  mapWithConcurrency,
  runFileRewriteJob,
  workerCountForFiles
} from "../jobs/fileRewritePool.js";
import type { FileRewriteSpec } from "../workers/fileRewriteWorker.js";
import {
  buildRenamedStoredFilename,
  buildTransformedStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "./filenames.js";

// The on-disk half of a pattern rename / structure transform, lifted out of
// routes/sessions.ts where it used to run inline in the HTTP handler, one file
// at a time (491 files x 4.2M URLs ran well past the client's 180s abort).
//
// Two things changed beyond moving it:
//
// 1. Files are rewritten through the shared piscina pool, with the thread count
//    scaled to the file count (workerCountForFiles). Every DB write still
//    happens on the CALLING thread — the workers do pure disk I/O and no
//    database access at all, which is what keeps the undo bookkeeping
//    single-threaded and correct.
// 2. Nothing is skipped silently. The previous code dropped a missing file with
//    a bare `catch { continue }` and a no-match file with a bare `continue`, so
//    a run that rewrote nothing still reported success. Every skip is now
//    classified, logged, and returned to the caller for the user to see.

export type PatternRewriteSkipReason =
  // The sitemap_files row points at a remote URL, not a local file.
  | "remote-source"
  // The stored file is gone from UPLOAD_DIR (ENOENT only — any other errno is a
  // real fault and is rethrown).
  | "missing-on-disk"
  // The rewriter matched zero <loc> values, so there was nothing to change.
  | "no-urls-matched";

export type PatternRewriteWarning = {
  file: string;
  reason: PatternRewriteSkipReason;
};

export type PatternRewriteOutcome = {
  // Parallel arrays (same index = same file): the pre-rewrite stored filename
  // and the repointed post-rewrite one.
  oldStoredFilenames: string[];
  newStoredFilenames: string[];
  // Absolute paths of the ORIGINAL files. The rename caller unlinks these after
  // COMMIT (a rename is reversible by replaying the reverse rewrite); the
  // transform caller keeps them, because its undo restores them byte-for-byte.
  oldFilePaths: string[];
  // Newly written files, to unlink if the caller's transaction ROLLS BACK.
  newFilePaths: string[];
  rewrittenLocCount: number;
  filesTotal: number;
  filesRewritten: number;
  skipped: PatternRewriteWarning[];
  // How the work was actually distributed, for the job log and the tests.
  workerThreads: number;
};

// The two database handles a rewrite needs, kept deliberately distinct.
//
// `tx` is the caller's OPEN transaction: every mutation that must roll back
// together goes there and nothing else may.
//
// `progress` deliberately does NOT run on `tx`. Progress has to be readable by
// the status endpoint WHILE the transaction is still open (otherwise "340 of
// 491" only appears at COMMIT, which is the moment it stops being useful), and
// it has to survive a ROLLBACK so a failed job still shows how far it got. The
// job layer builds this callback over the shared pool. Do not "simplify" the
// two into one client.
export type PatternRewriteContext = {
  tx: PoolClient;
  progress: (
    filesDone: number,
    filesTotal: number,
    urlsRewritten: number
  ) => Promise<void>;
};

export type PatternRewriteKind =
  | { kind: "rename"; oldTemplate: string; newTemplate: string }
  | { kind: "transform"; currentStructure: string; newStructure: string };

type Candidate = {
  fileId: string;
  storedFilename: string;
  displayName: string;
  inputPath: string;
  isGzip: boolean;
};

function rewriteSpecFor(operation: PatternRewriteKind): FileRewriteSpec {
  if (operation.kind === "rename") {
    return {
      kind: "patternTemplate",
      from: operation.oldTemplate,
      to: operation.newTemplate
    };
  }

  return {
    kind: "patternStructure",
    currentStructure: operation.currentStructure,
    nextStructure: operation.newStructure
  };
}

// Only a genuinely absent file is a skip. EACCES/EIO/EPERM etc. mean the file is
// there and we cannot read it — that is a fault, and swallowing it is how a
// half-applied transform used to report success.
async function fileIsPresent(inputPath: string): Promise<boolean> {
  try {
    await access(inputPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function removeQuietly(filePath: string, logger: FastifyBaseLogger) {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    logger.warn(
      { file_path: filePath, err: error },
      "failed to remove discarded pattern rewrite output"
    );
  }
}

export async function rewritePatternFiles(
  context: PatternRewriteContext,
  options: {
    sessionId: string;
    patternId: string;
    sourceRole: string;
    selectedDisplayFiles: string[];
    operation: PatternRewriteKind;
    logger: FastifyBaseLogger;
    // Rename repoints every readable file (even a zero-match one) so its undo
    // can replay a reverse rewrite over the same set. Transform discards a
    // zero-match copy and leaves the original in place.
    keepZeroMatchRewrites: boolean;
  }
): Promise<PatternRewriteOutcome> {
  const { logger } = options;
  const selectedSet = new Set(options.selectedDisplayFiles);
  const filesResult = await context.tx.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2
    `,
    [options.sessionId, options.sourceRole]
  );

  const skipped: PatternRewriteWarning[] = [];
  const candidates: Candidate[] = [];

  for (const file of filesResult.rows) {
    const displayName = displaySourceFilename(options.sessionId, file.filename);

    if (selectedSet.size > 0 && !selectedSet.has(displayName)) {
      continue;
    }

    if (isHttpUrl(file.filename)) {
      logger.warn(
        { session_id: options.sessionId, file: displayName },
        "pattern rewrite skipped a URL-sourced sitemap: it has no local file to rewrite"
      );
      skipped.push({ file: displayName, reason: "remote-source" });
      continue;
    }

    const inputPath = path.join(config.uploadDir, file.filename);

    if (!(await fileIsPresent(inputPath))) {
      logger.warn(
        {
          session_id: options.sessionId,
          file: displayName,
          stored_filename: file.filename
        },
        "pattern rewrite skipped a file that is no longer on disk"
      );
      skipped.push({ file: displayName, reason: "missing-on-disk" });
      continue;
    }

    candidates.push({
      fileId: file.id,
      storedFilename: file.filename,
      displayName,
      inputPath,
      isGzip: file.filename.toLowerCase().endsWith(".gz")
    });
  }

  const spec = rewriteSpecFor(options.operation);
  const buildStoredName =
    options.operation.kind === "rename"
      ? buildRenamedStoredFilename
      : buildTransformedStoredFilename;
  const workerThreads = workerCountForFiles(candidates.length);

  logger.info(
    {
      session_id: options.sessionId,
      pattern_id: options.patternId,
      operation: options.operation.kind,
      files_total: candidates.length,
      files_skipped: skipped.length,
      worker_threads: workerThreads,
      files_per_thread: PATTERN_FILES_PER_THREAD
    },
    "pattern file rewrite started"
  );

  const outcome: PatternRewriteOutcome = {
    oldStoredFilenames: [],
    newStoredFilenames: [],
    oldFilePaths: [],
    newFilePaths: [],
    rewrittenLocCount: 0,
    filesTotal: candidates.length,
    filesRewritten: 0,
    skipped,
    workerThreads
  };

  // Phase-1 running totals for live progress only. The authoritative counts are
  // recomputed in phase 2 from the settled results, in candidate order.
  let filesDone = 0;
  let urlsSoFar = 0;

  // Phase 1 — pure disk work, off this thread, `workerThreads` at a time.
  // mapWithConcurrency settles EVERY task even if one rejects, so no straggler
  // is still running when the caller's transaction is released.
  const settled = await mapWithConcurrency(
    candidates,
    workerThreads,
    async (candidate) => {
      const newStored = buildStoredName(
        options.sessionId,
        candidate.displayName,
        randomUUID()
      );
      const outputPath = path.join(config.uploadDir, newStored);

      try {
        const { rewrittenCount } = await runFileRewriteJob({
          inputPath: candidate.inputPath,
          outputPath,
          isGzip: candidate.isGzip,
          spec
        });

        filesDone += 1;
        urlsSoFar += rewrittenCount;
        await context.progress(filesDone, candidates.length, urlsSoFar);

        return { candidate, newStored, outputPath, rewrittenCount };
      } catch (error) {
        // A partially-written output is never left behind for the caller to
        // repoint at.
        await removeQuietly(outputPath, logger);
        throw error;
      }
    }
  );

  // Surface the first real failure before touching the database. Every task has
  // settled by now, so nothing is still writing when the caller rolls back.
  const failure = settled.find(
    (entry): entry is PromiseRejectedResult => entry.status === "rejected"
  );

  if (failure) {
    for (const entry of settled) {
      if (entry.status === "fulfilled") {
        await removeQuietly(entry.value.outputPath, logger);
      }
    }

    logger.error(
      {
        session_id: options.sessionId,
        pattern_id: options.patternId,
        err: failure.reason
      },
      "pattern file rewrite failed"
    );

    throw failure.reason;
  }

  // Phase 2 — the DB bookkeeping, on THIS thread, in candidate order, so undo
  // records a deterministic set regardless of which worker finished first.
  for (const entry of settled) {
    if (entry.status !== "fulfilled") {
      continue;
    }

    const { candidate, newStored, outputPath, rewrittenCount } = entry.value;

    if (rewrittenCount === 0 && !options.keepZeroMatchRewrites) {
      logger.info(
        {
          session_id: options.sessionId,
          pattern_id: options.patternId,
          file: candidate.displayName
        },
        "pattern rewrite matched no URLs in this file; leaving the original in place"
      );
      skipped.push({ file: candidate.displayName, reason: "no-urls-matched" });
      await removeQuietly(outputPath, logger);
      continue;
    }

    if (rewrittenCount === 0) {
      skipped.push({ file: candidate.displayName, reason: "no-urls-matched" });
    }

    outcome.newFilePaths.push(outputPath);
    await context.tx.query(
      "UPDATE sitemap_files SET filename = $1 WHERE id = $2",
      [newStored, candidate.fileId]
    );
    outcome.oldStoredFilenames.push(candidate.storedFilename);
    outcome.newStoredFilenames.push(newStored);
    outcome.oldFilePaths.push(candidate.inputPath);
    outcome.rewrittenLocCount += rewrittenCount;
    outcome.filesRewritten += 1;
  }

  // Land the exact final counts — the parallel progress callbacks race, so the
  // last one to run is not necessarily the highest.
  await context.progress(
    candidates.length,
    candidates.length,
    outcome.rewrittenLocCount
  );

  logger.info(
    {
      session_id: options.sessionId,
      pattern_id: options.patternId,
      operation: options.operation.kind,
      files_rewritten: outcome.filesRewritten,
      urls_rewritten: outcome.rewrittenLocCount,
      files_skipped: skipped.length,
      skipped_remote: skipped.filter((s) => s.reason === "remote-source").length,
      skipped_missing: skipped.filter((s) => s.reason === "missing-on-disk")
        .length,
      skipped_no_match: skipped.filter((s) => s.reason === "no-urls-matched")
        .length
    },
    "pattern file rewrite complete"
  );

  return outcome;
}

// A run that changed nothing is not a success worth a green toast. Returns the
// reason to show the user, or null when real work happened.
export function zeroWorkReason(outcome: PatternRewriteOutcome): string | null {
  if (outcome.filesRewritten > 0) {
    return null;
  }

  if (outcome.filesTotal === 0 && outcome.skipped.length === 0) {
    return "This pattern has no source files to rewrite.";
  }

  const missing = outcome.skipped.filter(
    (entry) => entry.reason === "missing-on-disk"
  ).length;
  const remote = outcome.skipped.filter(
    (entry) => entry.reason === "remote-source"
  ).length;

  if (missing > 0 && missing === outcome.skipped.length) {
    return `No files were changed — all ${missing} selected file(s) are missing from storage.`;
  }

  if (remote > 0 && remote === outcome.skipped.length) {
    return `No files were changed — all ${remote} selected sitemap(s) are remote URLs with no local file.`;
  }

  return "No files were changed — the current structure did not match any URLs in the selected files.";
}
