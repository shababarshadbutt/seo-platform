import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// A PATTERN RE-CHECK re-measures one pattern and rewrites its row.
//
// What this proves, against a real database and a real socket:
//   1. A frozen row CAN be re-measured. patterns.status / confidence_pct /
//      redirect_pct are written by exactly one thing — the sampling job — which
//      previously ran only at the end of extraction or from a resume while
//      sampling was unfinished. On a completed session those cells were permanent,
//      so every later checker fix was invisible on existing sessions and the
//      Check button on an unscored row could not change anything (triage and
//      verification write their own tables).
//   2. The stale rows are REPLACED, not appended to.
//   3. A scoped run is INERT for the session: a completed session must not flip to
//      SAMPLING, must not be re-finalised, and must not be marked FAILED because
//      one re-measured row hit a network error. Otherwise re-checking one row
//      would sprout a Resume banner on a finished session.
//   4. The re-check goes through the SAME checker AND the per-host strategy engine,
//      so it leads with the profile this host is known to answer — which is the
//      entire point on a WAF-fronted site.
//
// Skips (does not fail) when postgres/redis are not reachable, like the other
// integration tests here. Redis is needed only because samplePatternsJob
// transitively constructs the pre-generate-ZIP queue at module load.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "pattern-recheck-itest-"));

process.env.UPLOAD_DIR = uploadDir;

// Long enough to clear the soft-404 short-body heuristic (1000 bytes), so a 200
// classifies as success rather than soft_404.
const LONG_BODY = "healthy fixture product page content. ".repeat(60);

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

test("re-checking one pattern rescores it and leaves the session alone", async (t) => {
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

  // The measured production signature: the honest crawler UA is refused (405 on
  // HEAD *and* GET, so the method-rejection re-probe fires and still fails, which
  // is what makes it "blocked"), while the browser profile is served normally.
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const browserProfile = req.headers["sec-fetch-mode"] === "navigate";

    requests.push(`${req.method} ${req.url} ${browserProfile ? "browser" : "crawler"}`);

    if (!browserProfile) {
      res.writeHead(405);
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "text/html" });
    res.end(LONG_BODY);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processSamplePatternsJob } = await import("./samplePatternsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  // BOTH queues, or the process never exits. samplePatternsJob pulls in
  // sessionCompletion, which imports sitemapQueue as well as preGenerateZipQueue,
  // and each constructs a BullMQ Queue (an open Redis connection) at module load.
  // Closing only one leaves the test worker alive with no output flushed — it looks
  // exactly like a hung test.
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeRedisLockClient } = await import("../queue/redisLock.js");

  let sessionId: string | null = null;

  t.after(async () => {
    server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await closePreGenerateZipQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    // The per-host strategy engine opens its own Redis connection (queue/redisLock.ts,
    // shared with the publish lock). Every code path here reaches it now, and a leaked
    // ioredis handle keeps the test worker alive after the last assertion — which looks
    // exactly like a hung test, because a worker that never exits never flushes output.
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);
  resetHostRateLimiter();

  // A FINISHED session, exactly like the ones whose pattern table is frozen.
  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('pattern recheck', $1, 5, 4, 'COMPLETED')
      RETURNING id
    `,
    [baseUrl]
  );

  sessionId = sessionResult.rows[0].id;

  // The shape that exposed this: a single-URL, zero-param static pattern.
  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls, status, confidence_pct, redirect_pct)
      VALUES ($1, '/about-us', 1, 'PENDING', 0, 0)
      RETURNING id
    `,
    [sessionId]
  );
  const patternId = patternRow.rows[0].id;

  await pool.query(
    `
      INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
      VALUES ($1, $2, $3, '/about-us')
    `,
    [sessionId, patternId, `${baseUrl}/about-us`]
  );

  // The frozen verdict from the original pass: refused, so nothing measurable,
  // so PENDING — which the table renders as "Not scored".
  await pool.query(
    `
      INSERT INTO sampled_urls (
        pattern_id, url, http_status, response_ms, is_hit, is_soft_404,
        checked_at, redirect_count, http_status_category
      )
      VALUES ($1, $2, 405, 12, false, false, now() - interval '2 days', 0, 'blocked')
    `,
    [patternId, `${baseUrl}/about-us`]
  );

  await processSamplePatternsJob(
    { session_id: sessionId, pattern_id: patternId },
    silentLogger
  );

  const scored = await pool.query<{
    status: string;
    confidence_pct: string;
    redirect_pct: string;
  }>(
    "SELECT status, confidence_pct, redirect_pct FROM patterns WHERE id = $1",
    [patternId]
  );

  // (1) and (4): the row was re-measured, through the same checker, so the
  // browser-profile escalation recovered a real 200 where the crawler UA was
  // refused — and the row is no longer "Not scored".
  assert.equal(scored.rows[0].status, "GOOD");
  assert.equal(Number(scored.rows[0].confidence_pct), 100);
  assert.equal(Number(scored.rows[0].redirect_pct), 0);

  const samples = await pool.query<{
    http_status: number;
    http_status_category: string;
    used_fallback_profile: boolean | null;
  }>(
    `
      SELECT http_status, http_status_category, used_fallback_profile
      FROM sampled_urls
      WHERE pattern_id = $1
    `,
    [patternId]
  );

  // (2): replaced, not appended — one row, the new one.
  assert.equal(samples.rowCount, 1);
  assert.equal(samples.rows[0].http_status, 200);
  assert.equal(samples.rows[0].http_status_category, "success");

  // used_fallback_profile is now FALSE, and that is the strategy engine working.
  //
  // The engine negotiates this host first, learns that the browser profile is what it
  // answers, and hands that rung to the checker as the PRIMARY attempt — so the URL
  // succeeds on attempt #1 and no fallback is needed. The column keeps its strict
  // meaning ("the second attempt produced this verdict"); WHICH profile was used is
  // recorded per host in host_probe_profiles, asserted below. Before the engine this
  // row read true because every URL climbed from the honest UA on its own.
  assert.equal(samples.rows[0].used_fallback_profile, false);

  const learned = await pool.query<{ verdict: string; winning_rung: string }>(
    "SELECT verdict, winning_rung FROM host_probe_profiles WHERE host = $1",
    [new URL(baseUrl).host]
  );

  assert.equal(learned.rows[0].verdict, "OK");
  assert.equal(learned.rows[0].winning_rung, "R1");

  // At the socket: negotiation costs the crawler rung (HEAD + the method-rejection
  // GET) then the browser rung (HEAD + soft-404 GET), and the per-URL check that
  // follows is browser-only — two requests instead of the four it used to take.
  assert.deepEqual(requests, [
    "HEAD /about-us crawler",
    "GET /about-us crawler",
    "HEAD /about-us browser",
    "GET /about-us browser",
    "HEAD /about-us browser",
    "GET /about-us browser"
  ]);

  // (3): the session is untouched. A scoped re-check must not reopen it, must not
  // re-finalise it, and must not mark it FAILED.
  const session = await pool.query<{ status: string }>(
    "SELECT status FROM sessions WHERE id = $1",
    [sessionId]
  );

  assert.equal(session.rows[0].status, "COMPLETED");
});
