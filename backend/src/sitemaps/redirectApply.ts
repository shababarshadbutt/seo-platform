import { access, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { config } from "../config.js";
import {
  buildRedirectFixedStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "./filenames.js";
import {
  buildRedirectApplyRewriter,
  rewriteSitemapLocFile
} from "./rewriteLocs.js";
import type { RedirectRule } from "./redirectRule.js";
import {
  applyStructureFilterToRewriter,
  type ResolvedStructureFilter
} from "./structureClusters.js";

// Shared "apply redirects" disk + stats logic, used by BOTH the synchronous
// apply-redirects route (small patterns) and the background apply-redirects job
// (large patterns, > FILE_REWRITE_PARALLEL_THRESHOLD files — v1.42). Extracted
// from routes/sessions.ts so the job does not have to import the routes module.

// Recompute redirect_pct / confidence_pct for a pattern from its sampled_urls
// using the SAME scoreWeight formula as the sampling job (success=1,
// soft_404=0.25, redirect=0.5, failure=0), so apply-redirects and its undo are
// exact inverses. Parameter $1 is the pattern id.
//
// BLOCKED ROWS ARE EXCLUDED FROM BOTH SIDES OF BOTH FRACTIONS, exactly as
// calculatePatternScore's `measurable` filter does (patternScore.ts). A blocked row
// is not a data point — the site's security answered instead of the page — and
// averaging it in as a zero reports a working URL as broken. This SQL had drifted
// from that filter: `ELSE 0` scored blocked rows as failures AND counted them in
// the denominator, so the first apply-redirects (or its undo) on a pattern with any
// blocked sample silently dragged confidence back down, re-introducing the exact
// lie the "blocked" category was added to stop.
//
// When EVERY sample is blocked the filtered count is 0, so NULLIF -> NULL and
// COALESCE leaves the stored values untouched — the same "nothing measurable, so
// assert nothing" outcome patternScore produces.
//
// IS DISTINCT FROM, not <>: http_status_category is nullable (migration 003 kept
// NULLs), and a plain <> would silently drop those legacy rows from the population
// instead of scoring them 0 the way the CASE always has.
//
// `status` is deliberately NOT recomputed here. It is owned by the sampling job,
// which is the only thing that actually re-probes a URL; a redirect apply rewrites
// XML and re-derives percentages from rows it did not re-measure.
export const recomputePatternStatsSql = `
  UPDATE patterns
  SET
    redirect_pct = COALESCE((
      SELECT ROUND(
        100.0 * COUNT(*) FILTER (WHERE http_status_category = 'redirect')
          / NULLIF(COUNT(*), 0),
        2
      )
      FROM sampled_urls
      WHERE pattern_id = $1
        AND http_status_category IS DISTINCT FROM 'blocked'
    ), redirect_pct),
    confidence_pct = COALESCE((
      SELECT ROUND(
        100.0 * SUM(
          CASE http_status_category
            WHEN 'success' THEN 1
            WHEN 'soft_404' THEN 0.25
            WHEN 'redirect' THEN 0.5
            ELSE 0
          END
        ) / NULLIF(COUNT(*), 0),
        2
      )
      FROM sampled_urls
      WHERE pattern_id = $1
        AND http_status_category IS DISTINCT FROM 'blocked'
    ), confidence_pct)
  WHERE id = $1
`;

export type RedirectFileRewrite = {
  fixedStoredFilenames: string[];
  // Previous files safe to delete after COMMIT (intermediate fixed copies only —
  // never the preserved pre-fix original, which undo needs).
  oldFilePaths: string[];
  // Newly written fixed files to delete if the transaction rolls back.
  newFilePaths: string[];
  rewrittenLocCount: number;
};

// Rewrite the source XML files for a pattern's redirect fixes: every <loc>
// matching a key in `replacements` is swapped for its redirect destination.
// Unlike a rename (which swaps static path segments across all matching URLs),
// this is a URL-level replacement of specific URLs. `selectedDisplayFiles`
// limits the scan to the files the affected URLs actually came from (a session
// can hold thousands of sitemaps); when empty, all files for the role are
// scanned as a fallback. A file is only rewritten and repointed if it truly
// contains an affected URL, so an over-broad candidate list is harmless. Mirrors
// the rename flow: the new file is fully written and sitemap_files.filename
// repointed inside the transaction; old files are only deleted after COMMIT.
export async function rewriteRedirectSourceFilesOnDisk(
  client: PoolClient,
  options: {
    sessionId: string;
    sourceRole: string;
    replacements: Map<string, string>;
    selectedDisplayFiles: string[];
    // When set, the whole-pattern widening rule (v1.45.1): applied to EVERY
    // <loc> in the scanned files, not just the pre-enumerated `replacements`
    // keys — so the fix reaches all real occurrences regardless of the capped
    // pattern_urls sample. `replacements` (confirmed sampled pairs) still wins
    // per-URL. Null (or omitted) = exact-map-only, unchanged prior behaviour.
    rule?: RedirectRule | null;
    // Scope the widening to one detected structure (v1.66). Resolved filters —
    // path-segment indexes, not param ordinals. Empty/omitted = whole pattern,
    // unchanged prior behaviour. See applyStructureFilterToRewriter.
    structureFilters?: ResolvedStructureFilter[] | null;
  }
): Promise<RedirectFileRewrite> {
  const rewriteUrl = applyStructureFilterToRewriter(
    buildRedirectApplyRewriter(options.replacements, options.rule ?? null),
    options.structureFilters ?? null
  );
  const selectedSet = new Set(options.selectedDisplayFiles);
  const filesResult = await client.query<{
    id: string;
    filename: string;
    fixed_file_path: string | null;
  }>(
    `
      SELECT id, filename, fixed_file_path
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2
    `,
    [options.sessionId, options.sourceRole]
  );
  const result: RedirectFileRewrite = {
    fixedStoredFilenames: [],
    oldFilePaths: [],
    newFilePaths: [],
    rewrittenLocCount: 0
  };

  for (const file of filesResult.rows) {
    // URL-sourced entries are not stored on disk as rewritable local files.
    if (isHttpUrl(file.filename)) {
      continue;
    }

    const displayName = displaySourceFilename(options.sessionId, file.filename);

    if (selectedSet.size > 0 && !selectedSet.has(displayName)) {
      continue;
    }

    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      // File already cleaned up / missing — nothing to rewrite for this row.
      continue;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const newStored = buildRedirectFixedStoredFilename(
      options.sessionId,
      displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);

    const rewrittenLocCount = await rewriteSitemapLocFile({
      inputPath,
      outputPath,
      isGzip,
      rewriteUrl
    });

    if (rewrittenLocCount === 0) {
      // This file contained none of the affected URLs — discard the identical
      // copy and leave the row untouched.
      await unlink(outputPath).catch(() => {});
      continue;
    }

    // Preserve the true pre-fix original across chained applies so undo can
    // restore it fully. On the first apply the current filename IS the original.
    const originalToKeep = file.fixed_file_path ?? file.filename;

    await client.query(
      "UPDATE sitemap_files SET filename = $1, fixed_file_path = $2 WHERE id = $3",
      [newStored, originalToKeep, file.id]
    );

    result.newFilePaths.push(outputPath);
    result.fixedStoredFilenames.push(newStored);
    // Delete the previous file after commit only when it is an intermediate
    // fixed copy — never the preserved original (needed for undo).
    if (file.filename !== originalToKeep) {
      result.oldFilePaths.push(inputPath);
    }
    result.rewrittenLocCount += rewrittenLocCount;
  }

  return result;
}

// Revert every redirect-fixed file for a session back to its preserved pre-fix
// original (the counterpart of rewriteRedirectSourceFilesOnDisk, driven by the
// shared find-replace/apply-redirects undo). Repoints sitemap_files.filename in
// the transaction; the now-orphaned fixed copies are deleted by the caller after
// COMMIT.
export async function revertRedirectSourceFilesOnDisk(
  client: PoolClient,
  sessionId: string
): Promise<{ oldFilePaths: string[] }> {
  const filesResult = await client.query<{
    id: string;
    filename: string;
    fixed_file_path: string;
  }>(
    `
      SELECT id, filename, fixed_file_path
      FROM sitemap_files
      WHERE session_id = $1 AND fixed_file_path IS NOT NULL
    `,
    [sessionId]
  );
  const oldFilePaths: string[] = [];

  for (const file of filesResult.rows) {
    await client.query(
      "UPDATE sitemap_files SET filename = $1, fixed_file_path = NULL WHERE id = $2",
      [file.fixed_file_path, file.id]
    );

    if (file.filename !== file.fixed_file_path) {
      oldFilePaths.push(path.join(config.uploadDir, file.filename));
    }
  }

  return { oldFilePaths };
}

// Merge the VERIFIED redirect population into a replacement map already built
// from the sampled preview (v1.67).
//
// THE BUG THIS CLOSES. apply-redirects built its map only from sampled_urls rows
// the client named by id, and the candidate list those ids come from is capped at
// ~1,000 server-side. "Verify all in this pattern" writes a different table,
// verified_urls, one row per URL with its own confirmed final_url — and nothing
// in the apply path read it. So a user who verified all 28,546 URLs of a pattern
// and pressed Accept still got ~10 rewrites: the button said 28,546, the toast
// said 10, and the toast was right.
//
// Extracted as a pure function rather than left inline in the route for the same
// reason lib/fix-accept-count.ts exists on the client: routes/sessions.ts is
// exercised only by DB-backed integration tests, so merge rules left in the
// handler are rules nothing cheap can assert. The three that matter are the
// three below.
export function mergeVerifiedReplacements(options: {
  // Already populated from sampled_urls, and MUTATED in place — the caller's map
  // is the one the rewrite uses.
  replacements: Map<string, string>;
  // Also mutated: display filenames to narrow the disk scan to.
  candidateFiles: Set<string>;
  verified: Array<{
    url: string;
    final_url: string;
    source_files: string[] | null;
  }>;
  // Structure scope, resolved. Null/empty = whole pattern.
  matchesScope?: (url: string) => boolean;
}): { added: number; skippedOutOfScope: number } {
  let added = 0;
  let skippedOutOfScope = 0;

  for (const row of options.verified) {
    // 1. STRUCTURE SCOPE. This is a second source of replacements, so the guard
    // inside the rewriter is the backstop, not the only line of defence — a URL
    // outside "Limit this edit to" must never enter the map at all.
    if (options.matchesScope && !options.matchesScope(row.url)) {
      skippedOutOfScope += 1;
      continue;
    }

    // 2. A destination that is not a change is not a replacement.
    if (!row.final_url || row.final_url === row.url) {
      continue;
    }

    // 3. SAMPLED WINS. Its row already had its stats recomputed and its undo
    // snapshot written in this transaction, so its destination is the one the
    // rest of the transaction is consistent with. A verified row for the same
    // URL must not overwrite it.
    if (!options.replacements.has(row.url)) {
      options.replacements.set(row.url, row.final_url);
      added += 1;
    }

    for (const name of row.source_files ?? []) {
      if (name.length > 0) {
        options.candidateFiles.add(name);
      }
    }
  }

  return { added, skippedOutOfScope };
}
