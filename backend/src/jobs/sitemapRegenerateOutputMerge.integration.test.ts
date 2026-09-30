import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import pg from "pg";

// THE PRODUCTION DE-INDEXING BUG. sitemapRegenerateJob soft-deletes a
// session's existing 'current' sitemap_files rows before writing the CSV's
// new chunk files, so a re-run supersedes its OWN previous output instead of
// piling up duplicates. Before migration 062, a freshly-pulled 'current' row
// (a file the site genuinely serves, e.g. one of hundreds of
// per-manufacturer sitemaps) was INDISTINGUISHABLE from this wizard's own
// prior chunk output — both were just source_role='current', is_index=false
// — so that soft-delete wiped BOTH kinds. The republished index (built from
// exactly what is_deleted = false) then contained ONLY the CSV's chunk
// files, de-indexing every other live sitemap sub-file the site served, even
// though the CSV only ever covered one segment of the site.
//
// This proves the fix on both fronts:
//   1. A genuine 'current' file (is_regenerate_output = false) survives a
//      regenerate run untouched, and buildPublishPlan's index still contains
//      it alongside the new chunk file.
//   2. A SECOND regenerate run on the same session supersedes the FIRST
//      run's own chunk output (no duplicate accumulation) without ever
//      touching the genuine file.
//
// Skips (does not fail) when postgres/redis are not reachable, like the
// other integration tests here. Redis is needed only because
// sessionCompletion.ts (imported transitively) constructs the
// pre-generate-ZIP queue at module load.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "regen-merge-itest-"));

process.env.UPLOAD_DIR = uploadDir;

async function postgresReachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000
  });

  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

function redisReachable(): Promise<boolean> {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");

  return new Promise((resolve) => {
    const socket = net.connect({
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 6379,
      timeout: 3000
    });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const silentLogger: any = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  }
};

test("regenerating from a CSV keeps the site's other 'current' sitemap files indexed, and a re-run supersedes only its own prior output", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processSitemapRegenerateJob } = await import(
    "./sitemapRegenerateJob.js"
  );
  const { buildPublishPlan } = await import("../publish/s3Publish.js");
  const { resolvePublishTarget } = await import("../publish/publishTarget.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeRedisLockClient } = await import("../queue/redisLock.js");

  let sessionId: string | null = null;

  t.after(async () => {
    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await closePreGenerateZipQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);

  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('regenerate merge test', 'https://example.test', 5, 4, 'COMPLETED')
      RETURNING id
    `
  );

  sessionId = sessionResult.rows[0].id;

  // A file the site genuinely serves — pulled for real during Step 1, never
  // touched by this wizard. This is the row the bug used to wipe.
  const genuineFilename = "aviation-mfg-rfq1.xml";

  writeFileSync(
    path.join(uploadDir, genuineFilename),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.test/aviation-mfg-rfq1</loc></url>
</urlset>
`
  );

  await pool.query(
    `
      INSERT INTO sitemap_files (
        session_id, filename, original_filename, total_urls, parsed_at,
        is_valid, is_empty, is_index, source_role, is_deleted, is_regenerate_output
      )
      VALUES ($1, $2, $2, 1, now(), TRUE, FALSE, FALSE, 'current', FALSE, FALSE)
    `,
    [sessionId, genuineFilename]
  );

  // The CSV-derived 'legacy' file the wizard's own chunker reads from disk.
  const csvStoredFilename = `${randomUUID()}.xml`;

  writeFileSync(
    path.join(uploadDir, csvStoredFilename),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.test/niin-parts/1</loc></url>
  <url><loc>https://example.test/niin-parts/2</loc></url>
</urlset>
`
  );

  const csvFileResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sitemap_files (
        session_id, filename, total_urls, parsed_at, is_valid, is_empty,
        is_index, source_role
      )
      VALUES ($1, $2, 2, now(), TRUE, FALSE, FALSE, 'legacy')
      RETURNING id
    `,
    [sessionId, csvStoredFilename]
  );
  const csvSitemapFileId = csvFileResult.rows[0].id;

  async function enqueueRegenerateJob() {
    const jobRow = await pool.query<{ id: string }>(
      `
        INSERT INTO sitemap_regenerate_jobs (session_id, request_fingerprint, params)
        VALUES ($1, $2, $3::jsonb)
        RETURNING id
      `,
      [
        sessionId,
        randomUUID(),
        JSON.stringify({
          csv_sitemap_file_id: csvSitemapFileId,
          pattern_decisions: [],
          filename_template: "sitemap-{n}.xml",
          lastmod_policy: "all"
        })
      ]
    );

    return jobRow.rows[0].id;
  }

  // --- Run 1 -----------------------------------------------------------
  const firstJobId = await enqueueRegenerateJob();

  await processSitemapRegenerateJob(
    { session_id: sessionId, job_row_id: firstJobId },
    silentLogger
  );

  const afterFirstRun = await pool.query<{
    original_filename: string;
    is_deleted: boolean;
    is_regenerate_output: boolean;
  }>(
    `
      SELECT original_filename, is_deleted, is_regenerate_output
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current'
      ORDER BY original_filename ASC
    `,
    [sessionId]
  );

  const genuineAfterFirst = afterFirstRun.rows.find(
    (row) => row.original_filename === genuineFilename
  );

  assert.ok(genuineAfterFirst, "the genuine file's row must still exist");
  assert.equal(
    genuineAfterFirst!.is_deleted,
    false,
    "the genuine, actually-pulled 'current' file must NOT be soft-deleted by a regenerate run"
  );

  const firstChunkRows = afterFirstRun.rows.filter(
    (row) => row.is_regenerate_output
  );

  assert.equal(firstChunkRows.length, 1, "exactly one chunk file from run 1");
  assert.equal(firstChunkRows[0].is_deleted, false);

  const target = await resolvePublishTarget(sessionId);
  const planAfterFirst = await buildPublishPlan(sessionId, target);
  const namesAfterFirst = planAfterFirst.files.map((file) => file.displayName);

  // THE ACTUAL BUG: this used to fail — the genuine file was dropped from the
  // regenerated publish index entirely.
  assert.ok(
    namesAfterFirst.includes(genuineFilename),
    "the publish plan (== the regenerated index) must still include the site's other genuine sitemap file"
  );
  assert.equal(
    namesAfterFirst.filter((name) => name.startsWith("sitemap-")).length,
    1,
    "exactly one CSV-derived chunk file after run 1"
  );

  // --- Run 2: re-run on the same session, own output must be superseded ---
  const secondJobId = await enqueueRegenerateJob();

  await processSitemapRegenerateJob(
    { session_id: sessionId, job_row_id: secondJobId },
    silentLogger
  );

  const afterSecondRun = await pool.query<{
    original_filename: string;
    is_deleted: boolean;
    is_regenerate_output: boolean;
  }>(
    `
      SELECT original_filename, is_deleted, is_regenerate_output
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current'
      ORDER BY original_filename ASC
    `,
    [sessionId]
  );

  const genuineAfterSecond = afterSecondRun.rows.find(
    (row) => row.original_filename === genuineFilename
  );

  assert.equal(
    genuineAfterSecond!.is_deleted,
    false,
    "the genuine file must survive a SECOND regenerate run too"
  );

  const liveChunkRowsAfterSecond = afterSecondRun.rows.filter(
    (row) => row.is_regenerate_output && !row.is_deleted
  );
  const supersededChunkRowsAfterSecond = afterSecondRun.rows.filter(
    (row) => row.is_regenerate_output && row.is_deleted
  );

  assert.equal(
    liveChunkRowsAfterSecond.length,
    1,
    "run 2's own new chunk file is live"
  );
  assert.equal(
    supersededChunkRowsAfterSecond.length,
    1,
    "run 1's chunk file must be superseded (soft-deleted) by run 2 — no duplicate accumulation"
  );

  const planAfterSecond = await buildPublishPlan(sessionId, target);
  const namesAfterSecond = planAfterSecond.files.map((file) => file.displayName);

  assert.ok(
    namesAfterSecond.includes(genuineFilename),
    "the genuine file is still in the regenerated index after a second run"
  );
  assert.equal(
    namesAfterSecond.filter((name) => name.startsWith("sitemap-")).length,
    1,
    "still exactly one CSV-derived chunk file in the index — run 1's is gone, not duplicated"
  );
});
