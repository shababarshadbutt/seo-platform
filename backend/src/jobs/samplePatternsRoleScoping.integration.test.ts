import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// THE CSV WIZARD HANG. The "Detecting patterns and checking sample URLs…" step
// never reached READY: samplePatternsJob's query hardcoded `source_role =
// 'current'`, so patterns extracted from an uploaded CSV (source_role =
// 'legacy') never got a status written and the csv-upload endpoint's
// sampled_count stayed 0 forever. This proves the fix on three fronts:
//
//   1. A session-wide run scoped to both roles (what extractPatternsJob now
//      requests after a CSV upload) samples the legacy pattern.
//   2. resume: true on that same call skips a 'current' pattern that was
//      already sampled, instead of re-verifying the whole site from scratch
//      on every CSV upload.
//   3. A scoped single-pattern re-check (the Step 3 "Check" button) works on
//      a legacy pattern too — previously the hardcoded role filter combined
//      with the pattern id made it silently match zero rows.
//
// Also proves the default (no source_roles given) still samples 'current'
// only, so every pre-existing caller keeps its old behavior.
//
// Skips (does not fail) when postgres/redis are not reachable, like the other
// integration tests here. Redis is needed only because samplePatternsJob
// transitively constructs the pre-generate-ZIP queue at module load.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "sample-role-itest-"));

process.env.UPLOAD_DIR = uploadDir;

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

test("legacy (CSV) patterns get sampled, 'current' patterns are not wastefully re-sampled, and a scoped recheck works on either role", async (t) => {
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

  const server = createServer((_req, res) => {
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
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);
  resetHostRateLimiter();

  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('sample role scoping', $1, 5, 4, 'COMPLETED')
      RETURNING id
    `,
    [baseUrl]
  );

  sessionId = sessionResult.rows[0].id;

  async function insertPattern(
    sourceRole: "current" | "legacy",
    template: string,
    status: string
  ) {
    const row = await pool.query<{ id: string }>(
      `
        INSERT INTO patterns (session_id, source_role, template, total_urls, status, confidence_pct, redirect_pct)
        VALUES ($1, $2, $3, 1, $4, 0, 0)
        RETURNING id
      `,
      [sessionId, sourceRole, template, status]
    );
    const patternId = row.rows[0].id;

    await pool.query(
      `
        INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
        VALUES ($1, $2, $3, $4)
      `,
      [sessionId, patternId, `${baseUrl}${template}`, template]
    );

    return patternId;
  }

  // Already sampled 'current' pattern (as if from the site's original S3
  // pull). http_status 599 is not a value the fixture server can produce
  // (it always returns 200), so if this row is ever re-fetched instead of
  // skipped, the assertion below on http_status catches it.
  const currentPatternId = await insertPattern("current", "/already-sampled", "GOOD");

  await pool.query(
    `
      INSERT INTO sampled_urls (
        pattern_id, url, http_status, response_ms, is_hit, is_soft_404,
        checked_at, redirect_count, http_status_category
      )
      VALUES ($1, $2, 599, 12, false, false, now() - interval '2 days', 0, 'blocked')
    `,
    [currentPatternId, `${baseUrl}/already-sampled`]
  );

  // Freshly extracted 'legacy' (CSV wizard) pattern — the exact shape that
  // hung forever: status stays PENDING and is never touched by an unscoped
  // 'current'-only sample run.
  const legacyPatternId = await insertPattern("legacy", "/csv-url", "PENDING");

  // A second legacy pattern, sampled only via the scoped single-pattern path
  // (mirrors the Step 3 "Check" button re-check endpoint).
  const legacyRecheckPatternId = await insertPattern(
    "legacy",
    "/csv-recheck",
    "PENDING"
  );

  // 1) The fixed extractPatternsJob auto-nudge: both roles, resume: true.
  // Must run BEFORE any other call touches currentPatternId, since this is
  // what proves resume: true skips a pattern that was ALREADY sampled before
  // this job ever ran (the 599 seeded above, pre-existing).
  await processSamplePatternsJob(
    {
      session_id: sessionId,
      source_roles: ["current", "legacy"],
      resume: true
    },
    silentLogger
  );

  const legacyAfterFixedRun = await pool.query<{ status: string | null }>(
    "SELECT status FROM patterns WHERE id = $1",
    [legacyPatternId]
  );

  // Bug 1 fixed: the legacy (CSV) pattern actually got sampled.
  assert.equal(legacyAfterFixedRun.rows[0].status, "GOOD");

  const legacySamples = await pool.query<{ http_status: number }>(
    "SELECT http_status FROM sampled_urls WHERE pattern_id = $1",
    [legacyPatternId]
  );

  assert.equal(legacySamples.rowCount, 1);
  assert.equal(legacySamples.rows[0].http_status, 200);

  const currentAfterFixedRun = await pool.query<{ http_status: number }>(
    "SELECT http_status FROM sampled_urls WHERE pattern_id = $1",
    [currentPatternId]
  );

  // Bug 2 fixed: resume: true skipped the already-sampled 'current' pattern
  // instead of re-verifying it — the stale 599 is still there, unreplaced.
  assert.equal(currentAfterFixedRun.rowCount, 1);
  assert.equal(currentAfterFixedRun.rows[0].http_status, 599);

  // 3) Bug 3 fixed: a scoped recheck (pattern_id only, no source_roles — the
  // exact call the verification.ts recheck route makes) works on a legacy
  // pattern instead of silently matching zero rows.
  await processSamplePatternsJob(
    { session_id: sessionId, pattern_id: legacyRecheckPatternId },
    silentLogger
  );

  const legacyRecheckAfter = await pool.query<{ status: string | null }>(
    "SELECT status FROM patterns WHERE id = $1",
    [legacyRecheckPatternId]
  );

  assert.equal(legacyRecheckAfter.rows[0].status, "GOOD");

  // 4) The bare, unscoped call every OTHER pre-existing caller still makes
  // (no source_roles) must keep touching 'current' only. Uses a brand new
  // pattern rather than reusing legacyPatternId, since that one was already
  // sampled above — this checks the DEFAULT, not a repeat.
  const freshLegacyPatternId = await insertPattern(
    "legacy",
    "/csv-untouched-by-default",
    "PENDING"
  );

  await processSamplePatternsJob({ session_id: sessionId }, silentLogger);

  const freshLegacyAfterDefaultRun = await pool.query<{ status: string | null }>(
    "SELECT status FROM patterns WHERE id = $1",
    [freshLegacyPatternId]
  );

  assert.equal(
    freshLegacyAfterDefaultRun.rows[0].status,
    "PENDING",
    "an unscoped call with no source_roles must not touch legacy patterns (default stays 'current' only)"
  );
});
