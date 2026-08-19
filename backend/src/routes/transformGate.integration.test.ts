import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// THE GATE: a transform over a population bigger than the preview pool is
// refused until it has been measured.
//
// This is the control the whole feature turns on, and it fails in two opposite
// and equally bad ways, so both are asserted here rather than just the happy
// path:
//
//   * NEVER FIRING — the apply sails through unmeasured and the gate is
//     decoration. Nothing else in the system would notice.
//   * ALWAYS FIRING — including for patterns the preview HAS fully seen, where
//     a second full read buys nothing and just makes small edits slow.
//
// The third assertion is the one that makes the gate mean something: a dry run
// for a DIFFERENT rule must not authorise this one. Without it a user could
// measure a safe change, edit the rule, and apply something never checked.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "gate-itest-"));
const exportDir = mkdtempSync(path.join(os.tmpdir(), "gate-itest-exp-"));

process.env.UPLOAD_DIR = uploadDir;
process.env.EXPORT_DIR = exportDir;

const BASE = "https://example.com";

const URL_COUNT = 40;

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

test("the apply gate fires only when the preview cannot see the population", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
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
      VALUES ('transform gate', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  // Each pattern gets its OWN prefix, file and template: patterns are unique per
  // (session, role, template), and reusing one would collide before the gate is
  // ever reached.
  async function makePattern(
    prefix: string,
    totalUrls: number,
    pooled: number
  ) {
    const urls = Array.from(
      { length: URL_COUNT },
      (_, index) => `${BASE}/${prefix}/part-${700 + index}/`
    );
    const display = `${prefix}.xml`;
    const stored = `${sessionId}-${display}`;

    writeFileSync(
      path.join(uploadDir, stored),
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
        urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n") +
        "\n</urlset>\n",
      "utf8"
    );

    await pool.query(
      `
        INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
        VALUES ($1, $2, $3, now(), true, false)
      `,
      [sessionId, stored, URL_COUNT]
    );

    const row = await pool.query<{ id: string }>(
      `
        INSERT INTO patterns (session_id, template, total_urls)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [sessionId, `/${prefix}/{param}`, totalUrls]
    );
    const patternId = row.rows[0].id;

    await pool.query(
      `
        INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count)
        VALUES ($1, $2, $3)
      `,
      [patternId, display, URL_COUNT]
    );

    for (let index = 0; index < pooled; index += 1) {
      await pool.query(
        `
          INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
          VALUES ($1, $2, $3, $4)
        `,
        [sessionId, patternId, urls[index], new URL(urls[index]).pathname]
      );
    }

    return {
      patternId,
      body: {
        current_structure: `/${prefix}/{A}/`,
        new_structure: `/nsn${prefix}/{A|split|6|-|}/`,
        source_files: [display]
      }
    };
  }

  // ---- 1. pool covers the population: NOT gated ----------------------------
  // patterns.total_urls === pattern_urls count, so the preview saw everything.
  const fullyPooled = await makePattern("apool", URL_COUNT, URL_COUNT);
  const allowed = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${fullyPooled.patternId}/transform`,
    payload: fullyPooled.body
  });

  assert.notEqual(
    allowed.statusCode,
    409,
    `a fully-pooled pattern must not be gated (got ${allowed.statusCode}: ${allowed.body})`
  );

  // ---- 2. population exceeds the pool: GATED -------------------------------
  const underSampled = await makePattern("bthin", URL_COUNT * 100, URL_COUNT);
  const blocked = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${underSampled.patternId}/transform`,
    payload: underSampled.body
  });

  assert.equal(blocked.statusCode, 409, blocked.body);

  const blockedBody = JSON.parse(blocked.body);

  assert.equal(blockedBody.needs_dry_run, true);
  assert.match(blockedBody.message, /run the full check first/);

  // ---- 3. a dry run for THIS rule opens the gate ----------------------------
  const dryRun = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${underSampled.patternId}/transform-dry-run`,
    payload: underSampled.body
  });

  assert.equal(dryRun.statusCode, 202, dryRun.body);

  const dryRunJobId = JSON.parse(dryRun.body).job_id;

  assert.ok(dryRunJobId, "the dry run should return a job id");

  // The worker is not running in this test, so drive the job directly and then
  // mark it COMPLETE exactly as the worker would.
  const { processPatternTransformDryRunJob } = await import(
    "../jobs/patternStructureJob.js"
  );

  await processPatternTransformDryRunJob(
    {
      session_id: sessionId,
      pattern_id: underSampled.patternId,
      job_row_id: dryRunJobId
    },
    silentLogger
  );

  const measured = await pool.query<{ status: string }>(
    "SELECT status FROM pattern_structure_jobs WHERE id = $1",
    [dryRunJobId]
  );

  assert.equal(measured.rows[0].status, "COMPLETE");

  const afterMeasuring = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${underSampled.patternId}/transform`,
    payload: underSampled.body
  });

  assert.notEqual(
    afterMeasuring.statusCode,
    409,
    `a measured transform must be allowed (got ${afterMeasuring.statusCode}: ${afterMeasuring.body})`
  );

  // ---- 4. the measurement does NOT authorise a different rule ---------------
  // The failure this catches: measure something safe, then edit the rule and
  // apply something that was never checked.
  const edited = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/patterns/${underSampled.patternId}/transform`,
    payload: {
      ...underSampled.body,
      new_structure: "/nsnbthin/niinpart/{A|split|6|-|}/"
    }
  });

  assert.equal(
    edited.statusCode,
    409,
    `an edited rule must be re-measured (got ${edited.statusCode}: ${edited.body})`
  );
});
