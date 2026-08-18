import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// Incremental re-verification, against a real database and a counting HTTP
// fixture.
//
// WHAT IT PROVES, and why it needs an integration test rather than a unit one:
// the reuse rule is a JOIN between verified_urls.checked_at and
// sessions.files_mutated_at, so the only way to show it works is to run the job
// twice against real rows and count the requests the origin actually received.
//
// THE PROBLEM. Verification is capped at 5 requests/second per host (a
// deliberate ceiling, set after a confirmed AWS WAF captcha incident), so the
// HTTP phase is the entire cost of a run. A re-verify used to repeat all of it
// even for URLs measured seconds earlier — and fix-then-recheck is the normal
// workflow, so the run someone is waiting on paid full price to re-confirm what
// it already knew.
//
// THE SAFETY PROPERTY, which matters more than the speed one: an edit must
// invalidate the cache. Anything that mutates a session's files stamps
// sessions.files_mutated_at (see sessionZipCache), and a stored verdict is only
// reusable if it was measured after that. The third act below is the one that
// matters — it asserts the cache is dropped, not kept.
//
// Env pinned BEFORE any src import: config.ts reads these once at module load.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
// Pacing is covered by hostRateLimiter.test.ts and verifyRateLimit.integration
// .test.ts. This file measures REQUEST COUNTS, so the shipped 5/s would only
// make it slow.
process.env.VERIFY_MAX_REQUESTS_PER_SECOND = "5000";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "verify-reuse-itest-"));

process.env.UPLOAD_DIR = uploadDir;

const URL_COUNT = 12;

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

test("a re-verify reuses recent verdicts, and an edit invalidates them", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processVerifyUrlsJob } = await import("./verifyUrlsJob.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeRedisLockClient } = await import("../queue/redisLock.js");

  await runMigrations(silentLogger);

  // ---- fixture origin, counting every request it receives -------------------
  let requestCount = 0;
  const server: Server = createServer((req, res) => {
    requestCount += 1;

    if (req.url?.startsWith("/gone/")) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.method === "HEAD" ? undefined : "a healthy product page");
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  let sessionId = "";

  // Run the job once and report what the origin saw plus what the row recorded.
  async function runVerification() {
    requestCount = 0;

    const jobRow = await pool.query<{ id: string }>(
      "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'verify-urls') RETURNING id",
      [sessionId]
    );
    const jobRowId = jobRow.rows[0].id;

    await processVerifyUrlsJob(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        pattern_ids: null,
        target_statuses: null
      },
      silentLogger
    );

    const row = await pool.query<{
      status: string;
      files_total: number;
      files_done: number;
      urls_reused: number | null;
    }>(
      "SELECT status, files_total, files_done, urls_reused FROM maintenance_jobs WHERE id = $1",
      [jobRowId]
    );

    return { requests: requestCount, job: row.rows[0] };
  }

  try {
    const sessionRow = await pool.query<{ id: string }>(
      `INSERT INTO sessions (name, base_url, sample_size, concurrency)
       VALUES ('verify reuse itest', $1, 5, 10) RETURNING id`,
      [baseUrl]
    );
    sessionId = sessionRow.rows[0].id;

    await pool.query(
      `INSERT INTO patterns (session_id, template, total_urls)
       VALUES ($1, '/product/{param}', $2)`,
      [sessionId, URL_COUNT]
    );

    const locs = Array.from(
      { length: URL_COUNT },
      (_, index) => `${baseUrl}/product/item-${index}`
    );
    const stored = `${sessionId}-current.xml`;

    writeFileSync(
      path.join(uploadDir, stored),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        locs.map((loc) => `  <url><loc>${loc}</loc></url>\n`).join("") +
        "</urlset>\n"
    );

    await pool.query(
      `INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
       VALUES ($1, $2, $3, now(), true, false)`,
      [sessionId, stored, URL_COUNT]
    );

    // ---- act 1: the first run measures everything ---------------------------
    const first = await runVerification();

    assert.equal(first.job.status, "COMPLETE");
    assert.equal(first.job.files_total, URL_COUNT);
    assert.ok(
      first.requests >= URL_COUNT,
      `first run must probe every URL, saw ${first.requests} requests`
    );
    // Nothing to reuse on a first run — 0, not null: reuse was available and
    // nothing qualified.
    assert.equal(first.job.urls_reused, 0);

    // ---- act 2: the second run probes NOTHING -------------------------------
    // This is the whole point. Same files, verdicts seconds old, so every URL is
    // answered from verified_urls and the origin is not contacted at all.
    const second = await runVerification();

    assert.equal(second.job.status, "COMPLETE");
    assert.equal(
      second.requests,
      0,
      `a re-verify of unchanged files must not contact the origin, saw ${second.requests}`
    );
    assert.equal(second.job.urls_reused, URL_COUNT);
    // The population is still reported in full — reuse changes what is PROBED,
    // never what is counted, or the pattern would appear to shrink.
    assert.equal(second.job.files_total, URL_COUNT);
    assert.equal(second.job.files_done, URL_COUNT);

    // THE REGRESSION THIS GUARDS, found by verifyScoping.integration.test.ts.
    // The stale-row sweep deletes rows whose checked_at is older than the run,
    // on the assumption that "every enumerated url just got checked_at reset".
    // A REUSED row is older by definition, so the first version of reuse had the
    // run delete every verdict it had just decided to trust — leaving the table
    // empty and the completion count reporting zero problems.
    const survived = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM verified_urls WHERE session_id = $1",
      [sessionId]
    );

    assert.equal(
      Number(survived.rows[0].count),
      URL_COUNT,
      "reused verdicts must survive the stale-row sweep, not be deleted by it"
    );

    // ---- act 3: an edit invalidates the cache -------------------------------
    // THE SAFETY PROPERTY. Every path that rewrites a session's files stamps
    // files_mutated_at; a verdict measured before that no longer describes what
    // is in the file, so it must not be reused however recent it is.
    await pool.query(
      "UPDATE sessions SET files_mutated_at = now() WHERE id = $1",
      [sessionId]
    );

    const third = await runVerification();

    assert.equal(third.job.status, "COMPLETE");
    assert.equal(
      third.job.urls_reused,
      0,
      "an edit must drop the cache, not keep it"
    );
    assert.ok(
      third.requests >= URL_COUNT,
      `after an edit every URL must be re-probed, saw ${third.requests} requests`
    );

    // ---- act 4: and reuse resumes once the new verdicts are stored ----------
    const fourth = await runVerification();

    assert.equal(fourth.requests, 0);
    assert.equal(fourth.job.urls_reused, URL_COUNT);
  } finally {
    server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    // WITHOUT THESE THE PROCESS NEVER EXITS, and a worker that never exits never
    // flushes its output — so a passing test is indistinguishable from a hung
    // one. Importing verifyUrlsJob pulls in the pre-gen ZIP queue, and the
    // per-host strategy engine opens its own ioredis handle via redisLock. Same
    // teardown as verifyUrls.integration.test.ts, for the same reason.
    await closePreGenerateZipQueue().catch(() => {});
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  }
});
