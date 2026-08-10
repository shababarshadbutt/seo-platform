import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// End-to-end verify-then-act test against a REAL database and a scripted local
// HTTP fixture, mirroring the nsnstocks repro distribution: 269 problem URLs
// (308s + 404s) and 91 healthy 200s across 5 sitemap files. It exercises the
// full pipeline in-process: processVerifyUrlsJob (full-population enumerate +
// HTTP check + verified_urls upsert), processDeleteProblemUrlsJob in
// use_verified mode (every problem <url> block physically removed from the
// rewritten XML), and processRestoreDeletedUrlsJob (all 360 back).
//
// THE COLLATERAL ASSERTION IS THE POINT: the 91 healthy URLs must all survive
// the delete untouched — a deletion that removes one byte too many is worse
// than no deletion.
//
// Skip mechanism: like sessionZipCache.integration.test.ts (which probes the
// dev stack's /health and t.skip()s when unreachable), this probes Postgres and
// Redis directly and t.skip()s when either is down, so a plain `npm test`
// without the dev stack stays green.
//
// Env is pinned BEFORE any src module is imported (all src imports below are
// dynamic): config.ts reads DATABASE_URL / REDIS_URL / UPLOAD_DIR once at module
// load, and the deletion rebuild resolves files against config.uploadDir.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

// The rate limiter is raised for this file so the measurement is of
// VERIFY-THEN-DELETE and not of pacing — same reasoning and same value as
// verifyScoping.integration.test.ts. Pacing is proven exactly in
// http/hostRateLimiter.test.ts (unit, virtual clock) and end-to-end in
// verifyRateLimit.integration.test.ts.
//
// Pinned rather than inherited on purpose. This file previously took the
// production default, so lowering that default to 5 req/s (the AWS WAF fix)
// turned a fast test into an 89.8s one and it blew the 60s suite timeout —
// while still passing in isolation. A test that asserts deletion correctness
// must not silently depend on a production tuning knob; 360 URLs paced at the
// shipped rate measures the limiter, which is already covered elsewhere.
process.env.VERIFY_MAX_REQUESTS_PER_SECOND = "5000";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "verify-urls-itest-"));

process.env.UPLOAD_DIR = uploadDir;

// ---- fixture distribution (mirrors the real nsnstocks repro) --------------
const REDIRECT_COUNT = 180; // /product/moved-<i>       -> 308 + Location
const NOT_FOUND_COUNT = 89; // /category/gone-<i>/parts -> 404
const OK_COUNT = 91; // /product/ok-<i>          -> 200
const PROBLEM_COUNT = REDIRECT_COUNT + NOT_FOUND_COUNT; // 269
const TOTAL_COUNT = PROBLEM_COUNT + OK_COUNT; // 360
const FILE_COUNT = 5;

// Long enough to clear the soft-404 short-body heuristic (1000 bytes) and free
// of every SOFT_404_TEXT_SIGNALS phrase.
const OK_BODY = "healthy fixture product page content. ".repeat(60);

type FixtureRoute = { status: number; location?: string };

function buildScript() {
  const script = new Map<string, FixtureRoute>();
  const redirectPaths: string[] = [];
  const notFoundPaths: string[] = [];
  const okPaths: string[] = [];

  for (let i = 0; i < REDIRECT_COUNT; i += 1) {
    const p = `/product/moved-${i}`;

    script.set(p, { status: 308, location: `/moved/${i}` });
    script.set(`/moved/${i}`, { status: 200 });
    redirectPaths.push(p);
  }

  for (let i = 0; i < NOT_FOUND_COUNT; i += 1) {
    const p = `/category/gone-${i}/parts`;

    script.set(p, { status: 404 });
    notFoundPaths.push(p);
  }

  for (let i = 0; i < OK_COUNT; i += 1) {
    const p = `/product/ok-${i}`;

    script.set(p, { status: 200 });
    okPaths.push(p);
  }

  return { script, redirectPaths, notFoundPaths, okPaths };
}

function startFixtureServer(script: Map<string, FixtureRoute>): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0];
    const route = script.get(url);

    if (!route) {
      res.writeHead(404);
      res.end("unscripted");
      return;
    }

    if (route.location) {
      res.writeHead(route.status, { location: route.location });
      res.end();
      return;
    }

    if (route.status === 200) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.method === "HEAD" ? undefined : OK_BODY);
      return;
    }

    res.writeHead(route.status);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

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

// The delete/restore jobs call invalidateSessionZipCache, which enqueues onto a
// BullMQ queue — if Redis is down that enqueue would spin on reconnects, so the
// test needs Redis just as much as Postgres.
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

// Minimal FastifyBaseLogger stand-in: the jobs only call info/warn/error.
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

test("verify-then-delete acts on the full population and spares the healthy 91", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping integration test`);
    return;
  }

  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping integration test`);
    return;
  }

  const { script, redirectPaths, notFoundPaths, okPaths } = buildScript();
  const { server, baseUrl } = await startFixtureServer(script);

  // All src imports are dynamic so the env pinning above happened first.
  const { pool, closePool } = await import("../db/pool.js");
  const { processVerifyUrlsJob } = await import("./verifyUrlsJob.js");
  const { processDeleteProblemUrlsJob, processRestoreDeletedUrlsJob } =
    await import("./maintenanceJobs.js");
  const { streamSitemapUrlLocs } = await import("../sitemaps/parser.js");
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

    // The Queue import above opened a Redis connection at module load; without
    // these closes the test process never exits.
    await closePreGenerateZipQueue().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  // ---- arrange: session + patterns + sitemap files on disk ----------------
  const sessionResult = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('verify-urls integration', $1, 5, 10)
      RETURNING id
    `,
    [baseUrl]
  );

  sessionId = sessionResult.rows[0].id;

  const productUrls = [...redirectPaths, ...okPaths].map((p) => `${baseUrl}${p}`);
  const categoryUrls = notFoundPaths.map((p) => `${baseUrl}${p}`);
  const allUrls = [...productUrls, ...categoryUrls];
  const okUrls = okPaths.map((p) => `${baseUrl}${p}`);
  const problemUrls = [...redirectPaths, ...notFoundPaths].map(
    (p) => `${baseUrl}${p}`
  );

  assert.equal(allUrls.length, TOTAL_COUNT);

  await pool.query(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, '/product/{param}', $2), ($1, '/category/{param}/parts', $3)
    `,
    [sessionId, productUrls.length, categoryUrls.length]
  );

  // Round-robin the 360 URLs over 5 files; duplicate ok-0 into a second file to
  // exercise <loc> dedupe + multi-file source_files. One decoy loc matching no
  // pattern proves non-matching URLs stay out of the population.
  const fileLocs: string[][] = Array.from({ length: FILE_COUNT }, () => []);

  allUrls.forEach((url, index) => {
    fileLocs[index % FILE_COUNT].push(url);
  });
  fileLocs[1].push(okUrls[0]); // duplicate: ok-0 already landed in file 0
  fileLocs[2].push(`${baseUrl}/about`); // decoy: matches no template

  for (let index = 0; index < FILE_COUNT; index += 1) {
    const stored = `${sessionId}-current-part-${index}.xml`;

    writeFileSync(path.join(uploadDir, stored), urlset(fileLocs[index]), "utf8");
    await pool.query(
      `
        INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
        VALUES ($1, $2, $3, now(), true, false)
      `,
      [sessionId, stored, fileLocs[index].length]
    );
  }

  // ---- act 0: enumeration publishes real per-file progress (v1.53) ----------
  // The reported bug was a 10+ minute indeterminate spinner: the panel shows
  // "Finding this pattern's URLs…" whenever urls_total === 0, and that is the
  // whole enumeration phase, during which nothing was published. Assert the
  // signal exists, starts with the denominator, and is monotonic — those are the
  // three properties a progress bar needs to not lie.
  const { enumeratePopulation } = await import("./patternPopulation.js");
  const patternRows = await pool.query<{ id: string; template: string }>(
    "SELECT id, template FROM patterns WHERE session_id = $1 AND source_role = 'current' ORDER BY template ASC",
    [sessionId]
  );
  const enumProgress: Array<[number, number]> = [];
  const enumeratedPopulation = await enumeratePopulation(
    sessionId,
    patternRows.rows,
    silentLogger,
    (filesDone, filesTotal) => {
      enumProgress.push([filesDone, filesTotal]);
    }
  );

  // It actually did the work — otherwise a progress assertion over an empty
  // file list would pass while proving nothing.
  assert.ok(
    enumeratedPopulation.size > 0,
    "enumeration must find URLs for the fixture patterns"
  );
  // The denominator arrives BEFORE any file is streamed, so the client can leave
  // the indeterminate spinner immediately rather than after the first file.
  assert.deepEqual(enumProgress[0], [0, FILE_COUNT]);
  // One call per file after that, and no more.
  assert.equal(enumProgress.length, FILE_COUNT + 1);
  assert.deepEqual(enumProgress.at(-1), [FILE_COUNT, FILE_COUNT]);
  // Monotonic non-decreasing, constant denominator. A bar that can go backwards
  // is worse than no bar.
  for (let index = 1; index < enumProgress.length; index += 1) {
    assert.ok(
      enumProgress[index][0] >= enumProgress[index - 1][0],
      `enum progress went backwards at ${index}: ${JSON.stringify(enumProgress)}`
    );
    assert.equal(enumProgress[index][1], FILE_COUNT);
  }

  // ---- act 1: verify the full population -----------------------------------
  const verifyJobRow = await pool.query<{ id: string }>(
    "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'verify-urls') RETURNING id",
    [sessionId]
  );

  await processVerifyUrlsJob(
    {
      session_id: sessionId,
      job_row_id: verifyJobRow.rows[0].id,
      pattern_ids: null,
      target_statuses: null
    },
    silentLogger
  );

  const verifyJob = await pool.query<{
    status: string;
    files_total: number;
    files_done: number;
    items_changed: string;
    enum_files_total: number | null;
    enum_files_done: number | null;
  }>(
    "SELECT status, files_total, files_done, items_changed, enum_files_total, enum_files_done FROM maintenance_jobs WHERE id = $1",
    [verifyJobRow.rows[0].id]
  );

  assert.equal(verifyJob.rows[0].status, "COMPLETE");
  assert.equal(verifyJob.rows[0].files_total, TOTAL_COUNT, "urls_total = deduped population");
  assert.equal(verifyJob.rows[0].files_done, TOTAL_COUNT);
  assert.equal(Number(verifyJob.rows[0].items_changed), PROBLEM_COUNT, "items_changed = problem URLs");
  // PHASE-2 NON-REGRESSION (v1.53): the URL counters above are untouched by the
  // new enumeration reporting, and the enum_* columns are cleared once the URL
  // phase starts — so a poll can never see both phases active and render file
  // progress for the rest of the run.
  assert.equal(
    verifyJob.rows[0].enum_files_total,
    null,
    "enum_files_total must be cleared when enumeration completes"
  );
  assert.equal(verifyJob.rows[0].enum_files_done, null);

  const verifiedCount = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM verified_urls WHERE session_id = $1",
    [sessionId]
  );

  assert.equal(Number(verifiedCount.rows[0].count), TOTAL_COUNT, "one row per deduped URL");

  const countsByStatus = await pool.query<{ http_status: number; count: string }>(
    `
      SELECT http_status, COUNT(*)::text AS count
      FROM verified_urls
      WHERE session_id = $1
      GROUP BY http_status
      ORDER BY http_status
    `,
    [sessionId]
  );

  assert.deepEqual(
    countsByStatus.rows.map((row) => [row.http_status, Number(row.count)]),
    [
      [200, OK_COUNT],
      [308, REDIRECT_COUNT],
      [404, NOT_FOUND_COUNT]
    ],
    "counts by status match the fixture script exactly"
  );

  const decoy = await pool.query(
    "SELECT 1 FROM verified_urls WHERE session_id = $1 AND url = $2",
    [sessionId, `${baseUrl}/about`]
  );

  assert.equal(decoy.rowCount, 0, "non-matching loc stays out of the population");

  const dupSourceFiles = await pool.query<{ source_files: string[] }>(
    "SELECT source_files FROM verified_urls WHERE session_id = $1 AND url = $2",
    [sessionId, okUrls[0]]
  );

  assert.equal(
    dupSourceFiles.rows[0].source_files.length,
    2,
    "a URL present in two files records both source files"
  );

  // ---- act 2: delete every verified problem URL ----------------------------
  const fileDisplaysResult = await pool.query<{ display: string }>(
    `
      SELECT DISTINCT unnest(source_files) AS display
      FROM verified_urls
      WHERE session_id = $1
        AND is_deleted_from_sitemap = false
        AND http_status = ANY($2::int[])
    `,
    [sessionId, [301, 302, 307, 308, 404]]
  );
  const fileDisplays = fileDisplaysResult.rows.map((row) => row.display);

  const deleteJobRow = await pool.query<{ id: string }>(
    "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'delete-problem-urls') RETURNING id",
    [sessionId]
  );

  await processDeleteProblemUrlsJob(
    {
      session_id: sessionId,
      job_row_id: deleteJobRow.rows[0].id,
      file_displays: fileDisplays,
      statuses: [301, 302, 307, 308, 404],
      use_verified: true
    },
    silentLogger
  );

  const deleteJob = await pool.query<{ status: string; items_changed: string }>(
    "SELECT status, items_changed FROM maintenance_jobs WHERE id = $1",
    [deleteJobRow.rows[0].id]
  );

  assert.equal(deleteJob.rows[0].status, "COMPLETE");
  assert.equal(
    Number(deleteJob.rows[0].items_changed),
    PROBLEM_COUNT,
    "items ledger: exactly the 269 problem <url> blocks were removed"
  );

  const collectLocs = async () => {
    const files = await pool.query<{ filename: string }>(
      "SELECT filename FROM sitemap_files WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false",
      [sessionId]
    );
    const locs: string[] = [];

    for (const row of files.rows) {
      await streamSitemapUrlLocs(row.filename, (loc) => {
        locs.push(loc);
      });
    }

    return locs;
  };

  const afterDeleteLocs = await collectLocs();
  const afterDeleteSet = new Set(afterDeleteLocs);

  for (const url of problemUrls) {
    assert.equal(afterDeleteSet.has(url), false, `problem URL still present: ${url}`);
  }

  // THE COLLATERAL ASSERTION: every one of the 91 healthy URLs is still present
  // as its exact <loc> string (ok-0 appears twice — once per file it lives in).
  for (const url of okUrls) {
    assert.equal(afterDeleteSet.has(url), true, `healthy URL went missing: ${url}`);
  }
  assert.equal(afterDeleteSet.has(`${baseUrl}/about`), true, "decoy loc untouched");
  assert.equal(
    afterDeleteLocs.length,
    OK_COUNT + 2, // 91 + duplicated ok-0 + decoy
    "rewritten files contain exactly the healthy locs"
  );

  const markedDeleted = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM verified_urls WHERE session_id = $1 AND is_deleted_from_sitemap = true",
    [sessionId]
  );

  assert.equal(Number(markedDeleted.rows[0].count), PROBLEM_COUNT);

  // ---- act 3: restore brings all 360 back -----------------------------------
  const restoreJobRow = await pool.query<{ id: string }>(
    "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'restore-deleted-urls') RETURNING id",
    [sessionId]
  );

  await processRestoreDeletedUrlsJob(
    { session_id: sessionId, job_row_id: restoreJobRow.rows[0].id },
    silentLogger
  );

  const afterRestoreLocs = await collectLocs();
  const afterRestoreSet = new Set(afterRestoreLocs);

  for (const url of allUrls) {
    assert.equal(afterRestoreSet.has(url), true, `URL not restored: ${url}`);
  }
  assert.equal(
    afterRestoreLocs.length,
    TOTAL_COUNT + 2, // 360 + duplicated ok-0 + decoy
    "restore rebuilt every file to its original content"
  );

  const stillMarked = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM verified_urls WHERE session_id = $1 AND is_deleted_from_sitemap = true",
    [sessionId]
  );

  assert.equal(Number(stillMarked.rows[0].count), 0, "restore cleared verified marks");
});
