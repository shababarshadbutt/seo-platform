import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { displaySourceFilename, isHttpUrl } from "../sitemaps/filenames.js";
import { streamSitemapUrlLocs } from "../sitemaps/parser.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";

// Enumerating a pattern's REAL URL population from the sitemap XML on disk.
//
// Extracted from verifyUrlsJob so sample triage counts exactly the same
// population the full verification would. If triage estimated against the
// capped pattern_urls pool (≤1000 rows) while verification enumerated the
// files, the two would quote different denominators for the same pattern —
// "~340 of ~1,000" then "187 of 25,744" — and the estimate would look wrong
// when it was only measured against a different universe. One enumerator, one
// denominator.
//
// This is the expensive-but-unavoidable part of scoping. Finding which URLs
// belong to a pattern means reading every <loc> of every file, because nothing
// records a pattern-to-file mapping (pattern_urls is a capped candidate pool,
// not an index). Streaming 1.3M locs is disk and parse work measured in tens of
// seconds — irrelevant next to the HTTP phase it replaces, but it is not free,
// which is why callers report it as its own phase rather than leaving the
// progress bar sitting at zero.

export type PatternRow = {
  id: string;
  template: string;
};

export type EnumeratedUrl = {
  url: string;
  patternId: string;
  template: string;
  sourceFiles: Set<string>;
};

// Reports enumeration progress in FILES, which is the only unit available
// during this phase — the URL total is what enumeration exists to discover, so
// it cannot also be the thing it reports against. Called once with
// (0, files.length) as soon as the file list is known, then once per file.
//
// Synchronous by contract: this runs inside the per-file loop, so a caller that
// awaited a DB write here would serialise enumeration behind its own progress
// reporting. Callers throttle and fire-and-forget — see verifyUrlsJob.
export type EnumerateProgressFn = (filesDone: number, filesTotal: number) => void;

export async function enumeratePopulation(
  sessionId: string,
  patterns: PatternRow[],
  logger: FastifyBaseLogger,
  onProgress?: EnumerateProgressFn
): Promise<Map<string, EnumeratedUrl>> {
  const population = new Map<string, EnumeratedUrl>();

  if (patterns.length === 0) {
    return population;
  }

  const filesResult = await pool.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1
        AND source_role = 'current'
        AND is_deleted = false
        AND is_valid = true
      ORDER BY filename ASC
    `,
    [sessionId]
  );
  const files = filesResult.rows.filter((row) => !isHttpUrl(row.filename));

  // The denominator, published before any streaming so the client can switch
  // from an indeterminate spinner to a real bar immediately rather than after
  // the first (possibly large) file.
  onProgress?.(0, files.length);

  let filesDone = 0;

  for (const file of files) {
    const display = displaySourceFilename(sessionId, file.filename);

    try {
      await streamSitemapUrlLocs(file.filename, (loc) => {
        const existing = population.get(loc);

        if (existing) {
          existing.sourceFiles.add(display);
          return;
        }

        let pathname: string;

        try {
          pathname = new URL(loc).pathname;
        } catch {
          // Not a parseable absolute URL — it can't be probed or matched.
          return;
        }

        // First matching selected template wins; a loc matching none is not
        // part of the population.
        const matched = patterns.find((pattern) =>
          pathMatchesTemplate(pathname, pattern.template)
        );

        if (!matched) {
          return;
        }

        population.set(loc, {
          url: loc,
          patternId: matched.id,
          template: matched.template,
          sourceFiles: new Set([display])
        });
      });
    } catch (error) {
      // Missing on disk (cleaned up) or unreadable — skip like the deletion
      // rebuild does, but say so: a silently skipped file shrinks the population.
      logger.warn(
        { session_id: sessionId, filename: file.filename, error },
        "pattern population: could not stream file, skipping"
      );
    }

    // Counted OUTSIDE the try/catch on purpose: a file that could not be
    // streamed is still a file the scan is done with. Advancing only on success
    // would leave the bar stalled below 100% for the rest of the run on any
    // session with a missing or unreadable file, which reads as a hang — the
    // very symptom this reporting exists to remove.
    filesDone += 1;
    onProgress?.(filesDone, files.length);
  }

  return population;
}
