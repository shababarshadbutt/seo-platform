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
import { applyFileScope } from "../sitemaps/applyFileScope.js";
import { resolveApplyInputs } from "../sitemaps/redirectApply.js";
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

// PROGRESS AND OUTCOME REPORTING (v1.78).
//
// This job used to be silent: no maintenance_jobs row, so no progress, no
// completion, and a throw landed in Redis where the app could never see it. The
// UI toasted once and refreshed after six seconds, which made a long apply and a
// dead one look the same — reported as "the background job is collapsing". v1.77
// then routed far more applies here, so the silence got louder.
//
// Every write is best-effort: a progress row that cannot be updated must never
// fail an apply that is rewriting files correctly. That is the same rule the
// enumeration progress writes in verifyUrlsJob follow, and for the same reason —
// this is bookkeeping about the work, not the work.
async function markApplyJob(
  jobRowId: string | null | undefined,
  set: string,
  params: unknown[],
  logger: FastifyBaseLogger
) {
  if (!jobRowId) {
    return;
  }

  try {
    await pool.query(
      `UPDATE maintenance_jobs SET ${set} WHERE id = $1`,
      [jobRowId, ...params]
    );
  } catch (error) {
    logger.warn(
      { job_row_id: jobRowId, err: error },
      "apply-redirects job: progress write failed"
    );
  }
}

export async function processApplyRedirectsJob(
  data: ApplyRedirectsJobData,
  logger: FastifyBaseLogger
) {
  try {
    await runApplyRedirectsJob(data, logger);
  } catch (error) {
    // The row is what the UI reads, so the failure has to land there before the
    // throw goes on to BullMQ for its own retry/inspection bookkeeping.
    await markApplyJob(
      data.job_row_id,
      "status = 'FAILED', error = $2, completed_at = now()",
      [error instanceof Error ? error.message : String(error)],
      logger
    );

    throw error;
  }
}

async function runApplyRedirectsJob(
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
    // Every early return has to settle the row too, or the UI polls a PENDING
    // job forever — the same "waiting on something that will never finish" state
    // that stranded verification rows produce.
    await markApplyJob(
      data.job_row_id,
      "status = 'FAILED', error = $2, completed_at = now()",
      ["the pattern no longer exists — re-analyse the session"],
      logger
    );

    return;
  }

  const sourceRole = patternResult.rows[0].source_role;

  // EVERY INPUT THIS APPLY REWRITES WITH, from the one builder the route also
  // calls (v1.79). What used to be here read sampled_urls and nothing else: no
  // verified_urls, no per-shape rules, and no widen flag, because the payload had
  // no field to carry one. Those three capabilities existed only on the inline
  // path, and v1.77 made this the path almost every apply takes — so a 187-file
  // pattern rewrote the ten files its sampled rows lived in. See
  // resolveApplyInputs for the whole story.
  const client = await pool.connect();
  let inputs;

  try {
    await client.query("BEGIN");
    inputs = await resolveApplyInputs({
      client,
      sessionId,
      patternId,
      urlIds,
      excludeUrls: data.exclude_urls ?? [],
      inferredUrls,
      approvedRules: data.approved_rules ?? null,
      widenRequested: data.widen === true,
      structureFilters
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    client.release();
    throw error;
  }

  client.release();

  const replacements = inputs.replacements;
  const shapeRules = inputs.shapeRules;
  // Held as an array for the worker-thread spec (it crosses a structuredClone
  // boundary) and as a Set for the in-process rewriter.
  const excludeUrls = data.exclude_urls ?? null;
  const excludeSet =
    excludeUrls && excludeUrls.length > 0 ? new Set(excludeUrls) : null;
  // The rule only sweeps when widening was asked for; otherwise the confirmed
  // exact pairs are the whole edit.
  const effectiveRule = inputs.widen ? inputs.rule : null;

  // Nothing to do only when there is neither a confirmed pair nor a rule to
  // widen with (a rule can rewrite files even with zero confirmed pairs).
  // shapeRules counts as something to do (v1.79). Without it a pattern whose
  // only reach is a stratified verification bailed out here having rewritten
  // nothing — and reported success. The inline route always counted them.
  if (replacements.size === 0 && !effectiveRule && shapeRules.size === 0) {
    logger.info(
      { session_id: sessionId, pattern_id: patternId },
      "apply-redirects job: nothing to rewrite"
    );
    await invalidateSessionZipCache(sessionId);
    // COMPLETED, not FAILED: nothing to rewrite is a valid outcome, and the
    // zero in items_changed is the honest report of it. v1.74 spent a release on
    // exactly this distinction for the inline path.
    await markApplyJob(
      data.job_row_id,
      "status = 'COMPLETED', items_changed = 0, files_done = 0, completed_at = now()",
      [],
      logger
    );

    return;
  }

  // Target files: those this pattern's URLs actually live in. Decided by the
  // shared applyFileScope (v1.75) — this path had it right and the inline route
  // did not, so the fix is for both to ask the same function rather than for
  // this logic to be correct twice.
  const occurrenceResult = await pool.query<{ source_file: string }>(
    "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
    [patternId]
  );
  const targetDisplays = new Set(
    applyFileScope({
      // The job re-reads occurrences rather than carrying the route's candidate
      // set, so it contributes none of its own.
      sampledFiles: [],
      occurrenceFiles: occurrenceResult.rows.map((row) => row.source_file),
      hasReplacements: replacements.size > 0,
      hasRule: effectiveRule !== null || shapeRules.size > 0
    })
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
  // Files finished, for the progress row. Incremented inside processFile so both
  // the parallel and the sequential path count the same way.
  let filesDone = 0;

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

    // One row write per FILE, not per <loc>: on the reported pattern that is 187
    // writes across several minutes, which is what the progress bar needs and
    // nothing like the volume a per-URL write would be. Counted here rather than
    // in the two loops below so the parallel and sequential paths cannot report
    // differently — the divergence v1.75 was spent removing.
    filesDone += 1;
    // BOTH numbers, every file (v1.79). Files carry the progress bar because
    // they have a true denominator; the URL count rides along as a running
    // total so the operator can see work happening between file ticks — on a
    // wide pattern one file can take many seconds. Deliberately NOT reported
    // against the pattern total: only matching <loc>s change, so "of 579,034"
    // would be a denominator the run can never reach.
    await markApplyJob(
      data.job_row_id,
      "files_done = $2, items_changed = $3",
      [filesDone, rewrittenLocCount],
      logger
    );
  };

  await markApplyJob(
    data.job_row_id,
    "status = 'RUNNING', files_total = $2, files_done = 0",
    [targets.length],
    logger
  );

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
              shapeRules: Array.from(shapeRules.entries()),
              excludeUrls,
              structureFilters
            }
          }).then((result) => result.rewrittenCount)
        )
      )
    );
  } else {
    const rewriter = applyStructureFilterToRewriter(
      // shapeRules, not null (v1.79): a stratified verification distils a rule
      // per URL shape, and this branch used to discard every one of them.
      buildRedirectApplyRewriter(
        replacements,
        effectiveRule,
        shapeRules,
        excludeSet
      ),
      structureFilters
    );

    for (const file of targets) {
      await processFile(file, (input) =>
        rewriteSitemapLocFile({ ...input, rewriteUrl: rewriter })
      );
    }
  }

  await invalidateSessionZipCache(sessionId);

  // Mark the pattern as fixed, which is what draws the "Fixed" badge in the
  // results table (migration 046).
  //
  // GATED ON WORK ACTUALLY DONE (v1.74). The comment here used to say this was
  // "reached whenever real work was done", and that was true when the only way
  // past the early return was a confirmed pair. It stopped being true once a RULE
  // could exist without matching anything: the reported case had a rule, swept
  // every file, rewrote zero <loc> entries, and still stamped the pattern Fixed —
  // "0 URLs updated" under a success tick, next to a grey Fixed chip.
  //
  // A pattern is fixed when a URL changed. Nothing else counts.
  if (rewrittenLocCount > 0) {
    await pool.query(
      "UPDATE patterns SET redirects_applied_at = now() WHERE id = $1",
      [patternId]
    );
  }

  // items_changed carries the <loc> count, matching what every other
  // maintenance job puts there — so the completion toast can state the same
  // number the inline path returns as rewritten_loc_count. A run that changed
  // nothing still completes: "0" is a real answer here (v1.74's outcome
  // classification says which of the three reasons it was), and reporting it as
  // a failure would be the older bug in reverse.
  await markApplyJob(
    data.job_row_id,
    "status = 'COMPLETED', items_changed = $2, completed_at = now()",
    [rewrittenLocCount],
    logger
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
