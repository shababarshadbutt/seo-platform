import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// End-to-end proof that a real verification run is PACED, not just capped.
//
// hostRateLimiter.test.ts proves the scheduling maths exactly, on a virtual
// clock. This proves the limiter is actually wired into the path a verification
// takes — that probeUrl charges the budget, that the job uses probeUrl, and
// that the resulting traffic at a real socket comes out at the configured rate.
// Those are separate claims: a correct limiter that nobody calls looks exactly
// like no limiter at all.
//
// Its own file because config.ts reads the rate from the environment ONCE at
// module load, so a test that needs the real 25/s default cannot share a
// process with verifyScoping.integration.test.ts, which raises it out of the
// way to measure scoping instead.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
process.env.VERIFY_MAX_REQUESTS_PER_SECOND = "25";
process.env.VERIFY_RATE_LIMIT_BURST = "10";
process.env.VERIFY_MAX_CONCURRENCY = "8";

const REQUESTS_PER_SECOND = 25;
const BURST = 10;
// Extra arrivals tolerated inside a one-second window.
//
// The limiter controls when a request is RELEASED; this fixture measures when
// it ARRIVES, and under a loaded event loop (the full suite running in one
// process) those drift apart — releases the limiter spaced correctly land
// bunched. The limiter already carries a 250ms jitter allowance internally;
// this covers the rest rather than pretending arrival timing is something the
// limiter can guarantee. The SUSTAINED rate assertion below is the tight one
// and is not affected by bunching.
const WINDOW_JITTER_ALLOWANCE = 8;
// Every fixture URL answers 404, so one URL check is exactly one HTTP request
// and "checks" and "requests" are the same number. A 2xx would add the
// soft-404 GET and blur the comparison.
const URL_COUNT = 60;
// The SECOND fixture deliberately does the opposite: every URL answers 200, so
// each check costs TWO requests — the HEAD plus the soft-404 GET. That is the
// case the original limiter got wrong.
//
// It used to use REDIRECTS for the two-request case, which stopped working when
// verification began skipping the follow-up HEAD on a 3xx destination (that
// request fed only responseMs, which verified_urls never stored). A 2xx is now
// the only shape that still costs two requests on this path, which is exactly
// why the test has to use it: the assertion below checks the PREMISE, so the
// test failed loudly rather than silently passing on a one-request fixture.
const TWO_REQUEST_URL_COUNT = 40;
// Long enough to clear the soft-404 short-body heuristic (1000 bytes).
const LONG_BODY = "healthy fixture product page content. ".repeat(60);

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "verify-ratelimit-itest-"));

process.env.UPLOAD_DIR = uploadDir;

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

test("a real verification run is paced at the configured requests/second", async (t) => {
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

  const arrivals: number[] = [];
  const server = createServer((_req, res) => {
    arrivals.push(Date.now());
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processVerifyUrlsJob } = await import("./verifyUrlsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );

  let sessionId: string | null = null;

  t.after(async () => {
    server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    // The pg pool and the temp dir are MODULE-level and shared with the second
    // test in this file, so they are torn down there (the last test) rather
    // than here. Closing them per-test made the second test fail with "Cannot
    // use a pool after calling end on the pool".
    await closePreGenerateZipQueue().catch(() => {});
  });

  await runMigrations(silentLogger);

  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('verify rate limit', $1, 5, 30)
      RETURNING id
    `,
    [baseUrl]
  );

  sessionId = sessionResult.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, '/product/{param}', $2)
      RETURNING id
    `,
    [sessionId, URL_COUNT]
  );
  const patternId = patternRow.rows[0].id;
  const locs = Array.from(
    { length: URL_COUNT },
    (_, index) => `${baseUrl}/product/sku-${index}`
  );
  const stored = `${sessionId}-current.xml`;

  writeFileSync(path.join(uploadDir, stored), urlset(locs), "utf8");
  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, URL_COUNT]
  );

  const jobRow = await pool.query<{ id: string }>(
    `
      INSERT INTO maintenance_jobs (session_id, kind, pattern_ids)
      VALUES ($1, 'verify-urls', $2::uuid[])
      RETURNING id
    `,
    [sessionId, [patternId]]
  );

  resetHostRateLimiter();
  arrivals.length = 0;

  await processVerifyUrlsJob(
    {
      session_id: sessionId,
      job_row_id: jobRow.rows[0].id,
      pattern_ids: [patternId],
      target_statuses: null
    },
    silentLogger
  );

  assert.equal(arrivals.length, URL_COUNT);

  const spanMs = arrivals[arrivals.length - 1] - arrivals[0];
  const observedRate = (arrivals.length - 1) / (spanMs / 1000);
  // The burst is spent up front, so the paced portion is what must take time:
  // (60 - 10) requests at 25/s = 2000ms minimum.
  const expectedMinMs = ((URL_COUNT - BURST) / REQUESTS_PER_SECOND) * 1000;

  console.log(
    `[rate limit] ${arrivals.length} requests over ${spanMs}ms = ` +
      `${observedRate.toFixed(1)} req/s (cap ${REQUESTS_PER_SECOND}/s, burst ${BURST}); ` +
      `floor for the paced portion ${expectedMinMs}ms`
  );

  // Loopback with no rate limiter finishes 60 requests in well under 100ms, so
  // this margin is enormous relative to what an unpaced run would produce.
  assert.ok(
    spanMs >= expectedMinMs * 0.9,
    `run finished in ${spanMs}ms, faster than the ${expectedMinMs}ms the rate cap requires`
  );

  // Sustained rate, allowing for the burst credit inflating the early window.
  assert.ok(
    observedRate <= REQUESTS_PER_SECOND * 1.5,
    `observed ${observedRate.toFixed(1)} req/s against a ${REQUESTS_PER_SECOND}/s cap`
  );

  // No window of one second may contain more than burst + rate requests. This
  // is the assertion that would catch a limiter that averages correctly but
  // still lets a spike through — the thing that trips a WAF.
  let worstSecond = 0;

  for (let index = 0; index < arrivals.length; index += 1) {
    const windowEnd = arrivals[index] + 1000;
    let count = 0;

    for (let scan = index; scan < arrivals.length; scan += 1) {
      if (arrivals[scan] < windowEnd) {
        count += 1;
      } else {
        break;
      }
    }

    worstSecond = Math.max(worstSecond, count);
  }

  console.log(`[rate limit] worst one-second window: ${worstSecond} requests`);
  assert.ok(
    worstSecond <= REQUESTS_PER_SECOND + BURST + WINDOW_JITTER_ALLOWANCE,
    `a one-second window held ${worstSecond} requests, above the ` +
      `${REQUESTS_PER_SECOND}+${BURST} ceiling (+${WINDOW_JITTER_ALLOWANCE} jitter)`
  );

  // sessions.concurrency is 30 here — above the config cap of 8 — so this also
  // confirms the clamp holds on the real job path, not just in a unit test.
  const verified = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM verified_urls WHERE session_id = $1",
    [sessionId]
  );

  assert.equal(Number(verified.rows[0].count), URL_COUNT);
});

test("the rate ceiling counts REQUESTS, not checks, when a check costs two", async (t) => {
  if (!(await postgresReachable())) {
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  // THE REGRESSION THIS PINS. The limiter used to take one slot per CHECK, so a
  // pattern whose checks cost two requests sent roughly twice the configured
  // rate at the target. Measured before the fix: 49.17 requests/second against
  // a 25/s ceiling (bench/verifyThroughput.ts, 1,200 URLs, 25ms origin).
  //
  // It was invisible against a slow origin because concurrency capped
  // throughput before the limiter engaged, which is why this fixture answers
  // INSTANTLY: with no latency to hide behind, only the limiter can hold the
  // rate down.
  const arrivals: number[] = [];
  const server = createServer((req, res) => {
    arrivals.push(Date.now());
    res.writeHead(200, { "content-type": "text/html" });
    // HEAD gets no body; the soft-404 GET that follows gets the long one.
    res.end(req.method === "HEAD" ? undefined : LONG_BODY);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processVerifyUrlsJob } = await import("./verifyUrlsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );

  let sessionId: string | null = null;

  t.after(async () => {
    server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await closePreGenerateZipQueue().catch(() => {});
  });

  await runMigrations(silentLogger);

  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('verify rate limit two-request', $1, 5, 30)
      RETURNING id
    `,
    [baseUrl]
  );

  sessionId = sessionResult.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, '/product/{param}', $2) RETURNING id",
    [sessionId, TWO_REQUEST_URL_COUNT]
  );
  const patternId = patternRow.rows[0].id;
  const locs = Array.from(
    { length: TWO_REQUEST_URL_COUNT },
    (_, index) => `${baseUrl}/product/sku-${index}`
  );
  const stored = `${sessionId}-two-request.xml`;

  writeFileSync(path.join(uploadDir, stored), urlset(locs), "utf8");
  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, TWO_REQUEST_URL_COUNT]
  );

  const jobRow = await pool.query<{ id: string }>(
    `
      INSERT INTO maintenance_jobs (session_id, kind, pattern_ids)
      VALUES ($1, 'verify-urls', $2::uuid[])
      RETURNING id
    `,
    [sessionId, [patternId]]
  );

  resetHostRateLimiter();
  arrivals.length = 0;

  await processVerifyUrlsJob(
    {
      session_id: sessionId,
      job_row_id: jobRow.rows[0].id,
      pattern_ids: [patternId],
      target_statuses: null
    },
    silentLogger
  );

  const requestsPerCheck = arrivals.length / TWO_REQUEST_URL_COUNT;
  const spanMs = arrivals[arrivals.length - 1] - arrivals[0];
  const observedRate = (arrivals.length - 1) / (spanMs / 1000);

  console.log(
    `[rate limit / 2-request checks] ${TWO_REQUEST_URL_COUNT} checks -> ${arrivals.length} ` +
      `requests (${requestsPerCheck.toFixed(2)}/check) over ${spanMs}ms = ` +
      `${observedRate.toFixed(1)} req/s (cap ${REQUESTS_PER_SECOND}/s)`
  );

  // The premise: a redirect really does cost two requests. Without this the
  // test could pass on a fixture that never exercised the bug.
  assert.ok(
    requestsPerCheck >= 1.9,
    `expected ~2 requests per check, got ${requestsPerCheck.toFixed(2)}`
  );

  // And the fix: the REQUEST rate respects the ceiling. Metered per check, this
  // would come out near 2x.
  assert.ok(
    observedRate <= REQUESTS_PER_SECOND * 1.5,
    `observed ${observedRate.toFixed(1)} req/s against a ${REQUESTS_PER_SECOND}/s cap ` +
      "— the limiter is counting checks rather than requests"
  );

  let worstSecond = 0;

  for (let index = 0; index < arrivals.length; index += 1) {
    const windowEnd = arrivals[index] + 1000;
    let count = 0;

    for (let scan = index; scan < arrivals.length; scan += 1) {
      if (arrivals[scan] < windowEnd) {
        count += 1;
      } else {
        break;
      }
    }

    worstSecond = Math.max(worstSecond, count);
  }

  assert.ok(
    worstSecond <= REQUESTS_PER_SECOND + BURST + WINDOW_JITTER_ALLOWANCE,
    `a one-second window held ${worstSecond} requests, above the ` +
      `${REQUESTS_PER_SECOND}+${BURST} ceiling (+${WINDOW_JITTER_ALLOWANCE} jitter)`
  );
});

test("verification skips the redirect follow-up; final_url survives", async (t) => {
  if (!(await postgresReachable())) {
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  // The skip is scoped to VERIFICATION (delete-by-status), which needs each
  // URL's own status. It is safe because finalUrl is derived from the FIRST
  // response's Location header, not from the follow-up — the follow-up's result
  // fed only responseMs, which verified_urls does not store. This pins both
  // halves: one request per redirect check, and final_url still populated.
  const arrivals: string[] = [];
  const server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];

    arrivals.push(url);

    if (url.startsWith("/moved/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.method === "HEAD" ? undefined : LONG_BODY);
      return;
    }

    res.writeHead(301, { location: `/moved${url}` });
    res.end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { pool } = await import("../db/pool.js");
  const { processVerifyUrlsJob } = await import("./verifyUrlsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");

  let sessionId: string | null = null;

  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );

  t.after(async () => {
    server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    // Ownership of the module-level pool and temp dir moved to the SAMPLING test
    // below when it was appended after this one — the LAST test in the file owns
    // them. Closing them here broke the test after this with "Cannot use a pool
    // after calling end on the pool", which is exactly what the note this
    // replaces warned about, and it caught the mistake immediately.
    await closePreGenerateZipQueue().catch(() => {});
  });

  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('verify redirect skip', $1, 5, 10)
      RETURNING id
    `,
    [baseUrl]
  );

  sessionId = sessionResult.rows[0].id;

  const REDIRECTS = 12;
  const patternRow = await pool.query<{ id: string }>(
    "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, '/product/{param}', $2) RETURNING id",
    [sessionId, REDIRECTS]
  );
  const patternId = patternRow.rows[0].id;
  const locs = Array.from(
    { length: REDIRECTS },
    (_, index) => `${baseUrl}/product/sku-${index}`
  );
  const stored = `${sessionId}-redirect-skip.xml`;

  writeFileSync(path.join(uploadDir, stored), urlset(locs), "utf8");
  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, REDIRECTS]
  );

  const jobRow = await pool.query<{ id: string }>(
    `
      INSERT INTO maintenance_jobs (session_id, kind, pattern_ids)
      VALUES ($1, 'verify-urls', $2::uuid[])
      RETURNING id
    `,
    [sessionId, [patternId]]
  );

  resetHostRateLimiter();
  arrivals.length = 0;

  await processVerifyUrlsJob(
    {
      session_id: sessionId,
      job_row_id: jobRow.rows[0].id,
      pattern_ids: [patternId],
      target_statuses: null
    },
    silentLogger
  );

  // ONE request per redirect check: the destination was never fetched.
  assert.equal(arrivals.length, REDIRECTS);
  assert.equal(
    arrivals.filter((url) => url.startsWith("/moved/")).length,
    0,
    "verification fetched a redirect destination it does not use"
  );

  // …and the status and destination are still recorded in full.
  const verified = await pool.query<{
    http_status: number;
    final_url: string | null;
  }>(
    "SELECT http_status, final_url FROM verified_urls WHERE session_id = $1 ORDER BY url ASC",
    [sessionId]
  );

  assert.equal(verified.rowCount, REDIRECTS);

  for (const row of verified.rows) {
    assert.equal(row.http_status, 301);
    assert.ok(
      row.final_url && row.final_url.includes("/moved/product/sku-"),
      `final_url lost by the skip: ${row.final_url}`
    );
  }

  console.log(
    `[redirect skip] ${REDIRECTS} redirect checks -> ${arrivals.length} requests ` +
      `(was ${REDIRECTS * 2}); final_url populated on all ${verified.rowCount}`
  );
});

// ---------------------------------------------------------------------------
// SAMPLING shares the same per-host budget as verification.
//
// The gap this closes, confirmed by production data rather than theory: 9ad4ddc6
// paced verification (verifyProbe.ts) and left samplePatternsJob with NO pacing
// at all — no beforeRequest hook, running at session.concurrency. Session
// 431cbba3 then produced 8 patterns with sample_rows = 1 and statuses = {405},
// the AWS WAF Bot Control signature, on the sampling path.
//
// Added to THIS file rather than a new one on purpose: node --test parallelises
// by FILE, and a new heavy integration file is exactly what tipped the suite's
// contention threshold in the previous two rounds. This file already pins the
// rate env at module load, which is what the test needs.
//
// THE DISCRIMINATING ASSERTION IS THE DURATION FLOOR. An unpaced run of 40 checks
// at session.concurrency = 10 against a local fixture finishes in tens of
// milliseconds; a paced one cannot beat (40 - burst) / 25 seconds. A rate ceiling
// alone would pass on the unpaced code too, because a fast local fixture never
// exceeds it in the first place.
// sessions.sample_size is CHECK-constrained to 5 | 10 | 20, and sampling draws
// min(sample_size, total_urls) per pattern — so one pattern caps at 20 checks.
// Two patterns of 20 on the SAME host gets to 40, and additionally proves the
// per-host budget is shared ACROSS patterns rather than reset per pattern, which
// is the property that makes an 823-pattern session safe.
const SAMPLING_PATTERNS = 2;
const SAMPLING_PER_PATTERN = 20;
const SAMPLING_URL_COUNT = SAMPLING_PATTERNS * SAMPLING_PER_PATTERN;

test("sampling is paced through the same per-host limiter as verification", async (t) => {
  if (!(await postgresReachable())) {
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const arrivals: number[] = [];
  const server = createServer((_req, res) => {
    arrivals.push(Date.now());
    // 404 keeps it at exactly one HTTP request per check: no soft-404 GET, and
    // no HEAD->GET method-rejection re-probe.
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const { pool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processSamplePatternsJob } = await import("./samplePatternsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { closePool } = await import("../db/pool.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  // processSamplePatternsJob finishes by calling markSessionComplete, which lives
  // in sessionCompletion.ts and touches sitemapQueue as well as the zip queue —
  // a SECOND BullMQ Redis connection. Leaving it open kept the test process alive
  // after every test had passed, so the file "failed" on the runner's own timeout
  // with nothing wrong in it. The verification-only tests above never reached
  // that code path, which is why this file exited cleanly before.
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");

  let sessionId: string | null = null;

  t.after(async () => {
    server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    // LAST test in the file owns the module-level pool and temp dir. Closing them
    // in an earlier test breaks every test after it with "Cannot use a pool after
    // calling end on the pool" — which is exactly how appending this test failed
    // the first time. If another test is ever added below, move these two lines.
    await closePreGenerateZipQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);

  // concurrency 10 is the DEFAULT that used to run unpaced — the point is that
  // pacing now governs regardless of how high this is set.
  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('sampling rate limit', $1, $2, 10)
      RETURNING id
    `,
    [baseUrl, SAMPLING_PER_PATTERN]
  );

  sessionId = sessionResult.rows[0].id;

  // Sampling reads pattern_urls (loadSamplePool), not the sitemap file.
  for (let group = 0; group < SAMPLING_PATTERNS; group += 1) {
    const patternRow = await pool.query<{ id: string }>(
      `
        INSERT INTO patterns (session_id, template, total_urls)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [sessionId, `/group-${group}/{param}`, SAMPLING_PER_PATTERN]
    );
    const patternId = patternRow.rows[0].id;

    for (let index = 0; index < SAMPLING_PER_PATTERN; index += 1) {
      await pool.query(
        `
          INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
          VALUES ($1, $2, $3, $4)
        `,
        [
          sessionId,
          patternId,
          `${baseUrl}/group-${group}/sku-${index}`,
          `/group-${group}/sku-${index}`
        ]
      );
    }
  }

  const stored = `${sessionId}-current.xml`;

  writeFileSync(
    path.join(uploadDir, stored),
    urlset(
      Array.from(
        { length: SAMPLING_URL_COUNT },
        (_, index) =>
          `${baseUrl}/group-${Math.floor(index / SAMPLING_PER_PATTERN)}/sku-${
            index % SAMPLING_PER_PATTERN
          }`
      )
    ),
    "utf8"
  );
  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, SAMPLING_URL_COUNT]
  );

  resetHostRateLimiter();
  arrivals.length = 0;

  const startedMs = Date.now();

  await processSamplePatternsJob({ session_id: sessionId }, silentLogger);

  const elapsedMs = Date.now() - startedMs;

  // PREMISE: one request per check. If this drifts the rate maths below is
  // measuring something else, so it fails loudly rather than passing quietly.
  assert.equal(
    arrivals.length,
    SAMPLING_URL_COUNT,
    "expected exactly one HTTP request per sampled URL"
  );

  const spanMs = arrivals[arrivals.length - 1] - arrivals[0];
  const observedRate = (arrivals.length - 1) / (spanMs / 1000);
  // Burst credit is a fixed head start, so only the remainder is paced.
  const expectedMinMs =
    ((SAMPLING_URL_COUNT - BURST) / REQUESTS_PER_SECOND) * 1000;

  console.log(
    `[sampling rate limit] ${arrivals.length} requests over ${spanMs}ms = ` +
      `${observedRate.toFixed(1)} req/s (cap ${REQUESTS_PER_SECOND}/s, burst ${BURST}); ` +
      `job elapsed ${elapsedMs}ms, paced floor ${expectedMinMs}ms`
  );

  // THE ONE THAT PROVES THE FIX. Unpaced, this completes in tens of ms.
  assert.ok(
    elapsedMs >= expectedMinMs,
    `sampling finished in ${elapsedMs}ms, faster than the ${expectedMinMs}ms floor — it is not being paced`
  );

  // And the sustained rate respects the shared ceiling.
  assert.ok(
    observedRate <= REQUESTS_PER_SECOND + WINDOW_JITTER_ALLOWANCE,
    `sampling sustained ${observedRate.toFixed(1)} req/s against a ${REQUESTS_PER_SECOND}/s cap`
  );
});
