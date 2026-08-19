import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { displaySourceFilename, isHttpUrl } from "./filenames.js";
import { scanSitemapLocs } from "./rewriteLocs.js";

// Read-only walk over every file a pattern's URLs live in.
//
// Extracted so the two things that need it cannot drift: the Update Pattern
// modal's per-file occurrence breakdown (how many URLs would this edit touch,
// and in which files) and the transform dry run (what would this edit PRODUCE
// across the whole population). Both stream the same candidate files with the
// same concurrency and the same <loc> parser; only the visitor differs.
//
// Nothing here writes. The caller gets each <loc> URL in file order and decides
// what to count.

// Files read at once. Six was measured as the point where the breakdown stopped
// getting faster on the SEO box's disk; the dry run inherits it rather than
// picking its own number, so one session cannot starve the other.
export const PATTERN_FILE_SCAN_CONCURRENCY = 6;

export type PatternScanTarget = {
  // The name the UI shows and the user ticks.
  displayName: string;
  // The name on disk right now, which every mutation swaps in place.
  storedFilename: string;
  inputPath: string;
  isGzip: boolean;
};

// Resolve a pattern's candidate files to what is actually on disk NOW.
//
// pattern_file_occurrences records where the pattern's URLs were found at
// extraction time; sitemap_files holds the current filename, which rename /
// transform / redirect-fix / bulk-replace all repoint. Joining them here is what
// keeps a scan reading the CORRECTED copy of a file rather than the original a
// stale lookup would hand back.
export async function resolvePatternScanTargets(options: {
  patternId: string;
  sessionId: string;
  sourceRole: string;
  // Restrict to files the user ticked. Empty = every candidate file.
  displayNames?: string[];
}): Promise<PatternScanTarget[]> {
  const candidates = await pool.query<{ source_file: string }>(
    "SELECT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
    [options.patternId]
  );

  if (candidates.rows.length === 0) {
    return [];
  }

  const filesResult = await pool.query<{ filename: string }>(
    `
      SELECT filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2 AND is_deleted = false
    `,
    [options.sessionId, options.sourceRole]
  );
  const storedByDisplay = new Map<string, string>();

  for (const file of filesResult.rows) {
    if (isHttpUrl(file.filename)) {
      continue;
    }

    storedByDisplay.set(
      displaySourceFilename(options.sessionId, file.filename),
      file.filename
    );
  }

  const wanted =
    options.displayNames && options.displayNames.length > 0
      ? new Set(options.displayNames)
      : null;
  const targets: PatternScanTarget[] = [];

  for (const row of candidates.rows) {
    if (wanted && !wanted.has(row.source_file)) {
      continue;
    }

    const storedFilename = storedByDisplay.get(row.source_file);

    if (!storedFilename) {
      // Recorded at extraction time but the file row is gone or was renamed
      // since. The occurrence breakdown tolerates this too — dropping it is
      // correct, failing the whole scan is not.
      continue;
    }

    targets.push({
      displayName: row.source_file,
      storedFilename,
      inputPath: path.join(config.uploadDir, storedFilename),
      isGzip: storedFilename.toLowerCase().endsWith(".gz")
    });
  }

  return targets;
}

// Stream every <loc> in every target past `visit`, at most
// PATTERN_FILE_SCAN_CONCURRENCY files at a time.
//
// A file that cannot be read is SKIPPED, not fatal — the same choice the
// occurrence breakdown makes. A scan that dies because one file vanished would
// leave the user with no numbers at all, which is strictly less useful than
// numbers over the files that are still there. `onFileDone` fires per completed
// file so a caller can publish progress.
export async function scanPatternFiles(options: {
  targets: PatternScanTarget[];
  visit: (url: string, target: PatternScanTarget) => void;
  onFileDone?: (done: number) => void | Promise<void>;
}): Promise<{ filesScanned: number; filesSkipped: number }> {
  let cursor = 0;
  let done = 0;
  let skipped = 0;

  async function worker() {
    for (;;) {
      const index = cursor;

      cursor += 1;

      if (index >= options.targets.length) {
        return;
      }

      const target = options.targets[index];

      try {
        await scanSitemapLocs({
          inputPath: target.inputPath,
          isGzip: target.isGzip,
          visit: (url) => options.visit(url, target)
        });
      } catch {
        skipped += 1;
      }

      done += 1;
      await options.onFileDone?.(done);
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          PATTERN_FILE_SCAN_CONCURRENCY,
          Math.max(options.targets.length, 1)
        )
      },
      worker
    )
  );

  return { filesScanned: done - skipped, filesSkipped: skipped };
}
