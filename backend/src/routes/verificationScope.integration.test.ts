import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";

import pg from "pg";

// Route-level proof for the SCOPE bookkeeping, which the job-level tests
// bypass by calling processVerifyUrlsJob directly.
//
// Three behaviours live only in routes/verification.ts, all of them new SQL,
// and all of them able to reintroduce the original confusion if wrong:
//   * attach must match on SCOPE, not just on session — otherwise a request to
//     verify one pattern joins a running whole-session sweep and polls its
//     1.3M-URL progress;
//   * the status endpoint must scope counts to the pattern asked about;
//   * a whole-session run must still be visible to a pattern-scoped poll, since
//     it does cover that pattern.
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

test("verification routes scope by pattern", async (t) => {
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
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");

  const { verificationQueue, verifyScopeJobId } = await import(
    "../queue/verificationQueue.js"
  );

  const app = Fastify({ logger: false });

  await app.register(verificationRoutes);
  await runMigrations(silentLogger);

  let sessionId: string | null = null;
  // Scopes this test causes the route to enqueue. Exercising the real route
  // means really enqueueing, and the session is deleted here afterwards — so
  // without this the worker later picks those jobs up, fails them with
  // "Session not found", and leaves failed entries in a shared Redis for
  // whoever runs the suite next. Seen in the worker log while verifying this
  // change against real containers.
  const enqueuedScopes: Array<string[] | null> = [];

  t.after(async () => {
    if (sessionId) {
      for (const scope of enqueuedScopes) {
        await verificationQueue
          .getJob(verifyScopeJobId(sessionId, scope))
          .then((job) => job?.remove())
          .catch(() => {});
      }

      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await app.close().catch(() => {});
    await closeVerificationQueue().catch(() => {});
    await closeTriageQueue().catch(() => {});
    await closeMaintenanceQueue().catch(() => {});
    // verification.ts also owns the per-pattern re-check routes, which enqueue on
    // (and read job state from) the sitemap queue — a FOURTH open Redis connection
    // from registering this plugin. Every one of them has to be closed or the test
    // worker never exits, and a worker that never exits never flushes its output:
    // the failure looks like a hung test rather than a leaked handle.
    await closeSitemapQueue().catch(() => {});
    await closePool().catch(() => {});
  });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('verification scope routes', 'http://127.0.0.1:1/', 5, 10)
      RETURNING id
    `
  );

  sessionId = sessionRow.rows[0].id;

  const patternRows = await pool.query<{ id: string; template: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, '/alpha/{param}', 10), ($1, '/beta/{param}', 10)
      RETURNING id, template
    `,
    [sessionId]
  );
  const alphaId = patternRows.rows.find((r) => r.template === "/alpha/{param}")!.id;
  const betaId = patternRows.rows.find((r) => r.template === "/beta/{param}")!.id;

  // Verified rows for both patterns, so a scoped count that leaks would show it.
  await pool.query(
    `
      INSERT INTO verified_urls (session_id, pattern_id, url, http_status, checked_at)
      SELECT $1, $2, 'http://127.0.0.1:1/alpha/' || g, 404, now()
      FROM generate_series(1, 7) AS g
    `,
    [sessionId, alphaId]
  );
  await pool.query(
    `
      INSERT INTO verified_urls (session_id, pattern_id, url, http_status, checked_at)
      SELECT $1, $2, 'http://127.0.0.1:1/beta/' || g, 404, now()
      FROM generate_series(1, 31) AS g
    `,
    [sessionId, betaId]
  );

  // ---- counts are scoped to the pattern asked about ------------------------
  const alphaStatus = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/verify-urls/status?pattern_id=${alphaId}`
  });
  const alphaBody = alphaStatus.json();

  assert.equal(alphaBody.scope, "pattern");
  assert.deepEqual(alphaBody.counts_by_status, [{ http_status: 404, count: 7 }]);

  const sessionStatus = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/verify-urls/status`
  });
  const sessionBody = sessionStatus.json();

  assert.equal(sessionBody.scope, "session");
  // Session-wide still reports everything — the Delete Problem URLs dialog
  // depends on this and must not have been narrowed.
  assert.deepEqual(sessionBody.counts_by_status, [
    { http_status: 404, count: 38 }
  ]);

  // ---- attach matches on scope --------------------------------------------
  const alphaJob = await pool.query<{ id: string }>(
    `
      INSERT INTO maintenance_jobs (session_id, kind, status, pattern_ids)
      VALUES ($1, 'verify-urls', 'RUNNING', $2::uuid[])
      RETURNING id
    `,
    [sessionId, [alphaId]]
  );

  // Same scope → attaches to the running job.
  const sameScope = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/verify-urls`,
    payload: { pattern_ids: [alphaId] }
  });

  assert.equal(sameScope.statusCode, 202);
  assert.equal(sameScope.json().job_row_id, alphaJob.rows[0].id);

  // DIFFERENT scope → must NOT attach. This is the defect the old query had:
  // it matched any in-flight verify-urls row for the session, so verifying
  // /beta would have been handed /alpha's job and reported its progress.
  enqueuedScopes.push([betaId]);
  const otherScope = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/verify-urls`,
    payload: { pattern_ids: [betaId] }
  });

  assert.equal(otherScope.statusCode, 202);
  assert.notEqual(otherScope.json().job_row_id, alphaJob.rows[0].id);

  const betaJobRow = await pool.query<{ pattern_ids: string[] }>(
    "SELECT pattern_ids FROM maintenance_jobs WHERE id = $1",
    [otherScope.json().job_row_id]
  );

  assert.deepEqual(betaJobRow.rows[0].pattern_ids, [betaId]);

  // Scope match is order-independent, so the same two patterns listed the other
  // way round is still the same scope.
  await pool.query(
    "UPDATE maintenance_jobs SET pattern_ids = $2::uuid[] WHERE id = $1",
    [alphaJob.rows[0].id, [alphaId, betaId]]
  );
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'COMPLETE' WHERE id = $1",
    [otherScope.json().job_row_id]
  );

  enqueuedScopes.push([betaId, alphaId]);
  const reordered = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/verify-urls`,
    payload: { pattern_ids: [betaId, alphaId] }
  });

  assert.equal(reordered.json().job_row_id, alphaJob.rows[0].id);

  // A whole-session request must NOT attach to that two-pattern job.
  enqueuedScopes.push(null);
  const wholeSession = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/verify-urls`,
    payload: {}
  });

  assert.notEqual(wholeSession.json().job_row_id, alphaJob.rows[0].id);

  const wholeRow = await pool.query<{ pattern_ids: string[] | null }>(
    "SELECT pattern_ids FROM maintenance_jobs WHERE id = $1",
    [wholeSession.json().job_row_id]
  );

  assert.equal(wholeRow.rows[0].pattern_ids, null);

  // ---- a whole-session run is visible to a pattern-scoped poll ------------
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'COMPLETE' WHERE session_id = $1 AND pattern_ids IS NOT NULL",
    [sessionId]
  );
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'RUNNING', files_total = 1324310, files_done = 167575 WHERE id = $1",
    [wholeSession.json().job_row_id]
  );

  const duringSessionRun = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/verify-urls/status?pattern_id=${alphaId}`
  });
  const duringBody = duringSessionRun.json();

  assert.equal(duringBody.job.id, wholeSession.json().job_row_id);
  // Reported, but flagged as session-wide so the client can label it instead of
  // showing 1,324,310 next to one pattern's name with no explanation.
  assert.equal(duringBody.job.pattern_ids, null);
  assert.equal(duringBody.job.urls_total, 1324310);
  // …while the COUNTS stay scoped to the pattern regardless.
  assert.deepEqual(duringBody.counts_by_status, [{ http_status: 404, count: 7 }]);

  // ---- enumeration-phase progress is surfaced by the status endpoint (v1.53)
  // The panel could only draw an indeterminate spinner during enumeration
  // because urls_total is 0 throughout it and nothing else was exposed. These
  // two columns are that missing signal, and they must survive the round trip
  // through the endpoint or the UI still has nothing to render.
  await pool.query(
    `UPDATE maintenance_jobs
       SET status = 'RUNNING', files_total = 0, files_done = 0,
           enum_files_total = 823, enum_files_done = 137
     WHERE id = $1`,
    [wholeSession.json().job_row_id]
  );

  const duringEnum = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/verify-urls/status?pattern_id=${alphaId}`
  });
  const enumBody = duringEnum.json();

  assert.equal(enumBody.job.enum_files_total, 823);
  assert.equal(enumBody.job.enum_files_done, 137);
  // urls_total stays 0 — that is what identifies the phase, and the file counts
  // are deliberately NOT written into it (see migration 041).
  assert.equal(enumBody.job.urls_total, 0);

  // Once the URL phase starts, enum_* read as null so the client switches phases
  // on a single poll rather than inferring it from two counters.
  await pool.query(
    `UPDATE maintenance_jobs
       SET files_total = 25744, files_done = 12,
           enum_files_total = NULL, enum_files_done = NULL
     WHERE id = $1`,
    [wholeSession.json().job_row_id]
  );

  const afterEnum = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/verify-urls/status?pattern_id=${alphaId}`
  });
  const afterBody = afterEnum.json();

  assert.equal(afterBody.job.enum_files_total, null);
  assert.equal(afterBody.job.enum_files_done, null);
  assert.equal(afterBody.job.urls_total, 25744);
  assert.equal(afterBody.job.urls_done, 12);

  // ---- target_statuses validation -----------------------------------------
  enqueuedScopes.push([alphaId]);
  const badStatus = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/verify-urls`,
    payload: { pattern_ids: [alphaId], target_statuses: [200] }
  });

  assert.equal(badStatus.statusCode, 400);

  const emptyPatterns = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/verify-urls`,
    payload: { pattern_ids: [] }
  });

  assert.equal(emptyPatterns.statusCode, 400);
});
