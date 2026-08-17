import { existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { sweepStaleArtifacts } from "../sitemaps/staleArtifactSweep.js";
import { pool } from "../db/pool.js";
import { isZipCacheFresh } from "../exports/sessionZipCache.js";
import { resolveSessionZipPlan } from "../routes/sessions.js";
import { runZipJob } from "./zipPool.js";
import {
  ZIP_MAX_AGE_MS,
  type PreGenerateZipJobData
} from "../queue/preGenerateZipQueue.js";

// Compression level for pre-generated ZIPs. Level 0 = STORE (no compression):
// the SEO team prioritises generation speed over download size — level 9 took
// ~40 min for a 1,000+ file session, level 0 brings it down to a couple of
// minutes (v1.34). Must match the on-demand build (buildSessionZipArchive) so
// cached and streamed downloads are byte-for-byte identical.
const ZIP_COMPRESSION_LEVEL = 0;

// A cached ZIP younger than this is reused instead of being regenerated.
const FRESH_MS = 24 * 60 * 60 * 1000;

// Max build passes before giving up and leaving the cache unset (on-demand
// download then serves a fresh build). Only exceeded if edits keep landing
// during every build — a user can't realistically sustain that.
const MAX_BUILD_ATTEMPTS = 5;

// Names of the pre-generated ZIPs: "<sessionId>-<type>-<YYYY-MM-DD>.zip".
const PRE_GEN_ZIP_NAME =
  /^[0-9a-f-]{36}-(all|edited)-\d{4}-\d{2}-\d{2}\.zip$/i;

export async function processPreGenerateZipJob(
  data: PreGenerateZipJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, type } = data;
  const column = type === "all" ? "zip_all_path" : "zip_edited_path";

  // Skip if a fresh cached ZIP already exists on disk AND it was generated after
  // the last file mutation (so a cache built before an edit is never treated as
  // fresh — that was the staleness bug).
  const existing = await pool.query<{
    path: string | null;
    zip_generated_at: string | null;
    files_mutated_at: string | null;
  }>(
    `SELECT ${column} AS path, zip_generated_at, files_mutated_at FROM sessions WHERE id = $1`,
    [sessionId]
  );

  if (existing.rowCount === 0) {
    return; // session deleted
  }

  const current = existing.rows[0];

  if (
    current.path &&
    current.zip_generated_at &&
    existsSync(current.path) &&
    Date.now() - new Date(current.zip_generated_at).getTime() < FRESH_MS &&
    isZipCacheFresh(current.zip_generated_at, current.files_mutated_at)
  ) {
    logger.info(
      { session_id: sessionId, type },
      "pre-generate-zip skipped (fresh cache)"
    );
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(config.exportDir, `${sessionId}-${type}-${today}.zip`);

  // Build the ZIP, then RECORD it only if no file mutation landed at/after the
  // instant we started reading files (`buildStart`). The record is a single
  // guarded UPDATE (WHERE files_mutated_at < buildStart) so the check-and-write
  // is ATOMIC — an edit can't slip between "verify fresh" and "store path" (that
  // TOCTOU gap is what let a build racing an edit still record a stale cache).
  // zip_generated_at is stamped to buildStart, i.e. the instant the snapshot is
  // valid as-of, so the download freshness gate (zip_generated_at > files_mutated_at)
  // is exact. If the guard rejects (an edit raced us), discard and rebuild.
  //
  // buildStart is read from the DATABASE clock (SELECT now()), the same source
  // as files_mutated_at, so the comparison never depends on the worker and the
  // Postgres container agreeing on the wall clock.
  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt += 1) {
    const buildStart = (
      await pool.query<{ t: Date }>("SELECT now() AS t")
    ).rows[0].t;
    const plan = await resolveSessionZipPlan(sessionId, type);

    if (!plan) {
      // No files of this type (e.g. no edited files) — clear any stale path.
      await pool.query(`UPDATE sessions SET ${column} = NULL WHERE id = $1`, [
        sessionId
      ]);
      return;
    }

    let result: { entries: number; bytes: number };

    try {
      result = await runZipJob({
        sessionId,
        type,
        outputPath: outPath,
        zlibLevel: ZIP_COMPRESSION_LEVEL,
        expectedHost: plan.expectedHost,
        indexXml: plan.indexXml,
        indexName: plan.indexName,
        files: plan.files
      });
    } catch (error) {
      await unlink(outPath).catch(() => {});
      throw error;
    }

    const recorded = await pool.query(
      `UPDATE sessions
       SET ${column} = $2, zip_generated_at = $3::timestamptz
       WHERE id = $1
         AND (files_mutated_at IS NULL OR files_mutated_at < $3::timestamptz)`,
      [sessionId, outPath, buildStart]
    );

    if (recorded.rowCount === 1) {
      logger.info(
        {
          session_id: sessionId,
          type,
          path: outPath,
          entries: result.entries,
          bytes: result.bytes
        },
        "pre-generate-zip complete"
      );
      return;
    }

    // An edit landed while we were building — the archive is stale. Discard and
    // rebuild against the new state.
    await unlink(outPath).catch(() => {});
    logger.info(
      { session_id: sessionId, type, attempt },
      "pre-generate-zip rebuilding (files mutated during build)"
    );
  }

  // Edits kept landing during every build pass. Leave the cache unset so the
  // download endpoint serves a correct on-demand build rather than a stale one.
  await unlink(outPath).catch(() => {});
  await pool.query(`UPDATE sessions SET ${column} = NULL WHERE id = $1`, [
    sessionId
  ]);
  logger.warn(
    { session_id: sessionId, type },
    "pre-generate-zip gave up after repeated concurrent mutations — download will build on demand"
  );
}

// Daily maintenance: delete pre-generated ZIPs older than ZIP_MAX_AGE_MS and
// clear any DB paths whose file is gone, so /exports never fills the disk.
export async function processCleanupZipsJob(logger: FastifyBaseLogger) {
  let removed = 0;
  const now = Date.now();
  const entries = await readdir(config.exportDir).catch(() => [] as string[]);

  for (const name of entries) {
    if (!PRE_GEN_ZIP_NAME.test(name)) {
      continue; // leave other exports (CSV/XLSX/PDF) alone
    }

    const full = path.join(config.exportDir, name);

    try {
      const info = await stat(full);

      if (now - info.mtimeMs > ZIP_MAX_AGE_MS) {
        await unlink(full).catch(() => {});
        removed += 1;
      }
    } catch {
      // ignore
    }
  }

  // Clear DB paths that no longer point at an existing file.
  const rows = await pool.query<{
    id: string;
    zip_all_path: string | null;
    zip_edited_path: string | null;
  }>(
    "SELECT id, zip_all_path, zip_edited_path FROM sessions WHERE zip_all_path IS NOT NULL OR zip_edited_path IS NOT NULL"
  );

  for (const row of rows.rows) {
    const allGone = row.zip_all_path && !existsSync(row.zip_all_path);
    const editedGone = row.zip_edited_path && !existsSync(row.zip_edited_path);

    if (allGone || editedGone) {
      await pool.query(
        `UPDATE sessions
         SET zip_all_path = CASE WHEN $2 THEN NULL ELSE zip_all_path END,
             zip_edited_path = CASE WHEN $3 THEN NULL ELSE zip_edited_path END
         WHERE id = $1`,
        [row.id, Boolean(allGone), Boolean(editedGone)]
      );
    }
  }

  // Reclaim orphaned Sitemap Cleaner working directories.
  //
  // A run dir is removed by a setTimeout scheduled in storeRun, RUN_TTL_MS after
  // the run is cached. That timer lives in the API process, and nothing else knows
  // the directory exists — so an API restart or crash in that window orphans the
  // whole tree PERMANENTLY. On a large corpus that is several GB per orphan, and
  // it is self-amplifying: the leak makes the next run likelier to fail, which
  // leaks again.
  //
  // Deliberately inside its own try/catch: reclaiming disk must never be able to
  // fail the ZIP cleanup this job exists for.
  try {
    const sweep = await sweepStaleArtifacts(config.uploadDir, logger);

    if (sweep.cleanerRunsRemoved > 0 || sweep.partFilesRemoved > 0) {
      logger.warn(sweep, "stale artifact sweep reclaimed orphaned cleaner artifacts");
    }
  } catch (error) {
    logger.error({ error }, "stale artifact sweep failed");
  }

  logger.info({ removed }, "cleanup-zips complete");
}
