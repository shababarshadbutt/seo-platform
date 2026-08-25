import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// A FIX THAT REACHES PART OF A PATTERN MUST SAY SO (v1.81).
//
// THE REPORTED BEHAVIOUR. Several patterns showed a "Fixed" chip; the sitemap
// downloaded afterwards still contained the old URLs. Nothing had gone wrong in
// the rewrite: apply-redirects changes a <loc> only when a confirmed destination
// or an AGREED per-shape rule covers it, and on a pattern mixing several URL
// families that is a small minority of the population. Every non-zero rewrite
// count was reported as plain "applied", so twelve of 579,034 read exactly like
// a complete fix.
//
// This asserts the whole chain end to end against a real database, because every
// link in it is somewhere a unit test cannot reach: the route's SQL, the on-disk
// rewrite, the outcome classification, and the coverage columns migration 052
// added. Specifically:
//
//   * the file really is rewritten for the ONE URL that has a destination;
//   * the OTHER pattern URLs really are still in the file afterwards — the whole
//     point, and the thing the operator saw;
//   * the response says "partially-applied" and counts what it left;
//   * the skipped URLs come back grouped by shape with a REAL example, so the
//     modal can name them;
//   * patterns.redirects_skipped_locs is written, which is what turns the chip
//     amber on the next page load rather than only in this one toast.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "partial-itest-"));
const exportDir = mkdtempSync(path.join(os.tmpdir(), "partial-itest-exp-"));

process.env.UPLOAD_DIR = uploadDir;
process.env.EXPORT_DIR = exportDir;

const BASE = "https://example.com";

// One URL with a confirmed destination, and four without. Deliberately spread
// over two digit-run lengths so the skipped report has to group them the way
// valueShape does — which is the mechanism behind the second reported symptom, a
// fixed URL sitting next to an untouched sibling that looks identical to it.
const FIXABLE = BASE + "/nsn/nsn-parts-9558/";
const SKIPPED = [
  BASE + "/nsn/nsn-parts-3345/",
  BASE + "/nsn/nsn-parts-9541/",
  BASE + "/nsn/nsn-parts-12191/",
  BASE + "/nsn/nsn-parts-88123/"
];
const DESTINATION = BASE + "/nsn/nsn-parts/page-2-9558/";

async function postgresReachable(): Promise<boolean> {
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

test("an apply that reaches part of a pattern reports the remainder", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip("postgres not reachable — skipping");
    return;
  }

  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip("redis not reachable — skipping");
    return;
  }

  const Fastify = (await import("fastify")).default;
  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { sessionRoutes } = await import("./sessions.js");
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
    rmSync(exportDir, { recursive: true, force: true });
  });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('partial coverage', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const display = "nsn-pagination-1.xml";
  const stored = sessionId + "-" + display;
  const allUrls = [FIXABLE, ...SKIPPED];

  writeFileSync(
    path.join(uploadDir, stored),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
      allUrls.map((url) => "  <url><loc>" + url + "</loc></url>").join("\n") +
      "\n</urlset>\n",
    "utf8"
  );

  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, allUrls.length]
  );

  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls, status)
      VALUES ($1, '/nsn/{param}', $2, 'BAD')
      RETURNING id
    `,
    [sessionId, allUrls.length]
  );
  const patternId = patternRow.rows[0].id;

  await pool.query(
    `
      INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count)
      VALUES ($1, $2, $3)
    `,
    [patternId, display, allUrls.length]
  );

  // EXACTLY ONE confirmed destination. The other four redirect to nowhere anyone
  // measured, which is the ordinary state of a wide pattern rather than a
  // contrived one.
  await pool.query(
    `
      INSERT INTO sampled_urls
        (pattern_id, url, http_status, response_ms, is_hit, checked_at,
         final_url, redirect_count, http_status_category, source_file)
      VALUES ($1, $2, 308, 140, true, now(), $3, 1, 'redirect', $4)
    `,
    [patternId, FIXABLE, DESTINATION, display]
  );

  const response = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/" +
      patternId +
      "/apply-redirects",
    payload: {}
  });

  assert.equal(response.statusCode, 200);

  const body = response.json();

  // 1. The work that landed.
  assert.equal(body.rewritten_loc_count, 1);

  // 2. THE SYMPTOM, asserted directly: the other four URLs are still in the file
  // exactly as they were. This is what the operator downloaded and reported.
  const rewritten = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const contents = readFileSync(
    path.join(uploadDir, rewritten.rows[0].filename),
    "utf8"
  );

  assert.ok(contents.includes(DESTINATION), "the fixable URL was rewritten");

  for (const url of SKIPPED) {
    assert.ok(contents.includes(url), url + " was left in the file");
  }

  // 3. And now the report says so, instead of calling it done.
  assert.equal(body.outcome, "partially-applied");
  assert.equal(body.skipped_in_scope, SKIPPED.length);
  assert.match(body.outcome_message, /1 of 5 URLs/);

  // 4. Grouped by shape, with real URLs — 3345/9541 share a four-digit run,
  // 12191/88123 share a five-digit one. A reviewer reads the examples, never the
  // shape keys.
  const shapes: Array<{ shape: string; count: number; example: string }> =
    body.skipped_shapes;

  assert.equal(shapes.length, 2);
  assert.equal(shapes[0].count, 2, "biggest group first");
  assert.ok(
    SKIPPED.includes(shapes[0].example),
    "the example is one of the URLs actually skipped"
  );
  assert.equal(body.skipped_shapes_truncated, false);

  // 5. Persisted, so the table's chip reads "Partly fixed" on the next load and
  // not only in the toast this request produced.
  const coverage = await pool.query<{
    redirects_applied_at: string | null;
    redirects_applied_locs: string | null;
    redirects_skipped_locs: string | null;
  }>(
    `
      SELECT redirects_applied_at, redirects_applied_locs, redirects_skipped_locs
      FROM patterns WHERE id = $1
    `,
    [patternId]
  );

  assert.ok(coverage.rows[0].redirects_applied_at, "the fix is stamped");
  assert.equal(Number(coverage.rows[0].redirects_applied_locs), 1);
  assert.equal(
    Number(coverage.rows[0].redirects_skipped_locs),
    SKIPPED.length,
    "the shortfall is stored beside the timestamp, not only returned"
  );
});
