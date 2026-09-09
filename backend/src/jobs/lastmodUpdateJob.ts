import { unlink } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { isHttpUrl, displaySourceFilename } from "../sitemaps/filenames.js";
import {
  rewriteLastmodTargetFiles,
  type LastmodTarget
} from "../sitemaps/lastmodFileRewrites.js";
import { enumeratePopulation, type PatternRow } from "./patternPopulation.js";
import { withPublishLock } from "../publish/publishLock.js";
import { resolvePublishTarget } from "../publish/publishTarget.js";
import { buildPublishPlan, executePublish } from "../publish/s3Publish.js";

// The Lastmod Updater's job: rewrite <lastmod> for the scope recorded on the
// lastmod_update_jobs row, then publish — one traceable unit, one job row,
// spanning both phases (status moves PENDING -> RUNNING -> PUBLISHING ->
// COMPLETE/FAILED). Modeled on jobs/patternStructureJob.ts (background rewrite
// + progress on a separate connection) with the publish step folded in rather
// than chained as a second queued job, so there is one place to poll for the
// whole "update + push" action the UI presents as a single button.
//
// TRANSACTION SHAPE: the rewrite runs inside ONE transaction, exactly like
// rename/transform, so a failure rolls back to a clean state rather than
// leaving some files updated and others not. The publish step runs AFTER that
// transaction commits — publishing is its own already-battle-tested unit
// (s3Publish.ts) with its own audit trail (publish_runs) and its own lock
// (withPublishLock), so it is invoked directly rather than reimplemented here.

const PROGRESS_FLUSH_EVERY = 10;

type LastmodScope =
  | { type: "all" }
  | { type: "files"; filenames: string[] }
  | { type: "patterns"; pattern_ids: string[] };

type JobRow = {
  session_id: string;
  params: { scope: LastmodScope; target_date: string };
};

async function loadJob(jobRowId: string, logger: FastifyBaseLogger) {
  const result = await pool.query<JobRow>(
    "SELECT session_id, params FROM lastmod_update_jobs WHERE id = $1",
    [jobRowId]
  );

  if (result.rowCount === 0) {
    logger.warn({ job_row_id: jobRowId }, "lastmod update job: row missing");

    return null;
  }

  await pool.query(
    "UPDATE lastmod_update_jobs SET status = 'RUNNING' WHERE id = $1",
    [jobRowId]
  );

  return result.rows[0];
}

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    `
      UPDATE lastmod_update_jobs
      SET status = 'FAILED', error = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, message]
  );
}

async function markComplete(jobRowId: string, result: unknown) {
  await pool.query(
    `
      UPDATE lastmod_update_jobs
      SET status = 'COMPLETE', result = $2, completed_at = now()
      WHERE id = $1
    `,
    [jobRowId, JSON.stringify(result)]
  );
}

function progressPublisher(jobRowId: string) {
  let lastFlushed = 0;

  return {
    async setTotal(filesTotal: number) {
      await pool.query(
        "UPDATE lastmod_update_jobs SET files_total = $2 WHERE id = $1",
        [jobRowId, filesTotal]
      );
    },
    async onFileDone(filesDone: number) {
      if (filesDone - lastFlushed < PROGRESS_FLUSH_EVERY) {
        return;
      }

      lastFlushed = filesDone;
      await pool.query(
        "UPDATE lastmod_update_jobs SET files_done = $2 WHERE id = $1",
        [jobRowId, filesDone]
      );
    },
    async finish(filesDone: number, urlsRewritten: number) {
      await pool.query(
        `
          UPDATE lastmod_update_jobs
          SET files_done = $2, urls_rewritten = $3
          WHERE id = $1
        `,
        [jobRowId, filesDone, urlsRewritten]
      );
    }
  };
}

type CandidateFile = { id: string; filename: string };

async function loadCurrentFiles(sessionId: string): Promise<CandidateFile[]> {
  const result = await pool.query<CandidateFile>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1
        AND source_role = 'current'
        AND is_deleted = false
        AND is_index = false
      ORDER BY filename ASC
    `,
    [sessionId]
  );

  return result.rows.filter((row) => !isHttpUrl(row.filename));
}

// Resolve the job's scope into the exact files (and, for "patterns", the exact
// <loc> values within them) the rewrite should touch.
async function resolveTargets(
  sessionId: string,
  scope: LastmodScope,
  logger: FastifyBaseLogger
): Promise<LastmodTarget[]> {
  if (scope.type === "all") {
    const files = await loadCurrentFiles(sessionId);

    return files.map((file) => ({ id: file.id, filename: file.filename, urlScope: null }));
  }

  if (scope.type === "files") {
    const selected = new Set(scope.filenames);
    const files = await loadCurrentFiles(sessionId);

    return files
      .filter((file) => selected.has(displaySourceFilename(sessionId, file.filename)))
      .map((file) => ({ id: file.id, filename: file.filename, urlScope: null }));
  }

  // "patterns": resolve checked pattern ids to their real URL population by
  // streaming every <loc> (enumeratePopulation — the same helper rename/
  // transform/verify use to turn "these pattern ids" into "these files, these
  // exact URLs"), then group by the display filename it reports each URL under.
  //
  // No progress callback here: enumeration is its own read-only scan phase
  // that precedes the rewrite's file-by-file progress, and folding both into
  // one files_done/files_total pair would misreport "340 of 823" during a scan
  // that has not rewritten anything yet. v1 leaves the job row at 0/0 (still
  // RUNNING) for this phase rather than showing a misleading number.
  const patternsResult = await pool.query<{ id: string; template: string }>(
    `
      SELECT id, template
      FROM patterns
      WHERE session_id = $1 AND source_role = 'current' AND id = ANY($2::uuid[])
    `,
    [sessionId, scope.pattern_ids]
  );
  const patterns: PatternRow[] = patternsResult.rows.map((row) => ({
    id: row.id,
    template: row.template
  }));

  if (patterns.length === 0) {
    return [];
  }

  const population = await enumeratePopulation(sessionId, patterns, logger);
  const urlsByDisplayFile = new Map<string, Set<string>>();

  for (const entry of population.values()) {
    for (const displayFile of entry.sourceFiles) {
      const urls = urlsByDisplayFile.get(displayFile);

      if (urls) {
        urls.add(entry.url);
      } else {
        urlsByDisplayFile.set(displayFile, new Set([entry.url]));
      }
    }
  }

  const files = await loadCurrentFiles(sessionId);

  return files
    .map((file): LastmodTarget | null => {
      const displayName = displaySourceFilename(sessionId, file.filename);
      const urlScope = urlsByDisplayFile.get(displayName) ?? null;

      return urlScope ? { id: file.id, filename: file.filename, urlScope } : null;
    })
    .filter((target): target is LastmodTarget => target !== null);
}

export async function processLastmodUpdateJob(
  data: { session_id: string; job_row_id: string },
  logger: FastifyBaseLogger
): Promise<void> {
  const { job_row_id: jobRowId } = data;
  const job = await loadJob(jobRowId, logger);

  if (!job) {
    return;
  }

  const sessionId = job.session_id;
  const { scope, target_date: targetDate } = job.params;
  const progress = progressPublisher(jobRowId);

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId, scope_type: scope.type },
    "lastmod update job started"
  );

  let urlsRewritten = 0;
  let filesTouched = 0;

  const client = await pool.connect();
  let newFilePathsOnError: string[] = [];
  let oldFilePathsAfterCommit: string[] = [];
  let committed = false;

  try {
    const targets = await resolveTargets(sessionId, scope, logger);

    await client.query("BEGIN");

    const rewrite = await rewriteLastmodTargetFiles(client, {
      sessionId,
      targets,
      targetDate,
      onFilesTotal: (total) => progress.setTotal(total),
      onFileDone: (done) => progress.onFileDone(done)
    });

    newFilePathsOnError = rewrite.newFilePaths;
    oldFilePathsAfterCommit = rewrite.oldFilePaths;
    urlsRewritten = rewrite.urlsRewritten;
    filesTouched = rewrite.oldFilePaths.length;

    await client.query("COMMIT");
    committed = true;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => {});
    }

    for (const filePath of newFilePathsOnError) {
      await unlink(filePath).catch(() => {});
    }

    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { session_id: sessionId, job_row_id: jobRowId, error },
      "lastmod update job: rewrite failed"
    );
    await markFailed(jobRowId, message);

    return;
  } finally {
    client.release();
  }

  for (const filePath of oldFilePathsAfterCommit) {
    await unlink(filePath).catch((error: unknown) => {
      logger.warn(
        { session_id: sessionId, file_path: filePath, error },
        "lastmod update job: could not remove superseded file"
      );
    });
  }

  await progress.finish(filesTouched, urlsRewritten);

  // Rewrite committed. Now publish — reusing the exact plan/execute path an
  // ordinary session publish uses, so the destination is derived by the same
  // rule (resolvePublishTarget) and every current file gets uploaded, not just
  // the ones this run touched.
  await pool.query("UPDATE lastmod_update_jobs SET status = 'PUBLISHING' WHERE id = $1", [
    jobRowId
  ]);

  if (!config.awsPublishEnabled) {
    await markFailed(
      jobRowId,
      `Updated <lastmod> on ${filesTouched} file(s) (${urlsRewritten} URL(s)), but S3 publish is disabled on this deployment (AWS_PUBLISH_ENABLED is not true).`
    );

    return;
  }

  try {
    const target = await resolvePublishTarget(sessionId);

    await withPublishLock(target.prefixDomain, async () => {
      const plan = await buildPublishPlan(sessionId, target);
      const publishResult = await executePublish(plan, {
        today: new Date().toISOString().slice(0, 10)
      });

      await markComplete(jobRowId, {
        files_touched: filesTouched,
        urls_rewritten: urlsRewritten,
        target_date: targetDate,
        published: {
          uploaded: publishResult.uploaded,
          bytes: publishResult.bytes,
          index_key: publishResult.index_key,
          failed_files: publishResult.failed_files,
          invalidation: publishResult.invalidation
        }
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error(
      { session_id: sessionId, job_row_id: jobRowId, error },
      "lastmod update job: publish failed after a successful rewrite"
    );
    await markFailed(
      jobRowId,
      `Updated <lastmod> on ${filesTouched} file(s) (${urlsRewritten} URL(s)), but publishing to S3 failed: ${message}`
    );
  }
}
