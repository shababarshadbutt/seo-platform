import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import type { PoolClient } from "pg";

import { config } from "../config.js";
import {
  FILE_REWRITE_PARALLEL_THRESHOLD,
  runFileRewriteJob
} from "../jobs/fileRewritePool.js";
import { buildLastmodUpdatedStoredFilename, displaySourceFilename } from "./filenames.js";
import { buildLastmodDecision, rewriteSitemapLastmodFile } from "./rewriteLocs.js";

// The copy-on-write file rewrite behind the Lastmod Updater. Deliberately its
// own module rather than a new branch of sitemaps/patternFileRewrites.ts's
// rewriteTargets(): that helper's inline path calls rewriteSitemapLocFile
// directly (a LocUrlRewriter contract), which a lastmod rewrite does not fit —
// it decides a SIBLING element's value from the <loc> URL, not the URL itself.
// Duplicating the parallel/inline orchestration here is a smaller, safer change
// than generalising a function rename and transform depend on.
//
// No undo bookkeeping (unlike transformPatternSourceFilesOnDisk): a lastmod
// rewrite is never lossy, and the feature was not asked to support undo, so the
// old file is deleted after commit exactly like the rename path — no original
// kept around.

export type LastmodTarget = {
  id: string;
  filename: string;
  // null = every <url> in this file is in scope. A Set = only these exact
  // <loc> values (Vertical wise, resolved via enumeratePopulation).
  urlScope: Set<string> | null;
};

export type LastmodRewriteOutcome = {
  // Newly written files to unlink if the caller's transaction rolls back.
  newFilePaths: string[];
  // Original files to unlink AFTER the caller's transaction commits.
  oldFilePaths: string[];
  urlsRewritten: number;
};

// Run the lastmod rewrite over every target, in the piscina pool once there
// are enough files to earn the thread setup cost (same threshold rename and
// transform use), otherwise inline. DB writes stay on the caller's connection
// and inside the caller's transaction even when the rewrites run in parallel —
// the worker threads do pure disk I/O.
export async function rewriteLastmodTargetFiles(
  client: PoolClient,
  options: {
    sessionId: string;
    targets: LastmodTarget[];
    targetDate: string;
    onFileDone?: (filesDone: number) => void | Promise<void>;
    onFilesTotal?: (filesTotal: number) => void | Promise<void>;
  }
): Promise<LastmodRewriteOutcome> {
  const { targets } = options;

  await options.onFilesTotal?.(targets.length);

  const result: LastmodRewriteOutcome = {
    newFilePaths: [],
    oldFilePaths: [],
    urlsRewritten: 0
  };

  const parallel = targets.length >= FILE_REWRITE_PARALLEL_THRESHOLD;
  let filesDone = 0;

  // Serialises the DB bookkeeping so parallel rewrites still repoint
  // sitemap_files.filename one at a time on this single connection.
  let handoff: Promise<void> = Promise.resolve();

  const runOne = async (target: LastmodTarget) => {
    const inputPath = path.join(config.uploadDir, target.filename);

    try {
      await access(inputPath);
    } catch {
      // Already cleaned up / missing — nothing to rewrite for this row.
      filesDone += 1;
      await options.onFileDone?.(filesDone);

      return;
    }

    const isGzip = target.filename.toLowerCase().endsWith(".gz");
    const displayName = displaySourceFilename(options.sessionId, target.filename);
    const newStored = buildLastmodUpdatedStoredFilename(
      options.sessionId,
      displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);
    const urls = target.urlScope ? [...target.urlScope] : null;

    let rewrittenCount = 0;

    try {
      rewrittenCount = parallel
        ? (
            await runFileRewriteJob({
              inputPath,
              outputPath,
              isGzip,
              spec: { kind: "lastmodUpdate", targetDate: options.targetDate, urls }
            })
          ).rewrittenCount
        : await rewriteSitemapLastmodFile({
            inputPath,
            outputPath,
            isGzip,
            decide: buildLastmodDecision(options.targetDate, target.urlScope)
          });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    const previous = handoff;

    // Take our turn even if an EARLIER file's bookkeeping failed — see the
    // identical comment in patternFileRewrites.ts's rewriteTargets for why.
    handoff = previous.catch(() => {}).then(async () => {
      if (rewrittenCount === 0) {
        // Nothing changed (out of scope, already the target date, or no
        // <lastmod> element) — discard the identical copy and leave the
        // original file and its sitemap_files.filename untouched.
        await unlink(outputPath).catch(() => {});
      } else {
        result.newFilePaths.push(outputPath);
        await client.query(
          "UPDATE sitemap_files SET filename = $1 WHERE id = $2",
          [newStored, target.id]
        );
        result.oldFilePaths.push(inputPath);
        result.urlsRewritten += rewrittenCount;
      }

      filesDone += 1;
      await options.onFileDone?.(filesDone);
    });

    await handoff;
  };

  if (parallel) {
    // allSettled, not Promise.all: these callbacks query the CALLER's open
    // transaction, so a rejection must not leave later callbacks racing a
    // client the caller has already rolled back and released. See the
    // identical reasoning in patternFileRewrites.ts's rewriteTargets.
    const settled = await Promise.allSettled(targets.map((target) => runOne(target)));
    const failure = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected"
    );

    if (failure) {
      throw failure.reason;
    }
  } else {
    for (const target of targets) {
      await runOne(target);
    }
  }

  return result;
}
