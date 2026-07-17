import { createWriteStream, existsSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { buildSessionZipArchive } from "../routes/sessions.js";
import {
  ZIP_MAX_AGE_MS,
  type PreGenerateZipJobData
} from "../queue/preGenerateZipQueue.js";

// A cached ZIP younger than this is reused instead of being regenerated.
const FRESH_MS = 24 * 60 * 60 * 1000;

// Names of the pre-generated ZIPs: "<sessionId>-<type>-<YYYY-MM-DD>.zip".
const PRE_GEN_ZIP_NAME =
  /^[0-9a-f-]{36}-(all|edited)-\d{4}-\d{2}-\d{2}\.zip$/i;

export async function processPreGenerateZipJob(
  data: PreGenerateZipJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, type } = data;
  const column = type === "all" ? "zip_all_path" : "zip_edited_path";

  // Skip if a fresh cached ZIP already exists on disk.
  const existing = await pool.query<{
    path: string | null;
    zip_generated_at: string | null;
  }>(
    `SELECT ${column} AS path, zip_generated_at FROM sessions WHERE id = $1`,
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
    Date.now() - new Date(current.zip_generated_at).getTime() < FRESH_MS
  ) {
    logger.info(
      { session_id: sessionId, type },
      "pre-generate-zip skipped (fresh cache)"
    );
    return;
  }

  const built = await buildSessionZipArchive(sessionId, type);

  if (!built) {
    // No files of this type (e.g. no edited files) — clear any stale path.
    await pool.query(`UPDATE sessions SET ${column} = NULL WHERE id = $1`, [
      sessionId
    ]);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(config.exportDir, `${sessionId}-${type}-${today}.zip`);
  const out = createWriteStream(outPath);

  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
    built.archive.on("error", reject);
  });

  built.archive.pipe(out);
  await built.archive.finalize();

  try {
    await done;
  } catch (error) {
    await unlink(outPath).catch(() => {});
    throw error;
  }

  await pool.query(
    `UPDATE sessions SET ${column} = $2, zip_generated_at = now() WHERE id = $1`,
    [sessionId, outPath]
  );

  logger.info(
    { session_id: sessionId, type, path: outPath },
    "pre-generate-zip complete"
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

  logger.info({ removed }, "cleanup-zips complete");
}
