import path from "node:path";

import { config } from "../config.js";
import { runSourceFileScanJob } from "../jobs/sourceFileScanPool.js";
import {
  countSitemapLocMatches,
  pathMatchesTemplate
} from "./rewriteLocs.js";
import {
  urlMatchesStructureFilters,
  type ResolvedStructureFilter
} from "./structureClusters.js";

// Split out of routes/sessions.ts so both the scoped source-file preview
// route AND bench/sourceFileScanRate.ts can call these two scan paths
// directly, without the bench pulling in sessions.ts's unrelated BullMQ
// queue imports (which need a live Redis just to resolve at import time).
// transformDryRunScan.ts/dryRunScanPool.ts already live outside routes/ for
// the same reason — this brings the scoped scan's module layout in line
// with its dry-run sibling.

export type ResolvedScanFile = { displayName: string; storedFilename: string };

// How many files to stream-count in parallel. Read-only and lightweight next
// to the actual rewrite (no output file, no worker-pool handoff), so this can
// run inline on the request thread; capped so a pattern spanning hundreds of
// files doesn't open them all at once.
const SCOPED_BREAKDOWN_CONCURRENCY = 6;

// Scan a resolved file's occurrences via the ordinary async-I/O-concurrency
// loop — no real CPU parallelism, so this is only used below
// SOURCE_FILE_SCAN_PARALLEL_THRESHOLD, where thread startup would cost more
// than it saves (same reasoning as transformDryRunScan.ts's scanInline).
export async function scanResolvedFilesInline(
  files: ResolvedScanFile[],
  template: string,
  resolvedFilters: ResolvedStructureFilter[],
  // Called once per file, after ANY outcome (matched, no-match, unreadable) —
  // "current" means files attempted, not files matched. Optional: the bench
  // and any caller that doesn't need progress just omits it.
  onFileDone?: () => void
): Promise<{
  results: Array<{ source_file: string; occurrences: number }>;
  noMatches: number;
  unreadable: number;
}> {
  const matchesUrl = (url: string): boolean => {
    let pathname: string;

    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }

    return (
      pathMatchesTemplate(pathname, template) &&
      urlMatchesStructureFilters(url, resolvedFilters)
    );
  };

  const results: Array<{ source_file: string; occurrences: number }> = [];
  let noMatches = 0;
  let unreadable = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;

      if (index >= files.length) {
        return;
      }

      const { displayName, storedFilename } = files[index];

      try {
        const occurrences = await countSitemapLocMatches({
          inputPath: path.join(config.uploadDir, storedFilename),
          isGzip: storedFilename.toLowerCase().endsWith(".gz"),
          matchesUrl
        });

        if (occurrences > 0) {
          results.push({ source_file: displayName, occurrences });
        } else {
          // Read fine, matched nothing. Usually a template that no longer
          // describes what is on disk (see hasStaleCountsAfterFix) or a scope
          // narrower than this file's contents.
          noMatches += 1;
        }
      } catch {
        // Missing/unreadable on disk — excluded rather than failing the whole
        // preview.
        unreadable += 1;
      } finally {
        onFileDone?.();
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(SCOPED_BREAKDOWN_CONCURRENCY, files.length) },
      worker
    )
  );

  return { results, noMatches, unreadable };
}

// Scan a resolved file's occurrences across the Piscina pool
// (jobs/sourceFileScanPool.ts) — real CPU parallelism, used once the pattern
// crosses SOURCE_FILE_SCAN_PARALLEL_THRESHOLD or
// SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD. Mirrors transformDryRunScan.ts's
// scanPooled: ONE task per file, not a fixed chunk split, so Piscina's queue
// hands a free thread the next file regardless of how unevenly sized the
// pattern's files are.
export async function scanResolvedFilesPooled(
  files: ResolvedScanFile[],
  template: string,
  resolvedFilters: ResolvedStructureFilter[],
  onFileDone?: () => void
): Promise<{
  results: Array<{ source_file: string; occurrences: number }>;
  noMatches: number;
  unreadable: number;
}> {
  const results: Array<{ source_file: string; occurrences: number }> = [];
  let noMatches = 0;
  let unreadable = 0;

  await Promise.all(
    files.map(async ({ displayName, storedFilename }) => {
      try {
        const { occurrences, failed } = await runSourceFileScanJob({
          inputPath: path.join(config.uploadDir, storedFilename),
          isGzip: storedFilename.toLowerCase().endsWith(".gz"),
          template,
          resolvedFilters
        });

        if (failed) {
          unreadable += 1;
        } else if (occurrences > 0) {
          results.push({ source_file: displayName, occurrences });
        } else {
          noMatches += 1;
        }
      } catch {
        // A thread that died outright, rather than a file it could not read —
        // counted the same way the inline path counts an unreadable file.
        unreadable += 1;
      } finally {
        onFileDone?.();
      }
    })
  );

  return { results, noMatches, unreadable };
}
