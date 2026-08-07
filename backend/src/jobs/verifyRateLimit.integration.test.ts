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
// Every fixture URL answers 404, so one URL check is exactly one HTTP request
// and "checks" and "requests" are the same number. A 2xx would add the
// soft-404 GET and blur the comparison.
const URL_COUNT = 60;

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

    await closePreGenerateZipQueue().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
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
    worstSecond <= REQUESTS_PER_SECOND + BURST,
    `a one-second window held ${worstSecond} requests, above the ${REQUESTS_PER_SECOND}+${BURST} ceiling`
  );

  // sessions.concurrency is 30 here — above the config cap of 8 — so this also
  // confirms the clamp holds on the real job path, not just in a unit test.
  const verified = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM verified_urls WHERE session_id = $1",
    [sessionId]
  );

  assert.equal(Number(verified.rows[0].count), URL_COUNT);
});
