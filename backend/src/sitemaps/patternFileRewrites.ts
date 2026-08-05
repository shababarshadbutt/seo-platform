import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import type { PoolClient } from "pg";

import { config } from "../config.js";
import {
  FILE_REWRITE_PARALLEL_THRESHOLD,
  runFileRewriteJob
} from "../jobs/fileRewritePool.js";
import {
  buildRenamedStoredFilename,
  buildTransformedStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "./filenames.js";
import {
  buildPatternTemplateRewriter,
  rewriteSitemapLocFile,
  type LocUrlRewriter
} from "./rewriteLocs.js";
import type { FileRewriteSpec } from "../workers/fileRewriteWorker.js";

// The copy-on-write file rewrites behind pattern rename and pattern structure
// transform. Moved out of routes/sessions.ts when both became background jobs
// (v1.48) and given the two things a job needs that a request did not:
//
//   * PARALLELISM. Both looped one file at a time while bulk replace had used the
//     piscina fileRewritePool since v1.32. That is the whole reason a rename or
//     transform over a large pattern took minutes: 823 files / 6.58M URLs measured
//     136s sequentially. Above FILE_REWRITE_PARALLEL_THRESHOLD files the rewrites
//     now run in the same pool.
//   * PROGRESS. onFileDone fires per completed file so the job row can publish
//     "340 of 823 files rewritten" while the work is still going.
//
// DB writes stay on the caller's thread and inside the caller's transaction even
// when the rewrites are parallel — the worker threads do pure disk work, so the
// undo bookkeeping remains single-threaded and ordered exactly as before.

export type PatternFileRewrite = {
  // Stored filenames written this call (for pattern_renames.renamed_file_path).
  renamedStoredFilenames: string[];
  // Original files to unlink AFTER the DB transaction commits.
  oldFilePaths: string[];
  // Newly written files to unlink if the DB transaction rolls back.
  newFilePaths: string[];
  rewrittenLocCount: number;
};

export type PatternFileTransform = {
  // Parallel arrays (same index = same file) recorded on the pattern_transforms
  // row: the pre-transform stored filename and the repointed post-transform one.
  oldStoredFilenames: string[];
  newStoredFilenames: string[];
  // Newly written files to unlink if the DB transaction ROLLS BACK.
  newFilePaths: string[];
  rewrittenLocCount: number;
};

type TargetFile = { id: string; filename: string };

// The files of a session+role that a selection actually covers, in stable order.
// An empty selection means "every file of this role", matching the pre-job
// behaviour of both helpers.
async function selectTargetFiles(
  client: PoolClient,
  options: {
    sessionId: string;
    sourceRole: string;
    selectedDisplayFiles: string[];
  }
): Promise<TargetFile[]> {
  const selectedSet = new Set(options.selectedDisplayFiles);
  const filesResult = await client.query<TargetFile>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2
      ORDER BY filename ASC
    `,
    [options.sessionId, options.sourceRole]
  );

  return filesResult.rows.filter((file) => {
    // URL-sourced entries are not stored on disk as rewritable local files.
    if (isHttpUrl(file.filename)) {
      return false;
    }

    if (selectedSet.size === 0) {
      return true;
    }

    return selectedSet.has(displaySourceFilename(options.sessionId, file.filename));
  });
}

// Run `spec` over every target, in the piscina pool once there are enough files
// to be worth the threads. `handle` does the per-file DB bookkeeping and MUST be
// awaited before the next file's, which is why the parallel branch maps a
// promise per file but serialises the handle calls through a chain.
async function rewriteTargets(
  targets: TargetFile[],
  options: {
    sessionId: string;
    spec: FileRewriteSpec;
    inlineRewriter: LocUrlRewriter;
    buildStoredName: (sessionId: string, displayName: string) => string;
    onFileDone?: (filesDone: number) => void | Promise<void>;
    handle: (
      file: TargetFile,
      written: {
        inputPath: string;
        newStored: string;
        outputPath: string;
        rewrittenLocCount: number;
      }
    ) => Promise<void>;
  }
) {
  const parallel = targets.length >= FILE_REWRITE_PARALLEL_THRESHOLD;
  let filesDone = 0;

  // Serialises the DB bookkeeping so parallel rewrites still append to the undo
  // arrays one at a time (and never issue concurrent queries on one client).
  let handoff: Promise<void> = Promise.resolve();

  const runOne = async (file: TargetFile) => {
    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      // File already cleaned up / missing — nothing to rewrite for this row.
      filesDone += 1;
      await options.onFileDone?.(filesDone);

      return;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const displayName = displaySourceFilename(options.sessionId, file.filename);
    const newStored = options.buildStoredName(options.sessionId, displayName);
    const outputPath = path.join(config.uploadDir, newStored);

    let rewrittenLocCount = 0;

    try {
      rewrittenLocCount = parallel
        ? (
            await runFileRewriteJob({
              inputPath,
              outputPath,
              isGzip,
              spec: options.spec
            })
          ).rewrittenCount
        : await rewriteSitemapLocFile({
            inputPath,
            outputPath,
            isGzip,
            rewriteUrl: options.inlineRewriter
          });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    const previous = handoff;

    // `previous.catch(() => {})` — take our turn even if an EARLIER file's
    // bookkeeping failed. Propagating that rejection would skip this file's
    // handle(), and handle() is what records the copy we just wrote in
    // newFilePaths; skipped, the copy is orphaned on disk when the caller rolls
    // back. Each handle records its path BEFORE its DB write, so every file this
    // call created stays cleanable even when the transaction is already aborted.
    // Our own rejection still surfaces through the `await` below.
    handoff = previous.catch(() => {}).then(async () => {
      await options.handle(file, {
        inputPath,
        newStored,
        outputPath,
        rewrittenLocCount
      });
      filesDone += 1;
      await options.onFileDone?.(filesDone);
    });

    await handoff;
  };

  if (parallel) {
    // The pool caps concurrent rewrites at its thread count, so mapping every
    // target at once is safe.
    //
    // allSettled, NOT Promise.all: these callbacks write to the CALLER's open
    // transaction. Promise.all rejects on the first failure, the caller's catch
    // then rolls back and releases the client, and the rewrites still in flight
    // would go on to query a released client — an unhandled rejection that takes
    // the worker process down. Waiting for every file to settle before rethrowing
    // means nothing touches the client after the caller regains control, and it
    // also leaves newFilePaths complete so the caller can unlink every copy it
    // wrote.
    const settled = await Promise.allSettled(targets.map((file) => runOne(file)));
    const failure = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected"
    );

    if (failure) {
      throw failure.reason;
    }
  } else {
    for (const file of targets) {
      await runOne(file);
    }
  }
}

// Rewrite the <loc> URLs of a pattern's selected source files on disk so their
// path segments reflect the rename (old template -> new template). Writes each
// modified file to a fresh uniquely-named copy and repoints
// sitemap_files.filename at it within the caller's transaction. Old files are
// NOT deleted here — the caller unlinks oldFilePaths only after COMMIT and
// unlinks newFilePaths on ROLLBACK, so a failure never destroys the original.
export async function rewritePatternSourceFilesOnDisk(
  client: PoolClient,
  options: {
    sessionId: string;
    sourceRole: string;
    oldTemplate: string;
    newTemplate: string;
    selectedDisplayFiles: string[];
    onFileDone?: (filesDone: number) => void | Promise<void>;
    onFilesTotal?: (filesTotal: number) => void | Promise<void>;
  }
): Promise<PatternFileRewrite> {
  const targets = await selectTargetFiles(client, options);

  await options.onFilesTotal?.(targets.length);

  const result: PatternFileRewrite = {
    renamedStoredFilenames: [],
    oldFilePaths: [],
    newFilePaths: [],
    rewrittenLocCount: 0
  };

  await rewriteTargets(targets, {
    sessionId: options.sessionId,
    spec: {
      kind: "patternTemplate",
      from: options.oldTemplate,
      to: options.newTemplate
    },
    // Order-based param mapping: carries each {param} value across even when the
    // new template changes segment count (e.g. inserting /aviation/). The old
    // index-based rewriter left a literal {param} (URL-encoded to %7Bparam%7D) in
    // that case — the "extra content in downloaded URLs" bug.
    inlineRewriter: buildPatternTemplateRewriter(
      options.oldTemplate,
      options.newTemplate
    ),
    buildStoredName: (sessionId, displayName) =>
      buildRenamedStoredFilename(sessionId, displayName, randomUUID()),
    onFileDone: options.onFileDone,
    handle: async (file, written) => {
      result.newFilePaths.push(written.outputPath);
      await client.query("UPDATE sitemap_files SET filename = $1 WHERE id = $2", [
        written.newStored,
        file.id
      ]);
      result.renamedStoredFilenames.push(written.newStored);
      result.oldFilePaths.push(written.inputPath);
      result.rewrittenLocCount += written.rewrittenLocCount;
    }
  });

  return result;
}

// Rewrite a pattern's selected source files with the structure transform,
// repointing sitemap_files.filename at a fresh copy. Unlike the rename rewriter
// this DOES NOT delete the previous file — a transform can be lossy, so its
// pre-transform copy is kept on disk and its filename recorded so undo can
// restore it. Files with no matching <loc> are left as-is.
export async function transformPatternSourceFilesOnDisk(
  client: PoolClient,
  options: {
    sessionId: string;
    sourceRole: string;
    selectedDisplayFiles: string[];
    // Raw structure strings, so the parallel pool can rebuild the rewriter in a
    // worker thread. The inline path parses them once via `rewriteUrl`.
    currentStructure: string;
    newStructure: string;
    rewriteUrl: LocUrlRewriter;
    onFileDone?: (filesDone: number) => void | Promise<void>;
    onFilesTotal?: (filesTotal: number) => void | Promise<void>;
  }
): Promise<PatternFileTransform> {
  const targets = await selectTargetFiles(client, options);

  await options.onFilesTotal?.(targets.length);

  const result: PatternFileTransform = {
    oldStoredFilenames: [],
    newStoredFilenames: [],
    newFilePaths: [],
    rewrittenLocCount: 0
  };

  await rewriteTargets(targets, {
    sessionId: options.sessionId,
    spec: {
      kind: "structureTransform",
      currentStructure: options.currentStructure,
      newStructure: options.newStructure
    },
    inlineRewriter: options.rewriteUrl,
    buildStoredName: (sessionId, displayName) =>
      buildTransformedStoredFilename(sessionId, displayName, randomUUID()),
    onFileDone: options.onFileDone,
    handle: async (file, written) => {
      if (written.rewrittenLocCount === 0) {
        // Nothing matched — discard the identical copy and leave the original.
        await unlink(written.outputPath).catch(() => {});

        return;
      }

      result.newFilePaths.push(written.outputPath);
      await client.query("UPDATE sitemap_files SET filename = $1 WHERE id = $2", [
        written.newStored,
        file.id
      ]);
      result.oldStoredFilenames.push(file.filename);
      result.newStoredFilenames.push(written.newStored);
      result.rewrittenLocCount += written.rewrittenLocCount;
    }
  });

  return result;
}
