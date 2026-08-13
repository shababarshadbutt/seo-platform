import type { FastifyBaseLogger } from "fastify";
import type { PoolClient } from "pg";

import { pool } from "../db/pool.js";
import { invalidateSessionZipCache } from "../exports/sessionZipCache.js";
import {
  rewritePatternFiles,
  zeroWorkReason,
  type PatternRewriteContext,
  type PatternRewriteOutcome,
  type PatternRewriteWarning
} from "../sitemaps/patternFileRewrites.js";
import {
  parseStructure,
  transformUrl,
  type ParsedStructure
} from "../sitemaps/transformStructure.js";
import {
  removeStoredFilePaths,
  removeStoredFilenames
} from "../sitemaps/storedFileCleanup.js";
import {
  markPatternJobComplete,
  markPatternJobFailed,
  markPatternJobRunning,
  patternJobFailureMessage,
  patternJobProgress
} from "./patternJobStatus.js";
import type {
  PatternRenameJobData,
  PatternTransformJobData,
  PatternTransformUndoJobData
} from "../queue/maintenanceQueue.js";

// The background half of the Update Pattern modal. These three used to run
// inside the HTTP request; see migrations/031_pattern_structure_jobs.sql for
// why they no longer do.
//
// Transaction shape is deliberate and differs from bulkReplaceJob's per-file
// commits: the whole rewrite is ONE transaction. A transform's undo is only one
// level deep, so a half-applied transform is the thing to avoid — better to
// roll the lot back and let the user retry than to leave a pattern in a state
// undo cannot describe.

type PatternJobPayload = {
  // Rename
  old_template?: string;
  new_template?: string;
  // Transform
  current_structure?: string;
  new_structure?: string;
  // The exact display filenames to rewrite, materialised at enqueue time.
  //
  // Stored in full rather than as a "null = all" sentinel because "all" is
  // ambiguous here: the route derives its default from the pattern's own file
  // breakdown (files that actually contain this pattern), while an empty
  // selection means every file for the source_role — a strictly broader set.
  // Re-deriving at run time would also silently widen the edit to files added
  // after the user pressed Apply. The list is bounded by the session's file
  // count, and payload is never SELECTed by the 2s status poll.
  selected_files?: string[];
  source_role?: string;
  // Rename-undo bookkeeping (the rename route treats "revert to the previous
  // template" as an undo and pops the pattern_renames row).
  is_undo?: boolean;
  rename_row_id?: string;
  occurrence_count?: number;
};

type JobRow = {
  session_id: string;
  pattern_id: string;
  payload: PatternJobPayload;
};

async function loadJob(jobRowId: string): Promise<JobRow> {
  const result = await pool.query<JobRow>(
    "SELECT session_id, pattern_id, payload FROM maintenance_jobs WHERE id = $1",
    [jobRowId]
  );

  if (result.rowCount === 0) {
    throw new Error(`maintenance job ${jobRowId} not found`);
  }

  return result.rows[0];
}

function countSkips(warnings: PatternRewriteWarning[]) {
  return {
    missing: warnings.filter((w) => w.reason === "missing-on-disk").length,
    remote: warnings.filter((w) => w.reason === "remote-source").length,
    noMatch: warnings.filter((w) => w.reason === "no-urls-matched").length
  };
}

// Shared shell: mark RUNNING, open one transaction, run `work`, COMMIT, record
// the result — and on any failure ROLLBACK, clean up the files the rewrite
// wrote, and record a readable error instead of letting it vanish into the
// BullMQ failure log.
async function runPatternJob(
  jobRowId: string,
  logger: FastifyBaseLogger,
  label: string,
  work: (
    tx: PoolClient,
    context: PatternRewriteContext,
    job: JobRow
  ) => Promise<{
    filesDone: number;
    itemsChanged: number;
    warnings: PatternRewriteWarning[];
    result: Record<string, unknown>;
    // Written by this job; unlinked if the transaction rolls back. Absolute
    // paths.
    newFilePaths: string[];
    // Superseded originals; unlinked only after COMMIT. Absolute paths.
    obsoleteFilePaths: string[];
    // Same, but bare stored FILENAMES needing UPLOAD_DIR resolution. The undo
    // path's list comes from pattern_transforms.new_file_paths, which stores
    // filenames despite its name — see sitemaps/storedFileCleanup.ts.
    obsoleteStoredFilenames: string[];
  }>
) {
  const job = await loadJob(jobRowId);

  logger.info(
    { job_row_id: jobRowId, session_id: job.session_id, pattern_id: job.pattern_id },
    `${label} job started`
  );

  const tx = await pool.connect();
  const context: PatternRewriteContext = {
    tx,
    progress: patternJobProgress(jobRowId, logger)
  };
  let newFilePaths: string[] = [];
  let committed = false;

  try {
    await tx.query("BEGIN");

    const outcome = await work(tx, context, job);
    newFilePaths = outcome.newFilePaths;

    await tx.query("COMMIT");
    committed = true;

    // Only now is it safe to drop the superseded originals.
    await removeStoredFilePaths(outcome.obsoleteFilePaths, logger);
    await removeStoredFilenames(outcome.obsoleteStoredFilenames, logger);
    await invalidateSessionZipCache(job.session_id, logger);

    const skips = countSkips(outcome.warnings);

    await markPatternJobComplete(jobRowId, {
      filesDone: outcome.filesDone,
      itemsChanged: outcome.itemsChanged,
      filesSkipped: outcome.warnings.length,
      warnings: outcome.warnings,
      result: outcome.result
    });

    logger.info(
      {
        job_row_id: jobRowId,
        session_id: job.session_id,
        pattern_id: job.pattern_id,
        files_done: outcome.filesDone,
        urls_changed: outcome.itemsChanged,
        files_skipped: outcome.warnings.length,
        skipped_missing: skips.missing,
        skipped_remote: skips.remote,
        skipped_no_match: skips.noMatch
      },
      `${label} job complete`
    );
  } catch (error) {
    await tx.query("ROLLBACK").catch((rollbackError) => {
      logger.error(
        { job_row_id: jobRowId, err: rollbackError },
        `${label} job could not roll back`
      );
    });

    if (!committed) {
      await removeStoredFilePaths(newFilePaths, logger);
    }

    const message = patternJobFailureMessage(error);

    logger.error(
      {
        job_row_id: jobRowId,
        session_id: job.session_id,
        pattern_id: job.pattern_id,
        err: error
      },
      `${label} job failed`
    );
    await markPatternJobFailed(jobRowId, message);
    throw error;
  } finally {
    tx.release();
  }
}

export async function processPatternRenameJob(
  data: PatternRenameJobData,
  logger: FastifyBaseLogger
) {
  await runPatternJob(
    data.job_row_id,
    logger,
    "pattern rename",
    async (tx, context, job) => {
      const payload = job.payload;
      const oldTemplate = payload.old_template ?? "";
      const newTemplate = payload.new_template ?? "";
      const selectedFiles = payload.selected_files ?? [];

      await markPatternJobRunning(data.job_row_id, selectedFiles.length);
      await tx.query("UPDATE patterns SET template = $1 WHERE id = $2", [
        newTemplate,
        job.pattern_id
      ]);

      const rewrite = await rewritePatternFiles(context, {
        sessionId: job.session_id,
        patternId: job.pattern_id,
        sourceRole: payload.source_role ?? "primary",
        selectedDisplayFiles: selectedFiles,
        operation: { kind: "rename", oldTemplate, newTemplate },
        logger,
        // A rename repoints every readable file, even one whose URLs did not
        // match, so its undo can replay the reverse rewrite over the same set.
        keepZeroMatchRewrites: true
      });

      if (payload.is_undo && payload.rename_row_id) {
        await tx.query("DELETE FROM pattern_renames WHERE id = $1", [
          payload.rename_row_id
        ]);
      } else {
        await tx.query(
          `
            INSERT INTO pattern_renames (
              pattern_id, old_template, new_template, source_files,
              occurrence_count, renamed_file_path
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            job.pattern_id,
            oldTemplate,
            newTemplate,
            selectedFiles,
            payload.occurrence_count ?? 0,
            rewrite.newStoredFilenames.length > 0
              ? rewrite.newStoredFilenames.join(",")
              : null
          ]
        );
      }

      return {
        filesDone: rewrite.filesRewritten,
        itemsChanged: rewrite.rewrittenLocCount,
        warnings: rewrite.skipped,
        result: {
          old_template: oldTemplate,
          new_template: newTemplate,
          occurrence_count: payload.occurrence_count ?? 0,
          source_files_count: selectedFiles.length,
          files_rewritten: rewrite.filesRewritten,
          undo: payload.is_undo === true,
          zero_work_reason: zeroWorkReason(rewrite)
        },
        newFilePaths: rewrite.newFilePaths,
        // A rename IS reversible by replaying the reverse rewrite, so the
        // superseded originals are dropped once the transaction commits.
        obsoleteFilePaths: rewrite.oldFilePaths,
        obsoleteStoredFilenames: []
      };
    }
  );
}

export async function processPatternTransformJob(
  data: PatternTransformJobData,
  logger: FastifyBaseLogger
) {
  await runPatternJob(
    data.job_row_id,
    logger,
    "pattern transform",
    async (tx, context, job) => {
      const payload = job.payload;
      const currentStructureRaw = payload.current_structure ?? "";
      const newStructureRaw = payload.new_structure ?? "";
      const current: ParsedStructure = parseStructure(currentStructureRaw);
      const next: ParsedStructure = parseStructure(newStructureRaw);
      const selectedFiles = payload.selected_files ?? [];

      await markPatternJobRunning(data.job_row_id, selectedFiles.length);

      const currentTemplateResult = await tx.query<{ template: string }>(
        "SELECT template FROM patterns WHERE id = $1",
        [job.pattern_id]
      );

      if (currentTemplateResult.rowCount === 0) {
        throw new Error("pattern no longer exists");
      }

      const currentTemplate = currentTemplateResult.rows[0].template;
      const newTemplate = payload.new_template ?? currentTemplate;

      // 1. Rewrite the matching source files on disk.
      const rewrite = await rewritePatternFiles(context, {
        sessionId: job.session_id,
        patternId: job.pattern_id,
        sourceRole: payload.source_role ?? "primary",
        selectedDisplayFiles: selectedFiles,
        operation: {
          kind: "transform",
          currentStructure: currentStructureRaw,
          newStructure: newStructureRaw
        },
        logger,
        // A transform keeps its pre-edit copy for undo, so there is no reason to
        // burn a copy on a file whose URLs did not match.
        keepZeroMatchRewrites: false
      });

      // 2. Transform the bounded sampled URLs, snapshotting the originals.
      const sampled = await tx.query<{ id: string; url: string }>(
        "SELECT id, url FROM sampled_urls WHERE pattern_id = $1",
        [job.pattern_id]
      );
      const sampleBeforeAfter: Array<{ before: string; after: string }> = [];
      const sampledUpdates = sampled.rows
        .map((row) => ({
          id: row.id,
          oldUrl: row.url,
          newUrl: transformUrl(row.url, current, next)
        }))
        .filter(
          (update): update is { id: string; oldUrl: string; newUrl: string } =>
            update.newUrl !== null
        );

      if (sampledUpdates.length > 0) {
        await tx.query(
          `
            UPDATE sampled_urls AS s
            SET url = u.new_url, pre_transform_url = u.old_url
            FROM UNNEST($1::uuid[], $2::text[], $3::text[])
              AS u(id, new_url, old_url)
            WHERE s.id = u.id
          `,
          [
            sampledUpdates.map((u) => u.id),
            sampledUpdates.map((u) => u.newUrl),
            sampledUpdates.map((u) => u.oldUrl)
          ]
        );

        for (const update of sampledUpdates.slice(0, 3)) {
          sampleBeforeAfter.push({ before: update.oldUrl, after: update.newUrl });
        }
      }

      // 3. Transform the bounded pattern_urls sample, snapshotting the path.
      const patternUrls = await tx.query<{
        id: string;
        source_url: string;
        path: string;
      }>("SELECT id, source_url, path FROM pattern_urls WHERE pattern_id = $1", [
        job.pattern_id
      ]);
      const unparsable: string[] = [];
      const patternUrlUpdates = patternUrls.rows
        .map((row) => {
          const newSourceUrl = transformUrl(row.source_url, current, next);

          if (newSourceUrl === null) {
            return null;
          }

          let newPath = row.path;

          try {
            newPath = new URL(newSourceUrl).pathname;
          } catch (error) {
            // Keep the prior path if the rebuilt URL is somehow unparsable —
            // but say so. This used to be a bare catch, so a row left with a
            // stale path was indistinguishable from one that transformed fine.
            unparsable.push(row.source_url);
            logger.warn(
              {
                session_id: job.session_id,
                pattern_id: job.pattern_id,
                source_url: row.source_url,
                rebuilt_url: newSourceUrl,
                err: error
              },
              "transformed URL could not be reparsed; keeping the stored path"
            );
          }

          return { id: row.id, newSourceUrl, newPath };
        })
        .filter(
          (
            update
          ): update is { id: string; newSourceUrl: string; newPath: string } =>
            update !== null
        );

      if (patternUrlUpdates.length > 0) {
        await tx.query(
          `
            UPDATE pattern_urls AS p
            SET source_url = u.new_source_url,
                path = u.new_path,
                original_path = p.path
            FROM UNNEST($1::uuid[], $2::text[], $3::text[])
              AS u(id, new_source_url, new_path)
            WHERE p.id = u.id
          `,
          [
            patternUrlUpdates.map((u) => u.id),
            patternUrlUpdates.map((u) => u.newSourceUrl),
            patternUrlUpdates.map((u) => u.newPath)
          ]
        );
      }

      // 4. Apply the (optional) label rename.
      await tx.query("UPDATE patterns SET template = $1 WHERE id = $2", [
        newTemplate,
        job.pattern_id
      ]);

      // 5. Record the operation for undo — only when something actually
      //    changed, so a no-op transform leaves no phantom undo entry.
      const changedAnything =
        rewrite.newStoredFilenames.length > 0 ||
        sampledUpdates.length > 0 ||
        patternUrlUpdates.length > 0 ||
        newTemplate !== currentTemplate;

      if (changedAnything) {
        await tx.query(
          `
            INSERT INTO pattern_transforms (
              pattern_id, old_template, new_template, current_structure,
              new_structure, source_files, urls_transformed, files_rewritten,
              original_file_paths, new_file_paths
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            job.pattern_id,
            currentTemplate,
            newTemplate,
            currentStructureRaw,
            newStructureRaw,
            selectedFiles,
            rewrite.rewrittenLocCount,
            rewrite.newStoredFilenames.length,
            rewrite.oldStoredFilenames,
            rewrite.newStoredFilenames
          ]
        );
      }

      const warnings: PatternRewriteWarning[] = [...rewrite.skipped];

      return {
        filesDone: rewrite.filesRewritten,
        itemsChanged: rewrite.rewrittenLocCount,
        warnings,
        result: {
          urls_transformed: rewrite.rewrittenLocCount,
          files_rewritten: rewrite.filesRewritten,
          old_template: currentTemplate,
          new_template: newTemplate,
          sample_before_after: sampleBeforeAfter,
          unparsable_url_count: unparsable.length,
          zero_work_reason: zeroWorkReason(rewrite)
        },
        newFilePaths: rewrite.newFilePaths,
        // A transform's pre-edit copies are what undo restores. They must
        // survive the commit.
        obsoleteFilePaths: [],
        obsoleteStoredFilenames: []
      };
    }
  );
}

export async function processPatternTransformUndoJob(
  data: PatternTransformUndoJobData,
  logger: FastifyBaseLogger
) {
  await runPatternJob(
    data.job_row_id,
    logger,
    "pattern transform undo",
    async (tx, _context, job) => {
      const last = await tx.query<{
        id: string;
        old_template: string;
        original_file_paths: string[] | null;
        new_file_paths: string[] | null;
      }>(
        `
          SELECT id, old_template, original_file_paths, new_file_paths
          FROM pattern_transforms
          WHERE pattern_id = $1
          ORDER BY transformed_at DESC
          LIMIT 1
        `,
        [job.pattern_id]
      );

      if (last.rowCount === 0) {
        throw new Error("no transform to undo for this pattern");
      }

      const oldFiles = last.rows[0].original_file_paths ?? [];
      const newFiles = last.rows[0].new_file_paths ?? [];

      await markPatternJobRunning(data.job_row_id, newFiles.length);

      // Undo rewrites NOTHING on disk — it repoints each sitemap_files row back
      // at the pre-transform copy the transform kept. So there is no per-file
      // streaming and no reason to involve the worker pool; the cost is purely
      // database round trips, which is why this is one set-based statement
      // rather than the one-UPDATE-per-file loop it replaced (491 files = 491
      // round trips).
      const pairs = newFiles
        .map((newName, index) => ({ newName, oldName: oldFiles[index] }))
        .filter(
          (pair): pair is { newName: string; oldName: string } =>
            typeof pair.oldName === "string" && pair.oldName !== pair.newName
        );
      let filesRestored = 0;

      if (pairs.length > 0) {
        const restored = await tx.query(
          `
            UPDATE sitemap_files AS f
            SET filename = u.old_name
            FROM UNNEST($2::text[], $3::text[]) AS u(new_name, old_name)
            WHERE f.session_id = $1 AND f.filename = u.new_name
          `,
          [
            job.session_id,
            pairs.map((pair) => pair.newName),
            pairs.map((pair) => pair.oldName)
          ]
        );

        filesRestored = restored.rowCount ?? 0;
      }

      const warnings: PatternRewriteWarning[] = [];

      // Report what actually happened. This used to return newFiles.length —
      // the INTENDED count — so a file whose name had already moved on was
      // reported as restored when the UPDATE had matched nothing.
      if (filesRestored < pairs.length) {
        for (const pair of pairs.slice(filesRestored)) {
          warnings.push({ file: pair.newName, reason: "missing-on-disk" });
        }

        logger.warn(
          {
            session_id: job.session_id,
            pattern_id: job.pattern_id,
            expected: pairs.length,
            restored: filesRestored
          },
          "pattern transform undo restored fewer files than the transform recorded"
        );
      }

      await tx.query("UPDATE patterns SET template = $1 WHERE id = $2", [
        last.rows[0].old_template,
        job.pattern_id
      ]);

      await tx.query(
        `
          UPDATE sampled_urls
          SET url = pre_transform_url, pre_transform_url = NULL
          WHERE pattern_id = $1 AND pre_transform_url IS NOT NULL
        `,
        [job.pattern_id]
      );

      const restore = await tx.query<{
        id: string;
        source_url: string;
        original_path: string;
      }>(
        `
          SELECT id, source_url, original_path
          FROM pattern_urls
          WHERE pattern_id = $1 AND original_path IS NOT NULL
        `,
        [job.pattern_id]
      );
      const restoreUpdates = restore.rows.map((row) => {
        let source = row.source_url;

        try {
          const url = new URL(row.source_url);
          url.pathname = row.original_path;
          source = url.toString();
        } catch (error) {
          // Keep the stored source_url if it can't be reparsed — and record it,
          // rather than leaving a silently unrestored row behind.
          logger.warn(
            {
              session_id: job.session_id,
              pattern_id: job.pattern_id,
              source_url: row.source_url,
              err: error
            },
            "could not rebuild a pattern URL during undo; keeping the stored source_url"
          );
        }

        return { id: row.id, source, path: row.original_path };
      });

      if (restoreUpdates.length > 0) {
        await tx.query(
          `
            UPDATE pattern_urls AS p
            SET source_url = u.source, path = u.path, original_path = NULL
            FROM UNNEST($1::uuid[], $2::text[], $3::text[])
              AS u(id, source, path)
            WHERE p.id = u.id
          `,
          [
            restoreUpdates.map((u) => u.id),
            restoreUpdates.map((u) => u.source),
            restoreUpdates.map((u) => u.path)
          ]
        );
      }

      await tx.query("DELETE FROM pattern_transforms WHERE id = $1", [
        last.rows[0].id
      ]);

      return {
        filesDone: filesRestored,
        itemsChanged: restoreUpdates.length,
        warnings,
        result: {
          undo: true,
          files_restored: filesRestored,
          files_expected: pairs.length,
          template: last.rows[0].old_template
        },
        newFilePaths: [],
        obsoleteFilePaths: [],
        // pattern_transforms.new_file_paths stores bare FILENAMES, so these must
        // be resolved against UPLOAD_DIR. Unlinking them directly is what leaked
        // ~one orphaned copy per file on every undo.
        obsoleteStoredFilenames: pairs.map((pair) => pair.newName)
      };
    }
  );
}
