import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// THE CLAIM THIS TEST EXISTS TO PROVE: the dry run's numbers describe the apply.
//
// The dry run is what gates a transform over a population the ~1,000-URL preview
// pool cannot see. That is only worth anything if "6,584,210 URLs would change"
// is the same 6,584,210 the apply actually changes. The two run through
// different code paths — the dry run streams read-only through
// TransformDryRun.observe, the apply streams through rewriteSitemapLocFile and a
// piscina worker — so agreement is a property to CHECK, not to assume.
//
// It also pins the other half of the promise: building a sample file leaves the
// session byte-identical. A "safe preview" that quietly edited the user's data
// would be the worst possible bug in this feature, so the assertion is over the
// bytes of every file, not over a status code.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "dry-run-itest-"));
const exportDir = mkdtempSync(path.join(os.tmpdir(), "dry-run-itest-exp-"));

process.env.UPLOAD_DIR = uploadDir;
process.env.EXPORT_DIR = exportDir;

const BASE = "https://example.com";
const TEMPLATE = "/nspart/{param}";
const CURRENT_STRUCTURE = "/nspart/{A}/";
const NEW_STRUCTURE = "/nsnpart/{A|split|6|-|}/";

const FILE_COUNT = 6;
const URLS_PER_FILE = 40;

// A quarter of each file is deliberately OUTSIDE the pattern, so "everything
// matched" and "the right things matched" cannot be confused.
function buildFile(sessionId: string, fileIndex: number) {
  const matching: string[] = [];
  const foreign: string[] = [];

  for (let index = 0; index < URLS_PER_FILE; index += 1) {
    if (index % 4 === 3) {
      foreign.push(`${BASE}/other/thing-${fileIndex}-${index}/`);
      continue;
    }

    matching.push(`${BASE}/nspart/part-${700 + fileIndex * 100 + index}/`);
  }

  const all = [...matching, ...foreign];
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
    all.map((url) => `  <url><loc>${url}</loc></url>`).join("\n") +
    "\n</urlset>\n";

  return {
    display: `sitemap-${fileIndex}.xml`,
    stored: `${sessionId}-sitemap-${fileIndex}.xml`,
    xml,
    matching
  };
}

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

test("the dry run measures exactly what the apply then rewrites", async (t) => {
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

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const {
    processPatternTransformJob,
    processPatternTransformDryRunJob
  } = await import("./patternStructureJob.js");
  const { buildTransformSampleFile } = await import(
    "../sitemaps/transformSampleFile.js"
  );
  const { parseStructure, transformUrl } = await import(
    "../sitemaps/transformStructure.js"
  );
  const { destroyFileRewritePool } = await import("./fileRewritePool.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );

  let sessionId: string | null = null;

  t.after(async () => {
    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await destroyFileRewritePool().catch(() => {});
    await closePreGenerateZipQueue().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('transform dry run', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const totalUrls = FILE_COUNT * URLS_PER_FILE;
  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [sessionId, TEMPLATE, totalUrls]
  );
  const patternId = patternRow.rows[0].id;

  const files = Array.from({ length: FILE_COUNT }, (_, index) =>
    buildFile(sessionId as string, index)
  );
  const originalBytes = new Map<string, string>();
  let expectedMatching = 0;

  for (const file of files) {
    writeFileSync(path.join(uploadDir, file.stored), file.xml, "utf8");
    originalBytes.set(file.stored, file.xml);
    expectedMatching += file.matching.length;

    await pool.query(
      `
        INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
        VALUES ($1, $2, $3, now(), true, false)
      `,
      [sessionId, file.stored, URLS_PER_FILE]
    );
    await pool.query(
      `
        INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count)
        VALUES ($1, $2, $3)
      `,
      [patternId, file.display, file.matching.length]
    );
  }

  // ---- 1. the dry run ------------------------------------------------------
  const dryRunJob = await pool.query<{ id: string }>(
    `
      INSERT INTO pattern_structure_jobs
        (session_id, pattern_id, kind, request_fingerprint, params, files_total)
      VALUES ($1, $2, 'TRANSFORM_DRY_RUN', $3, $4::jsonb, $5)
      RETURNING id
    `,
    [
      sessionId,
      patternId,
      "dry-run-test-fingerprint",
      JSON.stringify({
        current_structure: CURRENT_STRUCTURE,
        new_structure: NEW_STRUCTURE,
        source_files: [],
        structure_filter: []
      }),
      FILE_COUNT
    ]
  );

  await processPatternTransformDryRunJob(
    {
      session_id: sessionId,
      pattern_id: patternId,
      job_row_id: dryRunJob.rows[0].id
    },
    silentLogger
  );

  const dryRunRow = await pool.query<{
    status: string;
    error: string | null;
    result: {
      matched: number;
      rewritten: number;
      skipped: number;
      total_locs: number;
      files_scanned: number;
      shapes: Array<{ shape: string; count: number }>;
    };
  }>(
    "SELECT status, error, result FROM pattern_structure_jobs WHERE id = $1",
    [dryRunJob.rows[0].id]
  );

  assert.equal(
    dryRunRow.rows[0].status,
    "COMPLETE",
    `dry run failed: ${dryRunRow.rows[0].error}`
  );

  const measured = dryRunRow.rows[0].result;

  assert.equal(measured.total_locs, totalUrls);
  assert.equal(measured.matched, expectedMatching);
  assert.equal(measured.rewritten, expectedMatching);
  assert.equal(measured.files_scanned, FILE_COUNT);
  assert.ok(measured.shapes.length > 0);

  // The dry run WROTE NOTHING. Checked before the apply runs, while the files
  // are still supposed to be pristine.
  for (const file of files) {
    assert.equal(
      readFileSync(path.join(uploadDir, file.stored), "utf8"),
      originalBytes.get(file.stored),
      `${file.stored} was modified by the dry run`
    );
  }

  // ---- 2. the sample file --------------------------------------------------
  const current = parseStructure(CURRENT_STRUCTURE);
  const next = parseStructure(NEW_STRUCTURE);
  const sample = await buildTransformSampleFile({
    sessionId,
    inputPath: path.join(uploadDir, files[0].stored),
    isGzip: false,
    rewriteUrl: (url: string) => transformUrl(url, current, next)
  });

  assert.equal(sample.rewritten, files[0].matching.length);
  assert.equal(sample.samples.length, 10);

  // It landed in EXPORT_DIR and NOT in the session's upload directory.
  assert.ok(readdirSync(exportDir).includes(sample.storedName));
  assert.ok(
    !readdirSync(uploadDir).includes(sample.storedName),
    "a sample must never be written into the session's upload directory"
  );

  for (const file of files) {
    assert.equal(
      readFileSync(path.join(uploadDir, file.stored), "utf8"),
      originalBytes.get(file.stored),
      `${file.stored} was modified by building a sample`
    );
  }

  // ---- 3. the apply, and the agreement -------------------------------------
  const applyJob = await pool.query<{ id: string }>(
    `
      INSERT INTO pattern_structure_jobs
        (session_id, pattern_id, kind, request_fingerprint, params, files_total)
      VALUES ($1, $2, 'TRANSFORM', $3, $4::jsonb, $5)
      RETURNING id
    `,
    [
      sessionId,
      patternId,
      "apply-test-fingerprint",
      JSON.stringify({
        current_structure: CURRENT_STRUCTURE,
        new_structure: NEW_STRUCTURE,
        new_template: TEMPLATE,
        source_files: files.map((file) => file.display),
        structure_filter: []
      }),
      FILE_COUNT
    ]
  );

  await processPatternTransformJob(
    {
      session_id: sessionId,
      pattern_id: patternId,
      job_row_id: applyJob.rows[0].id
    },
    silentLogger
  );

  const applyRow = await pool.query<{
    status: string;
    error: string | null;
    urls_rewritten: string;
  }>(
    "SELECT status, error, urls_rewritten FROM pattern_structure_jobs WHERE id = $1",
    [applyJob.rows[0].id]
  );

  assert.equal(
    applyRow.rows[0].status,
    "COMPLETE",
    `apply failed: ${applyRow.rows[0].error}`
  );

  // THE ASSERTION THIS FILE IS FOR.
  assert.equal(
    Number(applyRow.rows[0].urls_rewritten),
    measured.rewritten,
    "the dry run predicted a different number of rewrites than the apply performed"
  );

  // And the prediction was right about the CONTENT too, not only the count.
  const afterFiles = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1 ORDER BY filename ASC",
    [sessionId]
  );

  let actuallyRewritten = 0;

  for (const row of afterFiles.rows) {
    const content = readFileSync(path.join(uploadDir, row.filename), "utf8");

    for (const match of content.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      if (match[1].startsWith(`${BASE}/nsnpart/`)) {
        actuallyRewritten += 1;
      }
    }
  }

  assert.equal(actuallyRewritten, measured.rewritten);
});
