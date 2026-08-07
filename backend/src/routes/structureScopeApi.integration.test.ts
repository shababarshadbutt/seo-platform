import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// The two API fields the Update Pattern modal's per-position scoping depends
// on, checked through the real routes.
//
// Both are the kind of thing a typecheck cannot catch and a UI bug reports
// late: the modal filters `urls` client-side to show a sample and a count, and
// downloads by `file_id`. If either comes back absent or wrong the modal
// degrades quietly — an empty preview, or a download of the wrong files.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "structure-api-itest-"));

process.env.UPLOAD_DIR = uploadDir;

const BASE = "https://example.com";
const TEMPLATE = "/rfq/{param}/{param}/{param}";

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

test("structures returns the URL pool, and source-files returns file ids", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  const Fastify = (await import("fastify")).default;
  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { sessionRoutes } = await import("./sessions.js");

  // routes/sessions.ts pulls in FIVE BullMQ queues transitively, every one of
  // which opens a Redis connection at module load. Without closing all of them
  // the test process never exits — the same trap documented in
  // jobs/sampleUrlCheck.ts. Imported here so the after hook can close them.
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeBulkReplaceQueue } = await import(
    "../queue/bulkReplaceQueue.js"
  );
  const { closePublishQueue } = await import("../queue/publishQueue.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeMaintenanceQueue } = await import(
    "../queue/maintenanceQueue.js"
  );

  const app = Fastify({ logger: false });

  await app.register(sessionRoutes);
  await runMigrations(silentLogger);

  let sessionId: string | null = null;

  t.after(async () => {
    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await app.close().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closeBulkReplaceQueue().catch(() => {});
    await closePublishQueue().catch(() => {});
    await closePreGenerateZipQueue().catch(() => {});
    await closeMaintenanceQueue().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('structure scope api', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, $2, 120) RETURNING id",
    [sessionId, TEMPLATE]
  );
  const patternId = patternRow.rows[0].id;

  // A pool with two independent families per scoped position, so the clusters
  // the modal offers are real and the intersection is a strict subset.
  const A = ["niin-parts", "part-types"];
  const C = ["parts-catalog", "price-list"];

  for (let i = 0; i < 120; i += 1) {
    const a = `${A[i % A.length]}-${i}`;
    const c = `brand${i}-${C[Math.floor(i / A.length) % C.length]}`;
    const url = `${BASE}/rfq/${a}/mid-${i}/${c}`;

    await pool.query(
      "INSERT INTO pattern_urls (session_id, pattern_id, source_url, path) VALUES ($1, $2, $3, $4)",
      [sessionId, patternId, url, new URL(url).pathname]
    );
  }

  // ---- structures: clusters AND the pool they came from --------------------
  const structures = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/structures`
  });
  const body = structures.json();

  assert.equal(structures.statusCode, 200);
  assert.equal(body.url_pool_size, 120);
  assert.equal(body.urls.length, 120);
  assert.ok(body.urls[0].startsWith(`${BASE}/rfq/`));

  // Every structure the dropdowns will offer must be present in the pool the
  // modal filters — that equivalence is the whole reason the pool is returned
  // from THIS endpoint rather than reusing sampled_urls.
  const anchored = body.positions.flatMap(
    (position: { paramIndex: number; clusters: Array<{ anchor: unknown }> }) =>
      position.clusters
        .filter((cluster) => cluster.anchor !== null)
        .map((cluster) => ({ paramIndex: position.paramIndex, cluster }))
  );

  assert.ok(anchored.length >= 2, "expected anchored clusters at 2+ positions");

  const { resolveStructureFilters, urlMatchesStructureFilters } = await import(
    "../sitemaps/structureClusters.js"
  );

  for (const entry of anchored) {
    const anchor = entry.cluster.anchor as {
      direction: "prefix" | "suffix";
      value: string;
    };
    const resolved = resolveStructureFilters(
      [
        {
          param_index: entry.paramIndex,
          anchor: anchor.direction,
          value: anchor.value
        }
      ],
      TEMPLATE
    );

    assert.ok(resolved);
    assert.ok(
      body.urls.some((url: string) =>
        urlMatchesStructureFilters(url, resolved)
      ),
      `no pooled URL matches offered structure ${anchor.value} at param ${entry.paramIndex}`
    );
  }

  // ---- source-files: display name -> file id -------------------------------
  const stored = `${sessionId}-current-part-0.xml`;

  writeFileSync(
    path.join(uploadDir, stored),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset></urlset>\n',
    "utf8"
  );

  const fileRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, 120, now(), true, false)
      RETURNING id
    `,
    [sessionId, stored]
  );

  const { displaySourceFilename } = await import("../sitemaps/filenames.js");
  const display = displaySourceFilename(sessionId, stored);

  await pool.query(
    "INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count) VALUES ($1, $2, 120)",
    [patternId, display]
  );

  const sourceFiles = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files`
  });
  const files = sourceFiles.json().source_files;

  assert.equal(sourceFiles.statusCode, 200);
  assert.equal(files.length, 1);
  assert.equal(files[0].source_file, display);
  // The id the download's ?exclude= addresses. Resolved server-side precisely
  // so the client never derives one from a display name.
  assert.equal(files[0].file_id, fileRow.rows[0].id);
});
