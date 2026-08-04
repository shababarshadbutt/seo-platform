import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { invalidateSessionZipCache } from "../exports/sessionZipCache.js";
import {
  buildBulkReplacedStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "../sitemaps/filenames.js";
import { checkTemplateConflict } from "../sitemaps/patternTemplateConflict.js";
import {
  buildPatternTemplateRewriter,
  rewriteSitemapLocFile
} from "../sitemaps/rewriteLocs.js";
import {
  FILE_REWRITE_PARALLEL_THRESHOLD,
  runFileRewriteJob
} from "./fileRewritePool.js";
import type {
  BulkReplaceJobData,
  BulkReplaceUndoJobData
} from "../queue/bulkReplaceQueue.js";

// Persist progress to the DB every N files so the status endpoint has something
// live to report and a crash resumes from roughly here (files_done doubles as
// the resume cursor).
const PROGRESS_FLUSH_EVERY = 10;

type SitemapFileRow = {
  id: string;
  filename: string;
  bulk_replace_original_path: string | null;
};

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    "UPDATE bulk_replace_jobs SET status = 'FAILED', error = $2 WHERE id = $1",
    [jobRowId, message]
  );
}

// Rename the pattern's template and transform its sampled URLs so the results
// table + drawer reflect the new pattern. Sampled URL categories/hit flags are
// untouched, so redirect_pct / confidence_pct are unchanged — no recompute
// needed (unlike apply-redirects, which does flip categories).
async function applyDbPatternChange(
  patternId: string,
  fromPattern: string,
  toPattern: string
) {
  const rewrite = buildPatternTemplateRewriter(fromPattern, toPattern);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("UPDATE patterns SET template = $2 WHERE id = $1", [
      patternId,
      toPattern
    ]);

    const sampled = await client.query<{ id: string; url: string }>(
      "SELECT id, url FROM sampled_urls WHERE pattern_id = $1",
      [patternId]
    );
    const updates = sampled.rows
      .map((row) => ({ id: row.id, newUrl: rewrite(row.url) }))
      .filter(
        (update): update is { id: string; newUrl: string } =>
          update.newUrl !== null
      );

    if (updates.length > 0) {
      await client.query(
        `
          UPDATE sampled_urls AS s
          SET url = u.new_url
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, new_url)
          WHERE s.id = u.id
        `,
        [updates.map((u) => u.id), updates.map((u) => u.newUrl)]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Reverse of applyDbPatternChange: rename the pattern (currently named
// toPattern) back to fromPattern and reverse-transform its sampled URLs. The
// transform is bijective on matching URLs, so applying it in the to→from
// direction exactly restores the originals — no stored copy needed.
async function revertDbPatternChange(
  sessionId: string,
  fromPattern: string,
  toPattern: string
) {
  const rewrite = buildPatternTemplateRewriter(toPattern, fromPattern);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const patternResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM patterns
        WHERE session_id = $1 AND source_role = 'current' AND template = $2
      `,
      [sessionId, toPattern]
    );

    if (patternResult.rowCount && patternResult.rowCount > 0) {
      const patternId = patternResult.rows[0].id;

      // The undo restores `fromPattern`, which another pattern may have taken
      // since the bulk replace ran. Same violation, and this job's catch also
      // reports error.message to the UI — so check inside the transaction (the
      // check and the UPDATE then share one snapshot, which the HTTP routes
      // cannot do because their pre-check runs on the pool before BEGIN).
      const collision = await checkTemplateConflict(client, {
        sessionId,
        sourceRole: "current",
        template: fromPattern,
        excludePatternId: patternId
      });

      if (collision) {
        throw new Error(collision.body.message);
      }

      await client.query("UPDATE patterns SET template = $2 WHERE id = $1", [
        patternId,
        fromPattern
      ]);

      const sampled = await client.query<{ id: string; url: string }>(
        "SELECT id, url FROM sampled_urls WHERE pattern_id = $1",
        [patternId]
      );
      const updates = sampled.rows
        .map((row) => ({ id: row.id, newUrl: rewrite(row.url) }))
        .filter(
          (update): update is { id: string; newUrl: string } =>
            update.newUrl !== null
        );

      if (updates.length > 0) {
        await client.query(
          `
            UPDATE sampled_urls AS s
            SET url = u.new_url
            FROM UNNEST($1::uuid[], $2::text[]) AS u(id, new_url)
            WHERE s.id = u.id
          `,
          [updates.map((u) => u.id), updates.map((u) => u.newUrl)]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Undo a completed bulk replace: restore every rewritten file to its preserved
// pre-bulk original, delete the orphaned bulk copies, and revert the DB pattern
// + sampled URLs. Reuses the original bulk_replace_jobs row for progress
// (status UNDOING → UNDONE) so the same status endpoint drives its progress.
export async function processBulkReplaceUndoJob(
  data: BulkReplaceUndoJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, job_row_id: jobRowId } = data;

  const rowResult = await pool.query<{
    from_pattern: string;
    to_pattern: string;
  }>("SELECT from_pattern, to_pattern FROM bulk_replace_jobs WHERE id = $1", [
    jobRowId
  ]);

  if (rowResult.rowCount === 0) {
    logger.warn({ job_row_id: jobRowId }, "bulk replace undo: job row missing");
    return;
  }

  const { from_pattern: fromPattern, to_pattern: toPattern } =
    rowResult.rows[0];

  const filesResult = await pool.query<SitemapFileRow>(
    `
      SELECT id, filename, bulk_replace_original_path
      FROM sitemap_files
      WHERE session_id = $1
        AND source_role = 'current'
        AND bulk_replace_original_path IS NOT NULL
      ORDER BY filename ASC
    `,
    [sessionId]
  );
  const files = filesResult.rows;

  await pool.query(
    "UPDATE bulk_replace_jobs SET status = 'UNDOING', files_total = $2, files_done = 0 WHERE id = $1",
    [jobRowId, files.length]
  );

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId, files: files.length },
    "bulk replace undo started"
  );

  try {
    let filesDone = 0;

    for (const file of files) {
      const original = file.bulk_replace_original_path as string;
      const bulkPath = path.join(config.uploadDir, file.filename);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE sitemap_files SET filename = $1, bulk_replace_original_path = NULL WHERE id = $2",
          [original, file.id]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      // Remove the now-orphaned bulk copy (never the restored original).
      if (file.filename !== original) {
        await unlink(bulkPath).catch(() => {});
      }

      filesDone += 1;

      if (filesDone % PROGRESS_FLUSH_EVERY === 0) {
        await pool.query(
          "UPDATE bulk_replace_jobs SET files_done = $2 WHERE id = $1",
          [jobRowId, filesDone]
        );
      }
    }

    await revertDbPatternChange(sessionId, fromPattern, toPattern);

    await pool.query(
      `
        UPDATE bulk_replace_jobs
        SET status = 'UNDONE', files_done = $2, completed_at = now()
        WHERE id = $1
      `,
      [jobRowId, files.length]
    );

    await invalidateSessionZipCache(sessionId);
    logger.info(
      { session_id: sessionId, job_row_id: jobRowId },
      "bulk replace undo complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobRowId, message);
    throw error;
  }
}

export async function processBulkReplaceJob(
  data: BulkReplaceJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, job_row_id: jobRowId } = data;
  const fromPattern = data.from_pattern;
  const toPattern = data.to_pattern;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId, fromPattern, toPattern },
    "bulk replace job started"
  );

  // Resolve the target 'current' pattern for this template.
  const patternResult = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM patterns
      WHERE session_id = $1 AND source_role = 'current' AND template = $2
    `,
    [sessionId, fromPattern]
  );

  if (patternResult.rowCount === 0) {
    await markFailed(jobRowId, `no current pattern matches "${fromPattern}"`);
    return;
  }

  const patternId = patternResult.rows[0].id;

  // Same collision as the rename/transform routes — applyDbPatternChange below
  // runs the identical `UPDATE patterns SET template`, and this job's catch feeds
  // error.message straight into bulk_replace_jobs.error, which the UI shows. So
  // without this the raw "duplicate key value violates unique constraint" text
  // reached the user here too, just through a job row instead of an HTTP 500.
  // Checked BEFORE any file is rewritten: failing at the final DB write would
  // leave the sitemaps already rewritten on disk. Returns (not throws) so BullMQ
  // does not retry a failure that cannot succeed, matching the not-found case
  // above.
  const collision = await checkTemplateConflict(pool, {
    sessionId,
    sourceRole: "current",
    template: toPattern,
    excludePatternId: patternId
  });

  if (collision) {
    await markFailed(jobRowId, collision.body.message);
    return;
  }

  // Display filenames that contributed URLs to this pattern.
  const occurrenceResult = await pool.query<{ source_file: string }>(
    "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
    [patternId]
  );
  const targetDisplayFiles = new Set(
    occurrenceResult.rows.map((row) => row.source_file)
  );

  // Current on-disk files, stable order (files_done indexes into this list).
  const filesResult = await pool.query<SitemapFileRow>(
    `
      SELECT id, filename, bulk_replace_original_path
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current'
      ORDER BY filename ASC
    `,
    [sessionId]
  );
  // Optional per-file selection restricts the rewrite to chosen display files.
  const selectedSet =
    data.selected_files && data.selected_files.length > 0
      ? new Set(data.selected_files)
      : null;
  const targets = filesResult.rows.filter((file) => {
    if (isHttpUrl(file.filename)) {
      return false;
    }

    const displayName = displaySourceFilename(sessionId, file.filename);

    return (
      targetDisplayFiles.has(displayName) &&
      (!selectedSet || selectedSet.has(displayName))
    );
  });

  const rewrite = buildPatternTemplateRewriter(fromPattern, toPattern);

  // Enter RUNNING, publish files_total, and read back the resume cursor.
  const runningResult = await pool.query<{
    files_done: number;
    urls_rewritten: string;
  }>(
    `
      UPDATE bulk_replace_jobs
      SET status = 'RUNNING', files_total = $2
      WHERE id = $1
      RETURNING files_done, urls_rewritten
    `,
    [jobRowId, targets.length]
  );
  let filesDone = Number(runningResult.rows[0]?.files_done ?? 0);
  let urlsRewritten = Number(runningResult.rows[0]?.urls_rewritten ?? 0);

  const flushProgress = async () => {
    await pool.query(
      "UPDATE bulk_replace_jobs SET files_done = $2, urls_rewritten = $3 WHERE id = $1",
      [jobRowId, filesDone, urlsRewritten]
    );
  };

  // Swap in the rewritten copy for one file and preserve its pre-bulk original
  // for undo. Main-thread only, so DB writes stay single-threaded even when the
  // rewrites ran in parallel worker threads (v1.32).
  const finalizeBulkFile = async (
    file: SitemapFileRow,
    inputPath: string,
    newStored: string,
    outputPath: string,
    rewrittenCount: number
  ) => {
    if (rewrittenCount === 0) {
      // No matching locs in this file — discard the identical copy.
      await unlink(outputPath).catch(() => {});
      return;
    }

    // Preserve the TRUE pre-bulk original across chained applies so undo fully
    // restores it. On the first apply the current filename IS the original.
    const originalToKeep = file.bulk_replace_original_path ?? file.filename;
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE sitemap_files SET filename = $1, bulk_replace_original_path = $2 WHERE id = $3",
        [newStored, originalToKeep, file.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      await unlink(outputPath).catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // Delete the previous intermediate copy — never the preserved original.
    if (file.filename !== originalToKeep) {
      await unlink(inputPath).catch(() => {});
    }

    urlsRewritten += rewrittenCount;
  };

  // Rewrite one file to a new stored copy via `runRewrite` (inline sequential,
  // or the piscina pool in parallel), then finalize. Skips a source that's gone.
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
      // File already gone — nothing to rewrite; count it and move on.
      filesDone += 1;

      if (filesDone % PROGRESS_FLUSH_EVERY === 0) {
        await flushProgress();
      }

      return;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const displayName = displaySourceFilename(sessionId, file.filename);
    const newStored = buildBulkReplacedStoredFilename(
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

    await finalizeBulkFile(file, inputPath, newStored, outputPath, rewrittenCount);

    filesDone += 1;

    if (filesDone % PROGRESS_FLUSH_EVERY === 0) {
      await flushProgress();
    }
  };

  try {
    if (targets.length >= FILE_REWRITE_PARALLEL_THRESHOLD) {
      // Parallel: the pool caps concurrent rewrites at its thread count, so
      // mapping every target is safe. The resume cursor is not used here —
      // re-running a completed file is a safe no-op (its URLs already match
      // to_pattern and won't re-match from_pattern), so we recount from zero.
      filesDone = 0;
      urlsRewritten = 0;
      await Promise.all(
        targets.map((file) =>
          processFile(file, (input) =>
            runFileRewriteJob({
              ...input,
              spec: { kind: "patternTemplate", from: fromPattern, to: toPattern }
            }).then((result) => result.rewrittenCount)
          )
        )
      );
    } else {
      // Sequential for small sessions, with crash-resume via the files_done
      // cursor. (Reprocessing a done file would be a safe no-op regardless.)
      for (let index = 0; index < targets.length; index += 1) {
        if (index < filesDone) {
          continue;
        }

        await processFile(targets[index], (input) =>
          rewriteSitemapLocFile({ ...input, rewriteUrl: rewrite })
        );
      }
    }

    // Rename the pattern + transform its sampled URLs (DB-side reflection).
    await applyDbPatternChange(patternId, fromPattern, toPattern);

    await pool.query(
      `
        UPDATE bulk_replace_jobs
        SET status = 'COMPLETE',
            files_done = $2,
            urls_rewritten = $3,
            completed_at = now()
        WHERE id = $1
      `,
      [jobRowId, filesDone, urlsRewritten]
    );

    await invalidateSessionZipCache(sessionId);
    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        files_done: filesDone,
        urls_rewritten: urlsRewritten
      },
      "bulk replace job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobRowId, message);
    // Re-throw so BullMQ records the failure and retries (resumes from cursor).
    throw error;
  }
}
