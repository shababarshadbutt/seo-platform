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
import { deriveRedirectRule, type RedirectRule } from "./redirectRule.js";
import {
  applyStructureFilterToRewriter,
  urlMatchesStructureFilters,
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
  // Files actually opened and streamed (v1.74). Reported so a caller can tell
  // "the rule matched nothing" from "no file was ever read" — those look
  // identical in rewrittenLocCount and mean completely different things.
  filesScanned: number;
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
    // One rule, or the LIST a human approved (v1.72) — applied in order, first
    // match winning. See buildRedirectApplyRewriter.
    rule?: RedirectRule | RedirectRule[] | null;
    // Scope the widening to one detected structure (v1.66). Resolved filters —
    // path-segment indexes, not param ordinals. Empty/omitted = whole pattern,
    // unchanged prior behaviour. See applyStructureFilterToRewriter.
    structureFilters?: ResolvedStructureFilter[] | null;
    // Per-shape rules from a stratified verification (v1.69), keyed on
    // valueShape(pathname). Reached only where there is no confirmed exact
    // destination and no whole-pattern rule applies. See shapeStrata.ts for why
    // a shape can distil a rule when the whole pattern cannot.
    shapeRules?: Map<string, RedirectRule> | null;
    // URLs the operator set to Skip or Delete (v1.73). The rule would otherwise
    // sweep them anyway — see buildRedirectApplyRewriter.
    excludeUrls?: Set<string> | null;
  }
): Promise<RedirectFileRewrite> {
  const rewriteUrl = applyStructureFilterToRewriter(
    buildRedirectApplyRewriter(
      options.replacements,
      options.rule ?? null,
      options.shapeRules ?? null,
      options.excludeUrls ?? null
    ),
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
    rewrittenLocCount: 0,
    filesScanned: 0
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
      // Deliberately NOT counted as scanned: a file that could not be opened has
      // told us nothing about whether the rule matches.
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

    // Counted AFTER the read succeeded and regardless of whether anything
    // matched: this is "we looked in here", which is what separates a rule that
    // found nothing from a pattern whose files are gone.
    result.filesScanned += 1;

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
// from the sampled preview (v1.68).
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

// EVERYTHING AN APPLY REWRITES WITH, ASSEMBLED ONCE (v1.79).
//
// THE BUG THIS ENDS. apply-redirects has two paths — inline in the route for a
// narrow pattern, a queued job for a wide one — and they built their inputs
// separately. Only the route was kept current, so the job never gained:
//
//   * verified_urls destinations (v1.68) — the whole point of that release;
//   * per-shape rules (v1.69) — it passed null where the rewriter takes them;
//   * the `widen` flag (v1.73) — its payload had no field for it, so "every
//     confirmed redirect in scope" degraded to "the ones the client listed".
//
// That stayed survivable only because the queue was hard to reach: a pattern had
// to span more than 200 files AND the caller had to send a rule, inferred URLs or
// widen. v1.77 changed routing to file count alone with a default of 25 — so the
// blind path became the normal one, and an apply on a 187-file pattern rewrote
// the ~10 files its sampled rows lived in while the dialog promised 579,034 URLs.
//
// v1.75 fixed exactly this shape of bug for WHICH FILES an apply opens, and said
// so: "one decision, shared by both paths" (see applyFileScope). It did not occur
// to anyone that WHICH REPLACEMENTS an apply uses had the same problem. So this
// function exists to make the divergence unrepresentable rather than fixed: there
// is now one place to add a capability to, and both callers get it.
//
// WHAT STAYS WITH THE CALLERS. Validating approved rules against the server's own
// candidates (isOfferedRule) stays in the route, because it answers with a 400
// and the job has nobody to answer. The job trusts that check, exactly as it did
// before — the route is the only way a rule can enter the system.
export async function resolveApplyInputs(options: {
  client: PoolClient;
  sessionId: string;
  patternId: string;
  // Restrict to specific sampled_url rows. null → every confirmed redirect.
  urlIds: string[] | null;
  // Rows the operator set to Skip or Delete. Never rewritten, and never given
  // their destination in the database either — a row that reads as fixed beside
  // an untouched file is the worse of the two failures.
  excludeUrls: string[];
  // Non-sampled URLs the client ticked. Its CONTENTS are not used to rewrite
  // (they come from a capped pool); its emptiness is what says whether a derived
  // rule was asked for.
  inferredUrls: string[];
  // Already validated by the route against the candidates the server derived
  // from its own confirmed pairs.
  approvedRules: RedirectRule[] | null;
  // "Set all to Fix" (v1.73): every confirmed redirect in scope, which is what
  // url_ids: null already meant. Kept separate so an older client that still
  // sends the list keeps working.
  widenRequested: boolean;
  // Structure scope, resolved. null/empty → the whole pattern.
  structureFilters: ResolvedStructureFilter[] | null;
  matchesScope?: (url: string) => boolean;
}): Promise<{
  // Exact source→destination pairs. Confirmed measurements, every one.
  replacements: Map<string, string>;
  // Display filenames the confirmed rows named. A hint for the file scope, never
  // the whole answer — see applyFileScope.
  candidateFiles: Set<string>;
  // One derived rule, the operator's approved list, or null.
  rule: RedirectRule | RedirectRule[] | null;
  // Per-shape rules from a stratified verification, agreed ones only.
  shapeRules: Map<string, RedirectRule>;
  // Does the rule sweep the pattern, or only the enumerated rows?
  widen: boolean;
  // sampled_urls rows whose destination was adopted, for the response's
  // `updated` count.
  updatedCount: number;
}> {
  const {
    client,
    sessionId,
    patternId,
    urlIds,
    excludeUrls,
    inferredUrls,
    approvedRules,
    widenRequested,
    structureFilters
  } = options;

  // A HUMAN-APPROVED RULE BEATS THE DERIVED ONE (v1.72). deriveRedirectRule
  // returns null for precisely the disagreeing pairs that make an approval
  // necessary, so re-deriving over them would silently rewrite nothing.
  //
  // DERIVED FIRST, BEFORE THE UPDATE BELOW, because that update flips the
  // selected rows to 'success' and erases the evidence a rule is distilled from.
  // Both callers did it in this order for that reason; the order is the contract.
  let rule: RedirectRule | RedirectRule[] | null = null;

  if (approvedRules && approvedRules.length > 0) {
    rule = approvedRules;
  } else if (inferredUrls.length > 0) {
    const ruleSamples = await client.query<{ url: string; final_url: string }>(
      `
        SELECT url, final_url
        FROM sampled_urls
        WHERE pattern_id = $1
          AND http_status_category = 'redirect'
          AND final_url IS NOT NULL
          AND final_url <> url
      `,
      [patternId]
    );

    rule = deriveRedirectRule(
      ruleSamples.rows.map((row) => ({
        source: row.url,
        dest: row.final_url
      }))
    );
  }

  // Adopt each redirect's destination as the URL, snapshotting the original
  // url / category / is_hit so "Undo last replace" can fully restore them. The
  // destination is treated as a live hit (success). RETURNING gives the old→new
  // pairs needed to rewrite the source XML on disk.
  const updateResult = await client.query<{
    original_url: string;
    url: string;
    source_file: string | null;
  }>(
    `
      UPDATE sampled_urls
      SET original_url = COALESCE(original_url, url),
          original_http_status_category =
            COALESCE(original_http_status_category, http_status_category),
          original_is_hit = COALESCE(original_is_hit, is_hit),
          url = final_url,
          http_status_category = 'success',
          is_hit = TRUE
      WHERE pattern_id = $1
        AND http_status_category = 'redirect'
        AND final_url IS NOT NULL
        AND final_url <> url
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
        -- Skip is the operator's explicit "leave this alone", so an excluded row
        -- must not have its destination adopted either.
        AND ($3::text[] IS NULL OR NOT (url = ANY($3::text[])))
      RETURNING original_url, url, source_file
    `,
    [patternId, urlIds, excludeUrls.length > 0 ? excludeUrls : null]
  );

  // Recompute redirect / confidence from samples using the SAME formula as the
  // sampling job, so this is an exact inverse of undo.
  await client.query(recomputePatternStatsSql, [patternId]);

  const replacements = new Map<string, string>();
  const candidateFiles = new Set<string>();

  for (const row of updateResult.rows) {
    if (row.original_url && row.original_url !== row.url) {
      replacements.set(row.original_url, row.url);
    }

    // sampled_urls.source_file holds a comma-separated list of display names.
    for (const name of (row.source_file ?? "").split(",")) {
      const trimmed = name.trim();

      if (trimmed.length > 0) {
        candidateFiles.add(trimmed);
      }
    }
  }

  // THE FULL VERIFIED POPULATION (v1.68). Everything above comes from
  // sampled_urls — the small HTTP-checked preview, and the rows a client can name
  // by id. "Verify all in this pattern" writes verified_urls instead, one row per
  // URL with its own confirmed final_url, and for a long time nothing in the
  // apply path read it: a user who verified all 28,546 URLs of a pattern and
  // pressed Accept still got ~10 rewrites.
  //
  // Confirmed destinations, not inference — every row here was actually fetched,
  // which is what makes this strictly better than the rule-based widening below
  // and why it is merged BEFORE the rule is considered.
  const verifiedResult = await client.query<{
    url: string;
    final_url: string;
    source_files: string[] | null;
  }>(
    `
      SELECT url, final_url, source_files
      FROM verified_urls
      WHERE session_id = $1
        AND pattern_id = $2
        AND http_status_category = 'redirect'
        AND final_url IS NOT NULL
        AND final_url <> url
        AND is_deleted_from_sitemap = false
        AND ($3::text[] IS NULL OR url = ANY($3::text[]))
        AND ($4::text[] IS NULL OR NOT (url = ANY($4::text[])))
    `,
    [
      sessionId,
      patternId,
      // null = every verified redirect in the pattern, which is what a pressed
      // "Set all to Fix" means and what url_ids: null already meant. Otherwise
      // narrow to the non-sampled URLs the client ticked.
      urlIds === null || widenRequested ? null : inferredUrls,
      excludeUrls.length > 0 ? excludeUrls : null
    ]
  );

  mergeVerifiedReplacements({
    replacements,
    candidateFiles,
    verified: verifiedResult.rows,
    matchesScope:
      options.matchesScope ??
      (structureFilters && structureFilters.length > 0
        ? (url) => urlMatchesStructureFilters(url, structureFilters)
        : undefined)
  });

  // PER-SHAPE RULES from a stratified verification (v1.69). Only shapes whose
  // samples AGREED are loaded: an unagreed row exists to say "this shape was
  // sampled and its URLs disagree", which is grounds for escalating it to a full
  // verification, never for rewriting it.
  const shapeRuleResult = await client.query<{
    shape: string;
    rule: RedirectRule;
  }>(
    `
      SELECT shape, rule
      FROM pattern_shape_rules
      WHERE pattern_id = $1 AND agreed = true AND rule IS NOT NULL
    `,
    [patternId]
  );
  const shapeRules = new Map<string, RedirectRule>(
    shapeRuleResult.rows.map((row) => [row.shape, row.rule])
  );

  // Whole-pattern widening: the rule applies to EVERY matching <loc> in the
  // pattern's files, not to a pre-enumerated subset. The confirmed exact pairs
  // still win per-URL inside buildRedirectApplyRewriter.
  const widen =
    rule !== null &&
    ((approvedRules !== null && approvedRules.length > 0) ||
      inferredUrls.length > 0 ||
      widenRequested);

  return {
    replacements,
    candidateFiles,
    rule,
    shapeRules,
    widen,
    updatedCount: updateResult.rowCount ?? 0
  };
}
