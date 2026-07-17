import { pool } from "../db/pool.js";
import { displaySourceFilename, isHttpUrl } from "./filenames.js";
import { streamSitemapUrlLocs } from "./parser.js";

export type ProblemFileGroup = {
  file_id: string;
  filename: string; // display name
  problem_url_count: number;
  sample_urls: Array<{ url: string; http_status: number }>;
  statuses: number[];
  patterns: Array<{ id: string; template: string }>;
  // sampled_urls ids whose <loc> physically appears in this file. Used by the
  // delete job to mark exactly the URLs that will be removed.
  url_ids: string[];
};

const SAMPLE_LIMIT = 5;

type ProblemEntry = {
  id: string;
  http_status: number;
  pattern_id: string;
  template: string;
};

// Group confirmed (sampled) problem URLs by the file their <loc> physically
// appears in.
//
// patterns.source_file — and therefore sampled_urls.source_file — is a
// comma-joined list for multi-file patterns, so it cannot key a single file.
// Instead we take the small confirmed-problem set and scan each candidate file's
// <loc>s (the exact match the deletion engine uses in removeUrlBlocksFromFile),
// so counts, samples, and url_ids all line up precisely with what deletion
// removes. Candidate files come from pattern_file_occurrences (single display
// names), narrowing the scan to files a problem pattern actually touches.
//
// Note: only sampled URLs carry a confirmed HTTP status, so counts are bounded
// by the session's sample size per pattern — those are exactly the URLs we can
// safely delete.
export async function collectProblemFileGroups(options: {
  sessionId: string;
  statuses: number[];
  // When set, only these display filenames are scanned (the delete path).
  restrictToDisplays?: string[];
}): Promise<ProblemFileGroup[]> {
  const { sessionId, statuses } = options;

  const problemResult = await pool.query<{
    id: string;
    url: string;
    http_status: number;
    pattern_id: string;
    template: string;
    source_file: string | null;
  }>(
    `
      SELECT s.id, s.url, s.http_status, s.pattern_id, p.template, p.source_file
      FROM sampled_urls s
      JOIN patterns p ON p.id = s.pattern_id
      WHERE p.session_id = $1
        AND s.is_deleted_from_sitemap = false
        AND s.http_status = ANY($2::int[])
    `,
    [sessionId, statuses]
  );

  if (problemResult.rowCount === 0) {
    return [];
  }

  // loc -> problem entry. If a loc maps to several sampled rows (rare), keep the
  // first; the deletion removes that loc regardless of which row it came from.
  const problemByUrl = new Map<string, ProblemEntry>();
  const patternIds = new Set<string>();
  // Candidate display names harvested from patterns.source_file (a comma-joined
  // list for multi-file patterns) — a cheap first narrowing hint.
  const candidateDisplays = new Set<string>();

  for (const row of problemResult.rows) {
    if (!problemByUrl.has(row.url)) {
      problemByUrl.set(row.url, {
        id: row.id,
        http_status: row.http_status,
        pattern_id: row.pattern_id,
        template: row.template
      });
    }

    patternIds.add(row.pattern_id);

    for (const part of (row.source_file ?? "").split(",")) {
      const display = part.trim();

      if (display) {
        candidateDisplays.add(display);
      }
    }
  }

  // Also take the files these problem patterns occur in (single display names).
  const occResult = await pool.query<{ source_file: string }>(
    `
      SELECT DISTINCT source_file
      FROM pattern_file_occurrences
      WHERE pattern_id = ANY($1::uuid[])
    `,
    [Array.from(patternIds)]
  );

  for (const row of occResult.rows) {
    candidateDisplays.add(row.source_file);
  }

  const restrict = options.restrictToDisplays
    ? new Set(options.restrictToDisplays)
    : null;

  // Resolve to current, local, non-deleted files. Narrow to the candidate
  // display names when we have any (fast path); otherwise — legacy sessions with
  // no source_file / occurrence metadata — scan every current file so problem
  // URLs are never missed. The caller's restriction (delete path) always applies.
  const filesResult = await pool.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
    `,
    [sessionId]
  );
  const candidateFiles = filesResult.rows
    .filter((row) => !isHttpUrl(row.filename))
    .map((row) => ({
      id: row.id,
      stored: row.filename,
      display: displaySourceFilename(sessionId, row.filename)
    }))
    .filter((file) => candidateDisplays.size === 0 || candidateDisplays.has(file.display))
    .filter((file) => !restrict || restrict.has(file.display));

  const groups: ProblemFileGroup[] = [];

  for (const file of candidateFiles) {
    const statusSet = new Set<number>();
    const seenPatternIds = new Set<string>();
    const seenUrls = new Set<string>();
    const group: ProblemFileGroup = {
      file_id: file.id,
      filename: file.display,
      problem_url_count: 0,
      sample_urls: [],
      statuses: [],
      patterns: [],
      url_ids: []
    };

    try {
      await streamSitemapUrlLocs(file.stored, (loc) => {
        const entry = problemByUrl.get(loc);

        // Not a problem URL, or already counted for this file.
        if (!entry || seenUrls.has(loc)) {
          return;
        }

        seenUrls.add(loc);
        group.problem_url_count += 1;
        group.url_ids.push(entry.id);
        statusSet.add(entry.http_status);

        if (group.sample_urls.length < SAMPLE_LIMIT) {
          group.sample_urls.push({ url: loc, http_status: entry.http_status });
        }

        if (!seenPatternIds.has(entry.pattern_id)) {
          seenPatternIds.add(entry.pattern_id);
          group.patterns.push({
            id: entry.pattern_id,
            template: entry.template
          });
        }
      });
    } catch {
      // Missing on disk (cleaned up) or unreadable — skip like the rebuild does.
      continue;
    }

    if (group.problem_url_count > 0) {
      group.statuses = Array.from(statusSet).sort((a, b) => a - b);
      group.patterns.sort((a, b) => a.template.localeCompare(b.template));
      groups.push(group);
    }
  }

  groups.sort((a, b) => b.problem_url_count - a.problem_url_count);

  return groups;
}
