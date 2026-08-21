import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { invalidateSessionZipCache } from "../exports/sessionZipCache.js";
import {
  buildRedirectFixedStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "../sitemaps/filenames.js";
import {
  buildRedirectApplyRewriter,
  rewriteSitemapLocFile
} from "../sitemaps/rewriteLocs.js";
import { deriveRedirectRule } from "../sitemaps/redirectRule.js";
import { recomputePatternStatsSql } from "../sitemaps/redirectApply.js";
import { applyStructureFilterToRewriter } from "../sitemaps/structureClusters.js";
import {
  FILE_REWRITE_PARALLEL_THRESHOLD,
  runFileRewriteJob
} from "./fileRewritePool.js";
import type { ApplyRedirectsJobData } from "../queue/bulkReplaceQueue.js";

// Background "apply redirects" for a widened whole-pattern fix (v1.42). The
// synchronous route handles small patterns inline; anything spanning more than
// FILE_REWRITE_PARALLEL_THRESHOLD files is routed here so the (potentially
// hundreds-of-files) rewrite never blocks the API event loop or trips the HTTP
// timeout — the same failure mode that burned the ZIP path (v1.27) and the
// Cleaner (v1.38). This mirrors processBulkReplaceJob: rewrites run in the
// piscina fileRewritePool, every DB write stays on this thread, and the copy-
// on-write file swap + fixed_file_path bookkeeping is identical to the inline
// rewriteRedirectSourceFilesOnDisk (so the shared undo reverts either path).
//
// Server-authoritative by design: the client only says WHICH rows to change;
// the rule and every inferred destination are recomputed here.

type SitemapFileRow = {
  id: string;
  filename: string;
  fixed_file_path: string | null;
};

export async function processApplyRedirectsJob(
  data: ApplyRedirectsJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, pattern_id: patternId } = data;
  const urlIds = data.url_ids;
  const inferredUrls = data.inferred_urls ?? [];
  // Structure scope (v1.66), resolved by the route. Guards BOTH the inline and
  // the pooled path below, because a derived rule otherwise rewrites every
  // <loc> it can transform — including the structures the user excluded.
  const structureFilters = data.structure_filters ?? null;

  const patternResult = await pool.query<{ source_role: string }>(
    "SELECT source_role FROM patterns WHERE id = $1",
    [patternId]
  );

  if (patternResult.rowCount === 0) {
    logger.warn(
      { session_id: sessionId, pattern_id: patternId },
      "apply-redirects job: pattern missing"
    );
    return;
  }

  const sourceRole = patternResult.rows[0].source_role;

  // Derive the rule from the confirmed redirect samples BEFORE the UPDATE below
  // flips the selected rows to 'success' (which would erase the evidence).
  const ruleSamples = await pool.query<{ url: string; final_url: string }>(
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
  const rule = deriveRedirectRule(
    ruleSamples.rows.map((row) => ({ source: row.url, dest: row.final_url }))
  );

  // Adopt the confirmed sampled destinations + recompute stats (one txn), then
  // build the replacement map (sampled confirmed pairs + inferred pairs).
  const replacements = new Map<string, string>();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const updateResult = await client.query<{
      original_url: string;
      url: string;
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
        RETURNING original_url, url
      `,
      [patternId, urlIds]
    );

    await client.query(recomputePatternStatsSql, [patternId]);
    await client.query("COMMIT");

    for (const row of updateResult.rows) {
      if (row.original_url && row.original_url !== row.url) {
        replacements.set(row.original_url, row.url);
      }
    }
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }

  client.release();

  // Whole-pattern widening (fixed v1.45.1): when the client opted into the
  // unsampled URLs AND a single rule distilled from the confirmed samples, apply
  // that rule to EVERY matching <loc> in the pattern's files via a streaming
  // rewrite — NOT a replacement map built from the client's inferred_urls, which
  // came from the capped pattern_urls pool and covered only the sample. The
  // confirmed sampled pairs (`replacements`) still win per-URL. inferred_urls is
  // now only a "widen requested" signal; its contents are not used to rewrite.
  // APPROVED RULES BEAT THE DERIVED ONE (v1.72).
  //
  // The job used to derive its own rule and widen only when inferred_urls was
  // non-empty. Both are wrong for a human-approved apply: deriveRedirectRule
  // returns null for precisely the disagreeing pairs that make an approval
  // necessary, so a re-deriving job would silently rewrite nothing — and the
  // operator would see a queued job complete having changed no files.
  //
  // The route has already validated each of these against the candidates it
  // derived from its own confirmed pairs, so they are as authoritative here as
  // the derived rule was.
  const approvedRules = data.approved_rules ?? null;
  // URLs the operator set to Skip or Delete (v1.73). Held as a Set here and
  // passed as an array to the pool — see the spec's note.
  const excludeUrls = data.exclude_urls ?? null;
  const excludeSet = excludeUrls ? new Set(excludeUrls) : null;
  const widen =
    (approvedRules !== null && approvedRules.length > 0) ||
    (inferredUrls.length > 0 && rule !== null);
  const effectiveRule = !widen
    ? null
    : approvedRules && approvedRules.length > 0
      ? approvedRules
      : rule;

  // Nothing to do only when there is neither a confirmed pair nor a rule to
  // widen with (a rule can rewrite files even with zero confirmed pairs).
  if (replacements.size === 0 && !effectiveRule) {
    logger.info(
      { session_id: sessionId, pattern_id: patternId },
      "apply-redirects job: nothing to rewrite"
    );
    await invalidateSessionZipCache(sessionId);
    return;
  }

  // Target files: those this pattern's URLs actually live in.
  const occurrenceResult = await pool.query<{ source_file: string }>(
    "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
    [patternId]
  );
  const targetDisplays = new Set(
    occurrenceResult.rows.map((row) => row.source_file)
  );

  const filesResult = await pool.query<SitemapFileRow>(
    `
      SELECT id, filename, fixed_file_path
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2
      ORDER BY filename ASC
    `,
    [sessionId, sourceRole]
  );
  const targets = filesResult.rows.filter((file) => {
    if (isHttpUrl(file.filename)) {
      return false;
    }

    // Empty occurrence set (older sessions) → scan every file of the role.
    return (
      targetDisplays.size === 0 ||
      targetDisplays.has(displaySourceFilename(sessionId, file.filename))
    );
  });

  const replacementPairs: [string, string][] = Array.from(
    replacements.entries()
  );
  let rewrittenLocCount = 0;

  // Swap in the rewritten copy for one file and preserve its pre-fix original
  // for undo — main-thread DB writes only, even when rewrites ran in parallel.
  const finalize = async (
    file: SitemapFileRow,
    inputPath: string,
    newStored: string,
    outputPath: string,
    rewrittenCount: number
  ) => {
    if (rewrittenCount === 0) {
      await unlink(outputPath).catch(() => {});
      return;
    }

    const originalToKeep = file.fixed_file_path ?? file.filename;
    const swapClient = await pool.connect();

    try {
      await swapClient.query("BEGIN");
      await swapClient.query(
        "UPDATE sitemap_files SET filename = $1, fixed_file_path = $2 WHERE id = $3",
        [newStored, originalToKeep, file.id]
      );
      await swapClient.query("COMMIT");
    } catch (error) {
      await swapClient.query("ROLLBACK");
      await unlink(outputPath).catch(() => {});
      throw error;
    } finally {
      swapClient.release();
    }

    if (file.filename !== originalToKeep) {
      await unlink(inputPath).catch(() => {});
    }

    rewrittenLocCount += rewrittenCount;
  };

  const processFile = async (
    file: SitemapFileRow,
    runRewrite: (input: {
      inputPath: string;
      outputPath: string;
      isGzip: boolean;
    }) => Promise<number>
  ) => {
    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      return;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const displayName = displaySourceFilename(sessionId, file.filename);
    const newStored = buildRedirectFixedStoredFilename(
      sessionId,
      displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);

    let rewrittenCount = 0;

    try {
      rewrittenCount = await runRewrite({ inputPath, outputPath, isGzip });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    await finalize(file, inputPath, newStored, outputPath, rewrittenCount);
  };

  logger.info(
    {
      session_id: sessionId,
      pattern_id: patternId,
      files: targets.length,
      replacements: replacements.size,
      structure_filters: structureFilters?.length ?? 0,
      parallel: targets.length >= FILE_REWRITE_PARALLEL_THRESHOLD
    },
    "apply-redirects job started"
  );

  if (targets.length >= FILE_REWRITE_PARALLEL_THRESHOLD) {
    // Parallel: the pool caps concurrency at its thread count, so mapping every
    // target is safe. Re-running a file is a no-op (its <loc> no longer matches),
    // so a retry after a crash is harmless.
    await Promise.all(
      targets.map((file) =>
        processFile(file, (input) =>
          runFileRewriteJob({
            ...input,
            spec: {
              kind: "redirectApply",
              replacements: replacementPairs,
              rule: effectiveRule,
              excludeUrls,
              structureFilters
            }
          }).then((result) => result.rewrittenCount)
        )
      )
    );
  } else {
    const rewriter = applyStructureFilterToRewriter(
      buildRedirectApplyRewriter(replacements, effectiveRule, null, excludeSet),
      structureFilters
    );

    for (const file of targets) {
      await processFile(file, (input) =>
        rewriteSitemapLocFile({ ...input, rewriteUrl: rewriter })
      );
    }
  }

  await invalidateSessionZipCache(sessionId);

  // Mark the pattern as fixed, which is what draws the grey "Fixed" chip in the
  // results table (migration 046).
  //
  // Deliberately here and NOT on the "nothing to rewrite" path above: that path
  // returns without changing a single URL, and claiming a pattern was fixed when
  // nothing happened is the same lie in the other direction as the button
  // vanishing. Reached whenever real work was done — a confirmed pair rewritten
  // in the transaction above, a widened rule applied to the files, or both.
  await pool.query(
    "UPDATE patterns SET redirects_applied_at = now() WHERE id = $1",
    [patternId]
  );

  logger.info(
    {
      session_id: sessionId,
      pattern_id: patternId,
      rewritten_loc_count: rewrittenLocCount
    },
    "apply-redirects job complete"
  );
}
