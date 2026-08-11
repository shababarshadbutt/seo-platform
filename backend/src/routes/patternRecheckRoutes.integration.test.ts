import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";

import pg from "pg";

// Route-level proof for the per-pattern re-check endpoints, which the job-level
// test (jobs/patternRecheck.integration.test.ts) bypasses by calling
// processSamplePatternsJob directly.
//
// Four behaviours live only in routes/verification.ts:
//   * the enqueued job actually carries pattern_id — without it the worker would
//     run a WHOLE-SESSION re-sample from a single row's button, which on a 1.3M-URL
//     session is the difference between four requests and hours of traffic;
//   * a second press ATTACHES to the in-flight job instead of stacking a second
//     one at the client's origin;
//   * a pattern with no stored sample pool is refused with an explanation, rather
//     than enqueueing a job that writes nothing and leaves the row unscored for a
//     second, more confusing reason;
//   * the status endpoint reports blocked_count, which is the only way the UI can
//     tell "checked, and the site refused" apart from "never checked" — both of
//     which render as "Not scored".
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

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

test("pattern re-check routes scope, attach and explain", async (t) => {
  if (!(await postgresReachable())) {
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const Fastify = (await import("fastify")).default;
  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { verificationRoutes } = await import("./verification.js");
  const { closeVerificationQueue } = await import(
    "../queue/verificationQueue.js"
  );
  const { closeTriageQueue } = await import("../queue/triageQueue.js");
  const { closeMaintenanceQueue } = await import(
    "../queue/maintenanceQueue.js"
  );
  const { closeSitemapQueue, samplePatternJobId, sitemapQueue } = await import(
    "../queue/sitemapQueue.js"
  );

  const app = Fastify({ logger: false });

  await app.register(verificationRoutes);
  await runMigrations(silentLogger);

  let sessionId: string | null = null;
  let scopedPatternId: string | null = null;

  t.after(async () => {
    // Exercising the real route means really enqueueing. The session is deleted
    // here, so the job has to go too — otherwise a worker picks it up later,
    // fails it with "Session not found", and leaves failed entries in a shared
    // Redis for whoever runs the suite next.
    if (sessionId && scopedPatternId) {
      await sitemapQueue
        .getJob(samplePatternJobId(sessionId, scopedPatternId))
        .then((job) => job?.remove())
        .catch(() => {});
    }

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await app.close().catch(() => {});
    await closeVerificationQueue().catch(() => {});
    await closeTriageQueue().catch(() => {});
    await closeMaintenanceQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closePool().catch(() => {});
  });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('pattern recheck routes', 'http://127.0.0.1:1/', 5, 10, 'COMPLETED')
      RETURNING id
    `
  );

  sessionId = sessionRow.rows[0].id;

  // One pattern WITH a stored sample pool (and a blocked sample, the frozen
  // "Not scored" state), one WITHOUT.
  const withPool = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls, status)
      VALUES ($1, '/about-us', 1, 'PENDING')
      RETURNING id
    `,
    [sessionId]
  );

  scopedPatternId = withPool.rows[0].id;

  const withoutPool = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls, status)
      VALUES ($1, '/no-pool', 1, 'PENDING')
      RETURNING id
    `,
    [sessionId]
  );
  const emptyPatternId = withoutPool.rows[0].id;

  await pool.query(
    `
      INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
      VALUES ($1, $2, 'http://127.0.0.1:1/about-us', '/about-us')
    `,
    [sessionId, scopedPatternId]
  );
  await pool.query(
    `
      INSERT INTO sampled_urls (
        pattern_id, url, http_status, response_ms, is_hit, is_soft_404,
        checked_at, redirect_count, http_status_category, used_fallback_profile
      )
      VALUES ($1, 'http://127.0.0.1:1/about-us', 405, 9, false, false, now(), 0,
              'blocked', true)
    `,
    [scopedPatternId]
  );

  // --- an unknown pattern is a 404, not a silent no-op ----------------------
  const unknown = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${"00000000-0000-0000-0000-000000000000"}/recheck`
  });

  assert.equal(unknown.statusCode, 404);

  // --- no stored sample pool: refused, with a reason ------------------------
  const noPool = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${emptyPatternId}/recheck`
  });

  assert.equal(noPool.statusCode, 400);
  assert.match(noPool.json().message, /no stored sample URLs/);

  // --- the real thing: enqueued, and SCOPED to this pattern ----------------
  const started = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${scopedPatternId}/recheck`
  });

  assert.equal(started.statusCode, 202);
  assert.equal(
    started.json().job_id,
    samplePatternJobId(sessionId, scopedPatternId)
  );

  const job = await sitemapQueue.getJob(
    samplePatternJobId(sessionId, scopedPatternId)
  );
  // The queue's data type is a union over every sitemap job; this route only ever
  // enqueues the sampling shape.
  const jobData = job?.data as
    | { session_id?: string; pattern_id?: string }
    | undefined;

  // THE SCOPE ASSERTION. Without pattern_id in the payload the worker re-samples
  // the WHOLE session from one row's button.
  assert.equal(jobData?.pattern_id, scopedPatternId);
  assert.equal(jobData?.session_id, sessionId);

  // --- a second press attaches to the same job -----------------------------
  const again = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${scopedPatternId}/recheck`
  });

  assert.equal(again.statusCode, 202);
  assert.equal(again.json().job_id, started.json().job_id);
  assert.equal(await sitemapQueue.getWaitingCount(), 1);

  // --- the status endpoint distinguishes blocked from never-checked ---------
  const status = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${scopedPatternId}/recheck`
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, "PENDING");
  assert.equal(status.json().sample_total, 1);
  assert.equal(status.json().blocked_count, 1);
  assert.equal(status.json().used_fallback_count, 1);
  assert.equal(status.json().pool_total, 1);
  assert.equal(status.json().running, true);

  const emptyStatus = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${emptyPatternId}/recheck`
  });

  // Never checked: no samples at all, and no pool to check — the two cases the
  // table cannot tell apart on its own.
  assert.equal(emptyStatus.json().sample_total, 0);
  assert.equal(emptyStatus.json().blocked_count, 0);
  assert.equal(emptyStatus.json().pool_total, 0);
  assert.equal(emptyStatus.json().running, false);
});
