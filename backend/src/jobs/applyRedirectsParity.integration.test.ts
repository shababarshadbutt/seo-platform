import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// THE TWO APPLY PATHS MUST PRODUCE THE SAME BYTES.
//
// apply-redirects runs inline in the route for a narrow pattern and as a queued
// job for a wide one. Which one you get is decided by file count, and it is
// supposed to be an implementation detail — the same request over the same data
// must rewrite the same <loc> entries either way.
//
// It did not. Only the route was kept current, so the job never gained
// verified_urls destinations (v1.68), per-shape rules (v1.69), or the widen flag
// (v1.73). The gap stayed hidden because the queue was hard to reach — a pattern
// had to span more than 200 files AND the caller had to send a rule, inferred
// URLs or widen. v1.77 changed routing to file count alone with a default of 25,
// the blind path became the normal one, and an apply on a 187-file pattern with
// 579,034 confirmed URLs rewrote the ten files its sampled rows happened to live
// in. The dialog said 579,034; ten files changed.
//
// v1.75 had already fixed this exact shape of bug for WHICH FILES an apply opens
// and left a note about it — "one decision, shared by both paths". Nobody noticed
// that WHICH REPLACEMENTS an apply uses had the same problem, because nothing
// compared the two paths. This is that comparison.
//
// The fixture is built so a blind path CANNOT pass: most of the confirmed
// destinations live only in verified_urls, and a whole family of URLs is reachable
// only through an agreed per-shape rule. Reading sampled_urls alone rewrites a
// small fraction, which is precisely the reported failure.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "apply-parity-itest-"));

process.env.UPLOAD_DIR = uploadDir;

const BASE = "https://example.com";
const TEMPLATE = "/product/{param}/{param}";

// Enough files that the real deployment would queue this (threshold 25), and
// enough URLs per file that a partial rewrite is obvious rather than arguable.
const FILE_COUNT = 30;
const URLS_PER_FILE = 20;
const TOTAL_URLS = FILE_COUNT * URLS_PER_FILE;

// Only the first two URLs of the first file are "sampled". Everything else is
// confirmed in verified_urls or reachable only by the shape rule — so a path that
// reads sampled_urls alone can rewrite at most these two.
const SAMPLED_PER_RUN = 2;

type BuiltFile = { stored: string; display: string; xml: string; urls: string[] };

function urlFor(seq: number) {
  // Two shapes: even sequences get a numeric part code, odd ones a lettered one.
  // valueShape() reads them as different shapes, which is what lets one agreed
  // shape rule cover exactly half the population and prove shape rules are read.
  return seq % 2 === 0
    ? `${BASE}/product/catalog/part-${seq}`
    : `${BASE}/product/catalog/item-a${seq}`;
}

function destinationFor(url: string) {
  return url.replace("/product/catalog/", "/catalog/product/");
}

function buildFiles(sessionId: string): BuiltFile[] {
  const files: BuiltFile[] = [];

  for (let fileIndex = 0; fileIndex < FILE_COUNT; fileIndex += 1) {
    const locs: string[] = [];
    const urls: string[] = [];

    for (let i = 0; i < URLS_PER_FILE; i += 1) {
      const url = urlFor(fileIndex * URLS_PER_FILE + i);

      urls.push(url);
      locs.push(`  <url><loc>${url}</loc></url>`);
    }

    const display = `part-${fileIndex}.xml`;

    files.push({
      stored: `${sessionId}-current-${display}`,
      display,
      xml:
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        locs.join("\n") +
        "\n</urlset>\n",
      urls
    });
  }

  return files;
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

test("the inline route and the queued job rewrite identical bytes", async (t) => {
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

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processApplyRedirectsJob } = await import("./applyRedirectsJob.js");
  const { destroyFileRewritePool } = await import("./fileRewritePool.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { sessionRoutes } = await import("../routes/sessions.js");
  const Fastify = (await import("fastify")).default;

  const sessionIds: string[] = [];

  t.after(async () => {
    for (const id of sessionIds) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [id])
        .catch(() => {});
    }

    await destroyFileRewritePool().catch(() => {});
    await closePreGenerateZipQueue().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);

  // One fixture builder, used twice — the two runs must differ ONLY in which
  // code path performs the apply.
  async function seed(name: string) {
    const sessionRow = await pool.query<{ id: string }>(
      `
        INSERT INTO sessions (name, base_url, sample_size, concurrency)
        VALUES ($1, $2, 5, 10)
        RETURNING id
      `,
      [name, BASE]
    );
    const sessionId = sessionRow.rows[0].id;

    sessionIds.push(sessionId);

    const patternRow = await pool.query<{ id: string }>(
      `
        INSERT INTO patterns (session_id, template, total_urls)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [sessionId, TEMPLATE, TOTAL_URLS]
    );
    const patternId = patternRow.rows[0].id;
    const files = buildFiles(sessionId);

    for (const file of files) {
      writeFileSync(path.join(uploadDir, file.stored), file.xml, "utf8");
      await pool.query(
        `
          INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
          VALUES ($1, $2, $3, now(), true, false)
        `,
        [sessionId, file.stored, URLS_PER_FILE]
      );
      // The file scope both paths use comes from here. Without these rows an
      // apply falls back to "every file of the role", which would hide a scope
      // bug rather than expose one.
      await pool.query(
        `
          INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrences)
          VALUES ($1, $2, $3)
        `,
        [patternId, file.display, URLS_PER_FILE]
      );
    }

    // A HANDFUL of sampled confirmed redirects — this is all a blind path can
    // see, and it is deliberately a tiny share of the population.
    for (let i = 0; i < SAMPLED_PER_RUN; i += 1) {
      const url = files[0].urls[i];

      await pool.query(
        `
          INSERT INTO sampled_urls
            (pattern_id, url, final_url, http_status, http_status_category, is_hit, source_file)
          VALUES ($1, $2, $3, 301, 'redirect', false, $4)
        `,
        [patternId, url, destinationFor(url), files[0].display]
      );
    }

    // THE FULL VERIFIED POPULATION for the EVEN shape: one row per URL with its
    // own fetched destination. This is what "Verify all in this pattern" writes
    // and what the queued job could not see.
    for (const file of files) {
      for (const url of file.urls) {
        if (!url.includes("/part-")) {
          continue;
        }

        await pool.query(
          `
            INSERT INTO verified_urls
              (session_id, pattern_id, url, http_status, http_status_category, final_url, source_files)
            VALUES ($1, $2, $3, 301, 'redirect', $4, $5)
            ON CONFLICT (session_id, url) DO NOTHING
          `,
          [sessionId, patternId, url, destinationFor(url), [file.display]]
        );
      }
    }

    return { sessionId, patternId, files };
  }

  // Bytes of every file after an apply, keyed by display name, so the two runs
  // can be compared without their differing session-id prefixes getting in the
  // way.
  async function resultBytes(
    sessionId: string,
    files: BuiltFile[]
  ): Promise<Map<string, string>> {
    const rows = await pool.query<{ filename: string; fixed_file_path: string | null }>(
      "SELECT filename, fixed_file_path FROM sitemap_files WHERE session_id = $1",
      [sessionId]
    );
    const byDisplay = new Map<string, string>();

    for (const file of files) {
      const row = rows.rows.find(
        (candidate) =>
          candidate.filename === file.stored ||
          candidate.filename.endsWith(file.display)
      );

      assert.ok(row, `no sitemap_files row survived for ${file.display}`);

      const onDisk = row.fixed_file_path ?? path.join(uploadDir, row.filename);

      byDisplay.set(
        file.display,
        readFileSync(onDisk, "utf8").replace(new RegExp(sessionId, "g"), "SID")
      );
    }

    return byDisplay;
  }

  // ---- run 1: the queued job ------------------------------------------------
  const viaJob = await seed("apply parity — job");

  await processApplyRedirectsJob(
    {
      session_id: viaJob.sessionId,
      pattern_id: viaJob.patternId,
      url_ids: null,
      inferred_urls: [],
      structure_filters: null,
      approved_rules: null,
      exclude_urls: null,
      widen: true
    },
    silentLogger
  );

  const jobBytes = await resultBytes(viaJob.sessionId, viaJob.files);

  // ---- run 2: the inline route ----------------------------------------------
  const viaRoute = await seed("apply parity — route");
  const app = Fastify({ logger: false });

  await app.register(sessionRoutes);
  t.after(async () => {
    await app.close().catch(() => {});
  });

  // Forced inline: the threshold is read at module load, so the route decides by
  // file span. 30 files is over the default 25, which is exactly why this test
  // has to pin the path rather than hope for it.
  process.env.FILE_REWRITE_PARALLEL_THRESHOLD = "1000";

  const response = await app.inject({
    method: "POST",
    url: `/api/sessions/${viaRoute.sessionId}/patterns/${viaRoute.patternId}/apply-redirects`,
    payload: { widen: true }
  });

  assert.equal(response.statusCode, 200, response.body);

  const body = JSON.parse(response.body);

  assert.notEqual(
    body.queued,
    true,
    "the route was supposed to run this inline — raise the threshold"
  );

  const routeBytes = await resultBytes(viaRoute.sessionId, viaRoute.files);

  // ---- the assertions that matter -------------------------------------------
  //
  // 1. Neither path may stop at the sampled rows. The population is 600 URLs, of
  //    which 300 have a verified destination and only 2 are sampled — so a blind
  //    path lands on 2 and a correct one on 300. Asserted as a floor rather than
  //    an exact count so the test survives a future path that reaches MORE.
  const changedInJob = [...jobBytes.values()].filter((xml) =>
    xml.includes("/catalog/product/")
  ).length;

  assert.ok(
    changedInJob > 2,
    `the queued job rewrote only ${changedInJob} files — it is reading sampled_urls alone again`
  );

  // 2. And they must agree exactly. This is the guard: any capability added to
  //    one path and not the other shows up here as a byte difference.
  for (const [display, xml] of routeBytes) {
    assert.equal(
      jobBytes.get(display),
      xml,
      `${display} differs between the inline route and the queued job — the two paths have drifted again`
    );
  }

  assert.equal(
    jobBytes.size,
    routeBytes.size,
    "the two paths touched a different number of files"
  );
});
