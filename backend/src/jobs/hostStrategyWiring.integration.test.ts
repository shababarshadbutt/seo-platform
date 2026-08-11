import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// The strategy engine WIRED IN, against a real database and a real socket.
//
// hostStrategy.test.ts proves every decision with a fake probe. What only this can
// prove is that the decisions reach the jobs — and the assertions are REQUEST COUNTS,
// because the entire value of the engine is requests NOT made. A version of this
// feature that resolved the strategy correctly and then ignored it would pass every
// outcome-based test and save nothing.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
// Fast pacing: this file measures WHICH requests go out, not how they are spaced
// (verifyRateLimit.integration.test.ts owns that), and the shipped 5/s default would
// add minutes of sleeping for nothing.
process.env.VERIFY_MAX_REQUESTS_PER_SECOND = "100";
process.env.VERIFY_RATE_LIMIT_BURST = "50";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "host-strategy-itest-"));

process.env.UPLOAD_DIR = uploadDir;

const LONG_BODY = "healthy fixture product page content. ".repeat(60);
const HONEST_UA = "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)";

function urlset(locs: string[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n") +
    "\n</urlset>\n"
  );
}

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

type Hit = { method: string; url: string; ua: string; browser: boolean };

async function startFixture(
  handler: (hit: Hit, res: import("node:http").ServerResponse) => void
) {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const ua = String(req.headers["user-agent"] ?? "");
    const hit: Hit = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      ua,
      browser: req.headers["sec-fetch-mode"] === "navigate"
    };

    hits.push(hit);
    handler(hit, res);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  return { hits, server, baseUrl: `http://127.0.0.1:${port}` };
}

// Each fixture listens on its own ephemeral port, so every test gets a DISTINCT
// host key and cannot inherit another test's learned strategy.
test("a REFUSED host costs three negotiation probes and nothing else", async (t) => {
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

  // Refuses everything, on every profile, with a load balancer's Server header —
  // the measured stackedindustrials.com signature.
  const fixture = await startFixture((_hit, res) => {
    res.writeHead(405, { server: "awselb/2.0" });
    res.end();
  });

  const { pool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processSamplePatternsJob } = await import("./samplePatternsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { resetHostStrategyMemory } = await import("../http/hostStrategy.js");

  let sessionId: string | null = null;
  const host = new URL(fixture.baseUrl).host;

  // NO client teardown here. The pg pool, the BullMQ queues and the shared Redis lock
  // connection are MODULE-level and shared with the second test in this file; closing
  // any of them here breaks that test with "Connection is closed" the moment sampling
  // finishes and tries to enqueue the cleanup job. The last test owns them.
  t.after(async () => {
    fixture.server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await pool
      .query("DELETE FROM host_probe_profiles WHERE host = $1", [host])
      .catch(() => {});
  });

  await runMigrations(silentLogger);
  resetHostRateLimiter();
  resetHostStrategyMemory();

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('host strategy refused', $1, 10, 4, 'PROCESSING')
      RETURNING id
    `,
    [fixture.baseUrl]
  );

  sessionId = sessionRow.rows[0].id;

  // Three patterns, 10 pool URLs each: 30 URLs that would each cost 4 requests
  // (HEAD+GET honest, HEAD+GET browser) under v1.60 — 120 requests to learn one fact.
  const patternIds: string[] = [];

  for (const template of [
    "/product/{param}/{param}",
    "/rfq/{param}/{param}",
    "/manufacturer/{param}/{param}"
  ]) {
    const row = await pool.query<{ id: string }>(
      "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, $2, 10) RETURNING id",
      [sessionId, template]
    );

    patternIds.push(row.rows[0].id);

    for (let index = 0; index < 10; index += 1) {
      const urlPath = `${template.replace(/\{param\}/g, "x")}-${index}`;

      await pool.query(
        "INSERT INTO pattern_urls (session_id, pattern_id, source_url, path) VALUES ($1, $2, $3, $4)",
        [sessionId, row.rows[0].id, `${fixture.baseUrl}${urlPath}`, urlPath]
      );
    }
  }

  await processSamplePatternsJob({ session_id: sessionId }, silentLogger);

  // THE COST ASSERTION. Three rungs, each a HEAD plus the method-rejection GET
  // re-probe = 6 requests, and then NOTHING: no pattern was probed at all.
  assert.equal(
    fixture.hits.length,
    6,
    `expected 6 negotiation requests, got ${fixture.hits.length}: ${fixture.hits
      .map((hit) => `${hit.method} ${hit.url} ${hit.browser ? "browser" : "crawler"}`)
      .join(" | ")}`
  );

  // All three rungs were actually tried, in order, before giving up.
  assert.equal(fixture.hits.filter((hit) => !hit.browser).length, 2);
  assert.equal(fixture.hits.filter((hit) => hit.browser).length, 4);

  // The verdict is recorded, with WHICH edge refused us — the fleet report's whole
  // reason to exist.
  const profile = await pool.query(
    "SELECT verdict, winning_rung, edge_server, last_status FROM host_probe_profiles WHERE host = $1",
    [host]
  );

  assert.equal(profile.rows[0].verdict, "REFUSED");
  assert.equal(profile.rows[0].winning_rung, null);
  assert.equal(profile.rows[0].edge_server, "awselb/2.0");
  assert.equal(profile.rows[0].last_status, 405);

  // Patterns stay unscored and NO sampled_urls rows are fabricated.
  //
  // Unscored here is NULL, not 'PENDING': migration 002 dropped both the NOT NULL and
  // the 'PENDING' default on patterns.status, so a pattern that was never persisted
  // has no status at all. The frontend's normalizeStatus maps anything outside
  // GOOD/WARNING/BAD — NULL included — to UNKNOWN, which renders "Not scored". The
  // assertion is written against the values that actually mean "no verdict" rather
  // than against one spelling of it.
  const patterns = await pool.query(
    "SELECT status FROM patterns WHERE session_id = $1",
    [sessionId]
  );

  assert.equal(patterns.rowCount, 3);
  assert.equal(
    patterns.rows.every(
      (row) => row.status === null || row.status === "PENDING"
    ),
    true,
    `expected every pattern unscored, got ${JSON.stringify(
      patterns.rows.map((row) => row.status)
    )}`
  );

  const samples = await pool.query(
    "SELECT count(*)::int AS n FROM sampled_urls WHERE pattern_id = ANY($1::uuid[])",
    [patternIds]
  );

  assert.equal(samples.rows[0].n, 0);
});

test("a browser-only host is learned once, then sampling and verification both lead with it", async (t) => {
  if (!(await postgresReachable())) {
    t.skip("postgres not reachable — skipping");
    return;
  }

  if (!(await redisReachable())) {
    t.skip("redis not reachable — skipping");
    return;
  }

  // The weareelectromechanicals.com signature: the honest crawler UA is refused,
  // the browser profile is served normally.
  const fixture = await startFixture((hit, res) => {
    if (!hit.browser) {
      res.writeHead(405, { server: "nginx/1.28.3" });
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "text/html", server: "nginx/1.28.3" });
    res.end(LONG_BODY);
  });

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processSamplePatternsJob } = await import("./samplePatternsJob.js");
  const { processVerifyUrlsJob } = await import("./verifyUrlsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { resetHostStrategyMemory } = await import("../http/hostStrategy.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeRedisLockClient } = await import("../queue/redisLock.js");

  let sessionId: string | null = null;
  const host = new URL(fixture.baseUrl).host;

  t.after(async () => {
    fixture.server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await pool
      .query("DELETE FROM host_probe_profiles WHERE host = $1", [host])
      .catch(() => {});
    // LAST test in the file owns the shared pool and temp dir.
    await closePreGenerateZipQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);
  resetHostRateLimiter();
  resetHostStrategyMemory();

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('host strategy browser', $1, 5, 4, 'PROCESSING')
      RETURNING id
    `,
    [fixture.baseUrl]
  );

  sessionId = sessionRow.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, '/product/{param}/{param}', 5) RETURNING id",
    [sessionId]
  );
  const patternId = patternRow.rows[0].id;
  const locs: string[] = [];

  for (let index = 0; index < 5; index += 1) {
    const urlPath = `/product/cat-${index}/item-${index}`;

    locs.push(`${fixture.baseUrl}${urlPath}`);
    await pool.query(
      "INSERT INTO pattern_urls (session_id, pattern_id, source_url, path) VALUES ($1, $2, $3, $4)",
      [sessionId, patternId, `${fixture.baseUrl}${urlPath}`, urlPath]
    );
  }

  // Verification enumerates from the sitemap XML on disk, not from pattern_urls.
  const stored = `${sessionId}-strategy.xml`;

  writeFileSync(path.join(uploadDir, stored), urlset(locs), "utf8");
  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, locs.length]
  );

  await processSamplePatternsJob({ session_id: sessionId }, silentLogger);

  // R1 was learned, and it is persisted with the edge that answered.
  const profile = await pool.query(
    "SELECT verdict, winning_rung, edge_server FROM host_probe_profiles WHERE host = $1",
    [host]
  );

  assert.equal(profile.rows[0].verdict, "OK");
  assert.equal(profile.rows[0].winning_rung, "R1");
  assert.equal(profile.rows[0].edge_server, "nginx/1.28.3");

  // Negotiation cost R0 (HEAD 405 + GET 405) then R1 (HEAD 200 + soft-404 GET) = 4
  // requests. Everything AFTER that is per-URL work, and none of it may use the
  // honest UA: the learned rung leads, so each of the 5 URLs costs HEAD + soft-404
  // GET with the browser profile — 10 requests, not the 20 v1.60 would have spent
  // climbing from R0 on every URL.
  const negotiation = fixture.hits.slice(0, 4);
  const perUrl = fixture.hits.slice(4);

  assert.equal(negotiation.filter((hit) => !hit.browser).length, 2);
  assert.equal(perUrl.length, 10, `per-URL requests: ${perUrl.length}`);
  assert.equal(
    perUrl.every((hit) => hit.browser),
    true,
    "the learned rung must lead — no honest-UA request should follow negotiation"
  );

  const scored = await pool.query(
    "SELECT status, confidence_pct FROM patterns WHERE id = $1",
    [patternId]
  );

  assert.equal(scored.rows[0].status, "GOOD");
  assert.equal(Number(scored.rows[0].confidence_pct), 100);

  // ---- verification reuses the SAME strategy, in a fresh run --------------
  const before = fixture.hits.length;
  const jobRow = await pool.query<{ id: string }>(
    "INSERT INTO maintenance_jobs (session_id, kind, pattern_ids) VALUES ($1, 'verify-urls', $2::uuid[]) RETURNING id",
    [sessionId, [patternId]]
  );

  // A fresh run-level memo (as a separate process would have) — so this proves the
  // STORE is what carries the answer across, not a lucky in-memory cache.
  resetHostStrategyMemory();

  await processVerifyUrlsJob(
    {
      session_id: sessionId,
      job_row_id: jobRow.rows[0].id,
      pattern_ids: [patternId],
      target_statuses: null
    },
    silentLogger
  );

  const verifyHits = fixture.hits.slice(before);

  // NO re-negotiation: not one honest-UA request. Verification read the strategy
  // sampling stored and went straight to the learned rung.
  assert.equal(
    verifyHits.some((hit) => !hit.browser),
    false,
    `verification re-negotiated: ${verifyHits
      .map((hit) => `${hit.method} ${hit.url} ${hit.browser ? "browser" : "crawler"}`)
      .join(" | ")}`
  );
  // 5 URLs, one HEAD each (verification skips the redirect follow-up and these are
  // 2xx, so the soft-404 GET is the second request per URL).
  assert.equal(verifyHits.length, 10, `verification requests: ${verifyHits.length}`);

  const verified = await pool.query(
    "SELECT count(*)::int AS n FROM verified_urls WHERE session_id = $1 AND http_status = 200",
    [sessionId]
  );

  assert.equal(verified.rows[0].n, 5);
});
