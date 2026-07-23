import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { collectProblemFileGroups } from "../sitemaps/problemFiles.js";
import { rebuildSessionDeletions } from "../sitemaps/urlDeletion.js";
import { invalidateSessionZipCache } from "../exports/sessionZipCache.js";
import {
  applyTrailingSlash,
  undoTrailingSlash
} from "../sitemaps/trailingSlashApply.js";
import type {
  DeleteProblemUrlsJobData,
  FixTrailingSlashesJobData,
  FixTrailingSlashesUndoJobData,
  RestoreDeletedUrlsJobData
} from "../queue/maintenanceQueue.js";

// Persist progress every N files so the status endpoint has something live and a
// crash resumes from roughly here.
const PROGRESS_FLUSH_EVERY = 10;

async function markRunning(jobRowId: string, filesTotal: number) {
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'RUNNING', files_total = $2, files_done = 0 WHERE id = $1",
    [jobRowId, filesTotal]
  );
}

async function markComplete(
  jobRowId: string,
  filesDone: number,
  itemsChanged: number
) {
  await pool.query(
    `
      UPDATE maintenance_jobs
      SET status = 'COMPLETE', files_done = $2, items_changed = $3, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, filesDone, itemsChanged]
  );
}

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'FAILED', error = $2 WHERE id = $1",
    [jobRowId, message]
  );
}

function progressFlusher(jobRowId: string) {
  return async (filesDone: number, _filesTotal: number, itemsChanged: number) => {
    if (filesDone % PROGRESS_FLUSH_EVERY === 0) {
      await pool.query(
        "UPDATE maintenance_jobs SET files_done = $2, items_changed = $3 WHERE id = $1",
        [jobRowId, filesDone, itemsChanged]
      );
    }
  };
}

export async function processDeleteProblemUrlsJob(
  data: DeleteProblemUrlsJobData,
  logger: FastifyBaseLogger
) {
  const {
    session_id: sessionId,
    job_row_id: jobRowId,
    file_displays: fileDisplays,
    statuses,
    urls
  } = data;

  logger.info(
    {
      session_id: sessionId,
      job_row_id: jobRowId,
      files: fileDisplays.length,
      statuses
    },
    "delete problem urls job started"
  );

  try {
    // Scan the selected files to find exactly which confirmed problem URLs (of
    // the requested statuses) physically appear in them — the same match the
    // rebuild uses. Then mark only those URLs deleted, scoped to the selected
    // files. This keeps the is_deleted_from_sitemap flag honest (set only for
    // URLs actually removed) even for multi-file patterns whose source_file is a
    // comma-joined list.
    const groups = await collectProblemFileGroups({
      sessionId,
      // Explicit URL list (redirect-modal delete) takes precedence over the
      // status filter (Delete Problem URLs feature).
      ...(urls ? { urls } : { statuses }),
      restrictToDisplays: fileDisplays
    });

    const urlIds = Array.from(
      new Set(groups.flatMap((group) => group.url_ids))
    );

    await markRunning(jobRowId, fileDisplays.length);

    if (urlIds.length > 0) {
      await pool.query(
        `
          UPDATE sampled_urls AS s
          SET is_deleted_from_sitemap = true,
              deleted_from_files = $2::text[]
          FROM patterns p
          WHERE p.id = s.pattern_id
            AND p.session_id = $1
            AND s.id = ANY($3::uuid[])
        `,
        [sessionId, fileDisplays, urlIds]
      );
    }

    // Rebuild only the selected files from their originals against the updated
    // deleted-set. removeUrlBlocksFromFile strips EVERY matching <loc>, so all
    // confirmed problem URLs in each file go, not just the sampled preview.
    const { urlsRemoved } = await rebuildSessionDeletions({
      sessionId,
      scope: fileDisplays,
      onProgress: progressFlusher(jobRowId)
    });

    await markComplete(jobRowId, fileDisplays.length, urlsRemoved);
    await invalidateSessionZipCache(sessionId);
    logger.info(
      { session_id: sessionId, job_row_id: jobRowId, urlsRemoved },
      "delete problem urls job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobRowId, message);
    throw error;
  }
}

export async function processRestoreDeletedUrlsJob(
  data: RestoreDeletedUrlsJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, job_row_id: jobRowId } = data;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId },
    "restore deleted urls job started"
  );

  try {
    // Clear all deletion marks for the session, then rebuild every file (each
    // now has an empty deleted-set and is restored to its original).
    await pool.query(
      `
        UPDATE sampled_urls AS s
        SET is_deleted_from_sitemap = false, deleted_from_files = NULL
        FROM patterns p
        WHERE p.id = s.pattern_id
          AND p.session_id = $1
          AND s.is_deleted_from_sitemap = true
      `,
      [sessionId]
    );

    const filesResult = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM sitemap_files
        WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
      `,
      [sessionId]
    );
    await markRunning(jobRowId, Number(filesResult.rows[0]?.count ?? 0));

    await rebuildSessionDeletions({
      sessionId,
      scope: "all",
      onProgress: progressFlusher(jobRowId)
    });

    await markComplete(jobRowId, Number(filesResult.rows[0]?.count ?? 0), 0);
    await invalidateSessionZipCache(sessionId);
    logger.info(
      { session_id: sessionId, job_row_id: jobRowId },
      "restore deleted urls job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobRowId, message);
    throw error;
  }
}

export async function processFixTrailingSlashesJob(
  data: FixTrailingSlashesJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, job_row_id: jobRowId } = data;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId },
    "fix trailing slashes job started"
  );

  try {
    // files_total is finalized inside applyTrailingSlash's progress; seed with a
    // rough count so the status endpoint is populated immediately.
    await markRunning(jobRowId, 0);

    const { urlsFixed } = await applyTrailingSlash({
      sessionId,
      selectedFiles: data.selected_files,
      onProgress: async (filesDone, filesTotal, urls) => {
        await pool.query(
          "UPDATE maintenance_jobs SET files_total = $2, files_done = $3, items_changed = $4 WHERE id = $1",
          [jobRowId, filesTotal, filesDone, urls]
        );
      }
    });

    await pool.query(
      `
        UPDATE maintenance_jobs
        SET status = 'COMPLETE',
            files_done = files_total,
            items_changed = $2,
            completed_at = now()
        WHERE id = $1
      `,
      [jobRowId, urlsFixed]
    );
    // Stamp when this session last had trailing slashes applied, so the UI can
    // warn before silently re-running the fix (v1.31 Fix 4).
    await pool.query(
      "UPDATE sessions SET trailing_slash_fixed_at = now() WHERE id = $1",
      [sessionId]
    );
    await invalidateSessionZipCache(sessionId);
    logger.info(
      { session_id: sessionId, job_row_id: jobRowId, urlsFixed },
      "fix trailing slashes job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobRowId, message);
    // The fix did not fully complete — make sure the session is NOT left looking
    // "already applied" so the user can retry (v1.32). trailing_slash_fixed_at is
    // only ever stamped on the success path above; clearing here also covers a
    // stalled/re-run job that partially stamped before throwing.
    await pool
      .query(
        "UPDATE sessions SET trailing_slash_fixed_at = NULL WHERE id = $1",
        [sessionId]
      )
      .catch(() => {});
    throw error;
  }
}

export async function processFixTrailingSlashesUndoJob(
  data: FixTrailingSlashesUndoJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, job_row_id: jobRowId } = data;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId },
    "fix trailing slashes undo job started"
  );

  try {
    await pool.query(
      "UPDATE maintenance_jobs SET status = 'UNDOING', files_done = 0 WHERE id = $1",
      [jobRowId]
    );

    await undoTrailingSlash({
      sessionId,
      onProgress: async (filesDone, filesTotal, _urls) => {
        await pool.query(
          "UPDATE maintenance_jobs SET files_total = $2, files_done = $3 WHERE id = $1",
          [jobRowId, filesTotal, filesDone]
        );
      }
    });

    await pool.query(
      "UPDATE maintenance_jobs SET status = 'UNDONE', completed_at = now() WHERE id = $1",
      [jobRowId]
    );
    // Slashes are no longer applied → clear the stamp so the re-run warning
    // doesn't fire on a session that's back to its pre-fix state (v1.31 Fix 4).
    await pool.query(
      "UPDATE sessions SET trailing_slash_fixed_at = NULL WHERE id = $1",
      [sessionId]
    );
    await invalidateSessionZipCache(sessionId);
    logger.info(
      { session_id: sessionId, job_row_id: jobRowId },
      "fix trailing slashes undo job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markFailed(jobRowId, message);
    throw error;
  }
}
