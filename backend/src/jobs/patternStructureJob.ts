import { unlink } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { removeStoredFiles } from "../sitemaps/storedFileCleanup.js";
import { invalidateSessionZipCache } from "../exports/sessionZipCache.js";
import {
  checkTemplateConflict,
  racedTemplateConflictRejection
} from "../sitemaps/patternTemplateConflict.js";
import {
  rewritePatternSourceFilesOnDisk,
  transformPatternSourceFilesOnDisk
} from "../sitemaps/patternFileRewrites.js";
import {
  parseStructure,
  transformUrl,
  type ParsedStructure
} from "../sitemaps/transformStructure.js";
import type { PatternStructureJobData } from "../queue/bulkReplaceQueue.js";

// Pattern rename / structure transform / transform undo, run in the background
// (v1.48). These were synchronous HTTP handlers; on an 823-file / 6.58M-URL
// session the transform measured 136s, so the frontend's 180s timeout fired
// while the server kept going and COMMITted anyway — the user saw a failure for
// work that had actually succeeded, then retried it.
//
// The route still does ALL validation (so bad input is still an immediate 400)
// and records its validated plan in pattern_structure_jobs.params; this file does
// the disk + DB work and publishes progress on that row.
//
// TRANSACTION SHAPE IS DELIBERATELY UNCHANGED. Each operation still runs as ONE
// transaction spanning the whole file rewrite, exactly as the routes did, so a
// failure still rolls back to a clean state and a half-transformed session cannot
// exist. Progress is published from a SEPARATE pooled connection, which is what
// makes "340 of 823" visible while that transaction is still open. (Bulk replace
// commits per file instead because it is resumable by design; a transform's undo
// is one level deep, so partial application is the thing to avoid here.)
//
// DO NOT ADD A RESUME CURSOR HERE. It looks like an obvious win — bulk replace has
// one (bulk_replace_jobs.files_done), and a crashed transform re-does every file
// from the start. It would be a BUG, because there is nothing to resume from:
//
// Verified by killing a worker mid-transform at 10/600 files. The job row was left
// reading RUNNING 10/600, but pattern_transforms held ZERO rows and no
// sitemap_files.filename had moved — the transaction died with the connection and
// Postgres rolled the whole thing back. BullMQ then re-ran the same job (stalled-job
// recovery, which is independent of `attempts: 1` — that only suppresses retries
// after a reported failure) and it correctly redid all 600.
//
// So files_done is a PROGRESS INDICATOR, not a durable cursor: it is written on a
// separate connection precisely so it survives outside the transaction, which means
// it does NOT describe committed work. Skipping the first 10 files on the re-run
// would skip 10 files whose rewrite was rolled back, silently producing a session
// where 10 files kept the old structure and 590 got the new one — the exact
// half-applied state the single transaction exists to prevent, and one the
// one-level-deep undo could not repair.
//
// Bulk replace can resume only because it commits per file, so its cursor points at
// work that is actually on disk and in the DB. Resume is a property of per-file
// commits, not of having a counter.
//
// Known accepted costs of this choice, neither of which resume would fix:
//   * a crash leaks the transformed-* copies the dead attempt had written (its
//     rollback cleanup never ran) — the upload-cleanup safety net reaps them;
//   * with lockDuration at 60 minutes the stalled job is not re-run for up to an
//     hour, and the row reads RUNNING throughout, so the UI shows a stuck bar.
//     That is a recovery-LATENCY problem to solve in the lock/stall settings if it
//     ever bites, not a reason to make the rewrite resumable.

const PROGRESS_FLUSH_EVERY = 10;

type JobRow = {
  session_id: string;
  pattern_id: string;
  kind: string;
  params: {
    new_template?: string;
    current_structure?: string;
    new_structure?: string;
    source_files?: string[];
    occurrence_count?: number;
    is_undo?: boolean;
  };
};

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    `
      UPDATE pattern_structure_jobs
      SET status = 'FAILED', error = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, message]
  );
}

// The message to record for a failure. Every one of these operations runs
// `UPDATE patterns SET template`, so a template collision that RACED past the
// pre-check lands here — and pattern_structure_jobs.error is shown to the user
// verbatim, exactly the path patternTemplateConflict.ts exists to keep the raw
// "duplicate key value violates unique constraint ..." text off the screen. When
// the route was synchronous its catch called racedTemplateConflictRejection; the
// job has to do the same or that guard is lost.
function failureMessage(error: unknown, template: string): string {
  const raced = racedTemplateConflictRejection(error, template);

  if (raced) {
    return raced.body.message;
  }

  return error instanceof Error ? error.message : String(error);
}

async function markComplete(jobRowId: string, result: unknown) {
  await pool.query(
    `
      UPDATE pattern_structure_jobs
      SET status = 'COMPLETE', result = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, JSON.stringify(result)]
  );
}

// Progress writers run on their own pooled connection so they are visible while
// the operation's transaction is still open.
function progressPublisher(jobRowId: string) {
  let lastFlushed = 0;

  return {
    async setTotal(filesTotal: number) {
      await pool.query(
        "UPDATE pattern_structure_jobs SET files_total = $2 WHERE id = $1",
        [jobRowId, filesTotal]
      );
    },
    async onFileDone(filesDone: number) {
      if (filesDone - lastFlushed < PROGRESS_FLUSH_EVERY) {
        return;
      }

      lastFlushed = filesDone;
      await pool.query(
        "UPDATE pattern_structure_jobs SET files_done = $2 WHERE id = $1",
        [jobRowId, filesDone]
      );
    },
    async finish(filesDone: number, urlsRewritten: number) {
      await pool.query(
        `
          UPDATE pattern_structure_jobs
          SET files_done = $2, urls_rewritten = $3
          WHERE id = $1
        `,
        [jobRowId, filesDone, urlsRewritten]
      );
    }
  };
}

async function loadJob(jobRowId: string, logger: FastifyBaseLogger) {
  const result = await pool.query<JobRow>(
    "SELECT session_id, pattern_id, kind, params FROM pattern_structure_jobs WHERE id = $1",
    [jobRowId]
  );

  if (result.rowCount === 0) {
    logger.warn({ job_row_id: jobRowId }, "pattern structure job: row missing");

    return null;
  }

  await pool.query(
    "UPDATE pattern_structure_jobs SET status = 'RUNNING' WHERE id = $1",
    [jobRowId]
  );

  return result.rows[0];
}

// RESOLVED ABSOLUTE PATHS only — the rename rewrite returns real paths
// (path.join'd against uploadDir). Anything that comes out of a DB column holding
// stored FILENAMES must go to removeStoredFiles instead; passing filenames here is
// the bug storedFileCleanup.ts documents.
async function unlinkQuietly(filePaths: string[], logger: FastifyBaseLogger) {
  for (const filePath of filePaths) {
    try {
      await unlink(filePath);
    } catch (error) {
      logger.warn(
        { file_path: filePath, error },
        "failed to remove file during pattern structure cleanup"
      );
    }
  }
}

// ---- Rename ---------------------------------------------------------------

export async function processPatternRenameJob(
  data: PatternStructureJobData,
  logger: FastifyBaseLogger
) {
  const { job_row_id: jobRowId } = data;
  const job = await loadJob(jobRowId, logger);

  if (!job) {
    return;
  }

  const sessionId = job.session_id;
  const patternId = job.pattern_id;
  const newTemplate = job.params.new_template as string;
  const selectedFiles = job.params.source_files ?? [];
  const isUndo = job.params.is_undo === true;
  const progress = progressPublisher(jobRowId);

  const patternResult = await pool.query<{
    template: string;
    source_role: string;
  }>("SELECT template, source_role FROM patterns WHERE id = $1", [patternId]);

  if (patternResult.rowCount === 0) {
    await markFailed(jobRowId, "pattern not found");

    return;
  }

  const currentTemplate = patternResult.rows[0].template;
  const sourceRole = patternResult.rows[0].source_role;

  const client = await pool.connect();
  // Old files are removed only after COMMIT; new files are removed on failure —
  // so a file-write error never destroys the original sitemap.
  let filesToDeleteAfterCommit: string[] = [];
  let filesToDeleteOnError: string[] = [];
  let committed = false;

  logger.info(
    { session_id: sessionId, pattern_id: patternId, job_row_id: jobRowId, isUndo },
    "pattern rename job started"
  );

  try {
    await client.query("BEGIN");
    await client.query("UPDATE patterns SET template = $1 WHERE id = $2", [
      newTemplate,
      patternId
    ]);

    // Reverting to the most recent rename's old_template is an undo: pop that
    // history row instead of recording a new rename (one level of undo).
    const lastRename = await client.query<{ id: string }>(
      "SELECT id FROM pattern_renames WHERE pattern_id = $1 ORDER BY renamed_at DESC LIMIT 1",
      [patternId]
    );

    const rewrite = await rewritePatternSourceFilesOnDisk(client, {
      sessionId,
      sourceRole,
      oldTemplate: currentTemplate,
      newTemplate,
      selectedDisplayFiles: selectedFiles,
      onFilesTotal: (total) => progress.setTotal(total),
      onFileDone: (done) => progress.onFileDone(done)
    });

    filesToDeleteOnError = rewrite.newFilePaths;
    filesToDeleteAfterCommit = rewrite.oldFilePaths;

    if (isUndo) {
      if ((lastRename.rowCount ?? 0) > 0) {
        await client.query("DELETE FROM pattern_renames WHERE id = $1", [
          lastRename.rows[0].id
        ]);
      }
    } else {
      await client.query(
        `
          INSERT INTO pattern_renames (
            pattern_id,
            old_template,
            new_template,
            source_files,
            occurrence_count,
            renamed_file_path
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          patternId,
          currentTemplate,
          newTemplate,
          selectedFiles,
          job.params.occurrence_count ?? 0,
          rewrite.renamedStoredFilenames.length > 0
            ? rewrite.renamedStoredFilenames.join(",")
            : null
        ]
      );
    }

    await client.query("COMMIT");
    committed = true;
    await unlinkQuietly(filesToDeleteAfterCommit, logger);
    await invalidateSessionZipCache(sessionId);
    await progress.finish(
      rewrite.renamedStoredFilenames.length,
      rewrite.rewrittenLocCount
    );

    await markComplete(jobRowId, {
      old_template: currentTemplate,
      new_template: newTemplate,
      occurrence_count: isUndo ? 0 : (job.params.occurrence_count ?? 0),
      source_files_count: isUndo ? 0 : selectedFiles.length,
      files_rewritten: rewrite.renamedStoredFilenames.length,
      ...(isUndo ? { undo: true } : {})
    });

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        files_rewritten: rewrite.renamedStoredFilenames.length,
        urls_rewritten: rewrite.rewrittenLocCount
      },
      "pattern rename job complete"
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (!committed) {
      await unlinkQuietly(filesToDeleteOnError, logger);
    }

    await markFailed(jobRowId, failureMessage(error, newTemplate));
    throw error;
  } finally {
    client.release();
  }
}

// ---- Structure transform --------------------------------------------------

export async function processPatternTransformJob(
  data: PatternStructureJobData,
  logger: FastifyBaseLogger
) {
  const { job_row_id: jobRowId } = data;
  const job = await loadJob(jobRowId, logger);

  if (!job) {
    return;
  }

  const sessionId = job.session_id;
  const patternId = job.pattern_id;
  const currentStructureRaw = job.params.current_structure as string;
  const newStructureRaw = job.params.new_structure as string;
  const selectedFiles = job.params.source_files ?? [];
  const progress = progressPublisher(jobRowId);

  let current: ParsedStructure;
  let next: ParsedStructure;

  try {
    current = parseStructure(currentStructureRaw);
    next = parseStructure(newStructureRaw);
  } catch (error) {
    // The route already parsed these, so this is unreachable in practice —
    // recorded rather than thrown so it cannot become a silent retry loop.
    await markFailed(
      jobRowId,
      error instanceof Error ? error.message : String(error)
    );

    return;
  }

  const patternResult = await pool.query<{
    template: string;
    source_role: string;
  }>("SELECT template, source_role FROM patterns WHERE id = $1", [patternId]);

  if (patternResult.rowCount === 0) {
    await markFailed(jobRowId, "pattern not found");

    return;
  }

  const currentTemplate = patternResult.rows[0].template;
  const sourceRole = patternResult.rows[0].source_role;
  const newTemplate =
    typeof job.params.new_template === "string" &&
    job.params.new_template.trim().length > 0
      ? job.params.new_template
      : currentTemplate;

  // Re-checked here, not just in the route: the route's pre-check ran before the
  // job was queued, and another pattern could have taken this template while the
  // job sat in the queue. Failing at the final DB write would leave the sitemaps
  // already rewritten on disk (the same reason processBulkReplaceJob re-checks).
  if (newTemplate !== currentTemplate) {
    const collision = await checkTemplateConflict(pool, {
      sessionId,
      sourceRole,
      template: newTemplate,
      excludePatternId: patternId
    });

    if (collision) {
      await markFailed(jobRowId, collision.body.message);

      return;
    }
  }

  const rewriteUrl = (url: string) => transformUrl(url, current, next);
  const client = await pool.connect();
  // New files are removed on ROLLBACK; pre-transform originals are KEPT (undo
  // restores them), so there is nothing to delete after COMMIT.
  let filesToDeleteOnError: string[] = [];
  let committed = false;
  const sampleBeforeAfter: Array<{ before: string; after: string }> = [];

  logger.info(
    { session_id: sessionId, pattern_id: patternId, job_row_id: jobRowId },
    "pattern transform job started"
  );

  try {
    await client.query("BEGIN");

    // 1. Rewrite the matching source files on disk.
    const rewrite = await transformPatternSourceFilesOnDisk(client, {
      sessionId,
      sourceRole,
      selectedDisplayFiles: selectedFiles,
      currentStructure: currentStructureRaw,
      newStructure: newStructureRaw,
      rewriteUrl,
      onFilesTotal: (total) => progress.setTotal(total),
      onFileDone: (done) => progress.onFileDone(done)
    });
    filesToDeleteOnError = rewrite.newFilePaths;

    // 2. Transform the bounded sampled URLs, snapshotting the originals.
    const sampled = await client.query<{ id: string; url: string }>(
      "SELECT id, url FROM sampled_urls WHERE pattern_id = $1",
      [patternId]
    );
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
      await client.query(
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

    // 3. Transform the bounded pattern_urls sample (drives re-sampling),
    //    snapshotting the original path. source_url is kept in sync by swapping
    //    its pathname so undo can rebuild it from original_path.
    const patternUrls = await client.query<{
      id: string;
      source_url: string;
      path: string;
    }>("SELECT id, source_url, path FROM pattern_urls WHERE pattern_id = $1", [
      patternId
    ]);
    const patternUrlUpdates = patternUrls.rows
      .map((row) => {
        const newSourceUrl = transformUrl(row.source_url, current, next);

        if (newSourceUrl === null) {
          return null;
        }

        let newPath = row.path;

        try {
          newPath = new URL(newSourceUrl).pathname;
        } catch {
          // Keep the prior path if the rebuilt URL is somehow unparsable.
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
      await client.query(
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
    await client.query("UPDATE patterns SET template = $1 WHERE id = $2", [
      newTemplate,
      patternId
    ]);

    // 5. Record the operation for undo — only when something actually changed,
    //    so a no-op transform doesn't leave a phantom undo entry.
    const changedAnything =
      rewrite.newStoredFilenames.length > 0 ||
      sampledUpdates.length > 0 ||
      patternUrlUpdates.length > 0 ||
      newTemplate !== currentTemplate;

    if (changedAnything) {
      await client.query(
        `
          INSERT INTO pattern_transforms (
            pattern_id,
            old_template,
            new_template,
            current_structure,
            new_structure,
            source_files,
            urls_transformed,
            files_rewritten,
            original_file_paths,
            new_file_paths
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          patternId,
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

    await client.query("COMMIT");
    committed = true;
    await invalidateSessionZipCache(sessionId);
    await progress.finish(
      rewrite.newStoredFilenames.length,
      rewrite.rewrittenLocCount
    );

    await markComplete(jobRowId, {
      urls_transformed: rewrite.rewrittenLocCount,
      files_rewritten: rewrite.newStoredFilenames.length,
      old_template: currentTemplate,
      new_template: newTemplate,
      sample_before_after: sampleBeforeAfter
    });

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        files_rewritten: rewrite.newStoredFilenames.length,
        urls_transformed: rewrite.rewrittenLocCount
      },
      "pattern transform job complete"
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    if (!committed) {
      await unlinkQuietly(filesToDeleteOnError, logger);
    }

    await markFailed(jobRowId, failureMessage(error, newTemplate));
    throw error;
  } finally {
    client.release();
  }
}

// ---- Transform undo -------------------------------------------------------

export async function processPatternTransformUndoJob(
  data: PatternStructureJobData,
  logger: FastifyBaseLogger
) {
  const { job_row_id: jobRowId } = data;
  const job = await loadJob(jobRowId, logger);

  if (!job) {
    return;
  }

  const sessionId = job.session_id;
  const patternId = job.pattern_id;
  const progress = progressPublisher(jobRowId);

  const last = await pool.query<{
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
    [patternId]
  );

  if (last.rowCount === 0) {
    await markFailed(jobRowId, "no transform to undo for this pattern");

    return;
  }

  const undoTemplate = last.rows[0].old_template;
  const oldFiles = last.rows[0].original_file_paths ?? [];
  const newFiles = last.rows[0].new_file_paths ?? [];

  await progress.setTotal(newFiles.length);

  const client = await pool.connect();
  // Undo only ever deletes the post-transform copies, and only after COMMIT —
  // there is nothing to clean up on the failure path. These are stored FILENAMES
  // from pattern_transforms.new_file_paths, not resolved paths, so they go to
  // removeStoredFiles (see storedFileCleanup.ts for the leak that caused).
  let storedFilesToDeleteAfterCommit: string[] = [];

  logger.info(
    { session_id: sessionId, pattern_id: patternId, files: newFiles.length },
    "pattern transform undo job started"
  );

  try {
    await client.query("BEGIN");

    // Repoint each transformed file back to its pre-transform copy.
    for (let index = 0; index < newFiles.length; index += 1) {
      await client.query(
        "UPDATE sitemap_files SET filename = $1 WHERE session_id = $2 AND filename = $3",
        [oldFiles[index], sessionId, newFiles[index]]
      );
      await progress.onFileDone(index + 1);
    }

    storedFilesToDeleteAfterCommit = newFiles.filter(
      (file, index) => file !== oldFiles[index]
    );

    await client.query("UPDATE patterns SET template = $1 WHERE id = $2", [
      undoTemplate,
      patternId
    ]);

    await client.query(
      `
        UPDATE sampled_urls
        SET url = pre_transform_url, pre_transform_url = NULL
        WHERE pattern_id = $1 AND pre_transform_url IS NOT NULL
      `,
      [patternId]
    );

    const restore = await client.query<{
      id: string;
      source_url: string;
      original_path: string;
    }>(
      `
        SELECT id, source_url, original_path
        FROM pattern_urls
        WHERE pattern_id = $1 AND original_path IS NOT NULL
      `,
      [patternId]
    );
    const restoreUpdates = restore.rows.map((row) => {
      let source = row.source_url;

      try {
        const url = new URL(row.source_url);
        url.pathname = row.original_path;
        source = url.toString();
      } catch {
        // Keep the stored source_url if it can't be reparsed.
      }

      return { id: row.id, source, path: row.original_path };
    });

    if (restoreUpdates.length > 0) {
      await client.query(
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

    await client.query("DELETE FROM pattern_transforms WHERE id = $1", [
      last.rows[0].id
    ]);
    await client.query("COMMIT");

    const cleanup = await removeStoredFiles(
      config.uploadDir,
      storedFilesToDeleteAfterCommit,
      logger
    );

    await invalidateSessionZipCache(sessionId);
    await progress.finish(newFiles.length, 0);

    await markComplete(jobRowId, {
      undo: true,
      files_restored: newFiles.length,
      template: undoTemplate
    });

    logger.info(
      {
        session_id: sessionId,
        pattern_id: patternId,
        // Logged so a repeat of the silent-leak bug is visible in the logs rather
        // than only on a disk-usage graph.
        copies_removed: cleanup.removed.length,
        copies_already_gone: cleanup.missing.length,
        copies_failed: cleanup.failed.length
      },
      "pattern transform undo job complete"
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    // Undo restores old_template, which another pattern may have taken since the
    // transform ran — the same raced collision, same friendly message.
    await markFailed(jobRowId, failureMessage(error, undoTemplate));
    throw error;
  } finally {
    client.release();
  }
}
