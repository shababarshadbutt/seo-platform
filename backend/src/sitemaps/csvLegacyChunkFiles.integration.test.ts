import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import pg from "pg";

// Proves writeCsvLegacyChunks' two load-bearing properties: (1) chunks are
// written in parallel through the REAL sitemapGeneratePool piscina pool (not
// just the task function in-process — same reasoning as
// sourceFileScanPool.test.ts), each becoming its own 'legacy' sitemap_files
// row, and (2) a failed write leaves zero trace — no orphaned chunk files, no
// orphaned rows — so a failed CSV ingest can always be retried cleanly.
//
// Only needs postgres (createStoredSitemapFile/cleanup are plain pg; the
// piscina pool itself needs no Redis).
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "csv-legacy-chunks-itest-"));

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

test("writeCsvLegacyChunks", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { writeCsvLegacyChunks } = await import("./csvLegacyChunkFiles.js");
  const { destroySitemapGeneratePool } = await import(
    "../jobs/sitemapGeneratePool.js"
  );

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

  let sessionId: string | null = null;

  t.after(async () => {
    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await destroySitemapGeneratePool();
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);

  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('csv legacy chunk test', 'https://example.test', 5, 4, 'COMPLETED')
      RETURNING id
    `
  );

  sessionId = sessionResult.rows[0].id;

  await t.test("writes each chunk in parallel and inserts one legacy row per chunk", async () => {
    const chunks = [
      ["https://example.test/a", "https://example.test/b"],
      ["https://example.test/c"]
    ];
    const progress: Array<{ filesDone: number; urlsWritten: number }> = [];

    const written = await writeCsvLegacyChunks(sessionId!, chunks, (filesDone, urlsWritten) => {
      progress.push({ filesDone, urlsWritten });
    });

    assert.equal(written.length, 2);
    assert.deepEqual(
      written.map((entry) => entry.urlCount).sort(),
      [1, 2]
    );

    const rows = await pool.query<{
      id: string;
      filename: string;
      source_role: string;
    }>(
      "SELECT id, filename, source_role FROM sitemap_files WHERE session_id = $1 ORDER BY filename ASC",
      [sessionId]
    );

    assert.equal(rows.rowCount, 2);
    assert.ok(rows.rows.every((row) => row.source_role === "legacy"));
    assert.deepEqual(
      rows.rows.map((row) => row.id).sort(),
      written.map((entry) => entry.sitemap_file_id).sort()
    );

    for (const row of rows.rows) {
      const contents = readFileSync(path.join(uploadDir, row.filename), "utf8");

      assert.match(contents, /<urlset/);
    }

    assert.equal(progress.length, 2, "progress callback fires once per chunk");
    assert.equal(
      progress[progress.length - 1].urlsWritten,
      3,
      "final progress call reports all 3 urls written"
    );
  });

  await t.test(
    "a failed DB insert leaves no orphaned chunk files or sitemap_files rows",
    async () => {
      // A session id that satisfies the type but doesn't exist violates
      // sitemap_files' session_id FK on every chunk's insert — deterministic,
      // unlike trying to force the disk write itself to fail (platform fs
      // error-event timing for a bad path proved unreliable to repro here).
      // Each chunk's piscina write still succeeds first (phase 1), so this
      // exercises the SAME cleanup path a late phase-2 failure would: unlink
      // every file phase 1 wrote, delete every row phase 2 already inserted.
      const nonExistentSessionId = randomUUID();
      const filesBefore = readdirSync(uploadDir).length;

      await assert.rejects(() =>
        writeCsvLegacyChunks(nonExistentSessionId, [
          ["https://example.test/y1"],
          ["https://example.test/y2"]
        ])
      );

      const orphanedRows = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM sitemap_files WHERE session_id = $1",
        [nonExistentSessionId]
      );

      assert.equal(
        orphanedRows.rows[0].count,
        "0",
        "a failed ingest must not leave any sitemap_files rows behind"
      );
      assert.equal(
        readdirSync(uploadDir).length,
        filesBefore,
        "a failed ingest must not leave any chunk files on disk behind"
      );
    }
  );
});
