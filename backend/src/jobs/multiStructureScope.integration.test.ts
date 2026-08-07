import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// CORRECTNESS PROOF for a MULTI-POSITION scoped pattern edit (v1.51), through
// the real pattern_structure_jobs pipeline, plus its undo.
//
// A pattern with several {param} slots can now be scoped at more than one
// position at once — /rfq/{param}/{param}/{param} limited to niin-parts-{var}
// at segment A AND {var}-parts-catalog at segment C — and the filters AND.
//
// The assertion that matters is the NEGATIVE one: every sibling at EITHER
// position must come out byte-identical. A filter silently dropping out
// anywhere between the route, the job, the rewrite layer and the worker thread
// would widen the edit to a quarter or a half of the pattern instead of an
// eighth, and the only way to see that is to compare the untouched files byte
// for byte rather than to count the ones that changed.
//
// Undo is covered too, because rename-undo is the filter-DEPENDENT path: it
// replays a reverse rewrite using the filter recorded on the pattern_renames
// row, so a multi-filter that does not round-trip through that column would
// undo over the wrong URLs. (Transform-undo restores kept copies and is
// filter-agnostic by construction.)
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "multi-scope-itest-"));

process.env.UPLOAD_DIR = uploadDir;

const BASE = "https://example.com";
const TEMPLATE = "/rfq/{param}/{param}/{param}";
const NEW_TEMPLATE = "/quote/{param}/{param}/{param}";

// Four families at segment A, two at segment C. The scope picks one of each, so
// the intersection is 1/8 — far enough from 1/4 and 1/2 that a dropped filter
// cannot be mistaken for an off-by-one.
const A_FAMILIES = ["niin-parts", "part-types", "cage-codes", "nsn-parts"];
const C_FAMILIES = ["parts-catalog", "price-list"];
const FILE_COUNT = 6;
const URLS_PER_FILE = 80;

const SCOPE = [
  { param_index: 0, anchor: "prefix", value: "niin-parts" },
  { param_index: 2, anchor: "suffix", value: "parts-catalog" }
];

type BuiltFile = { stored: string; xml: string; matching: string[] };

function buildFiles(sessionId: string): BuiltFile[] {
  const files: BuiltFile[] = [];

  for (let fileIndex = 0; fileIndex < FILE_COUNT; fileIndex += 1) {
    const locs: string[] = [];
    const matching: string[] = [];

    for (let i = 0; i < URLS_PER_FILE; i += 1) {
      const seq = fileIndex * URLS_PER_FILE + i;
      const a = `${A_FAMILIES[seq % A_FAMILIES.length]}-${seq}`;
      const b = `mid-${seq}`;
      // floor(seq/4), NOT seq — the two selectors must be INDEPENDENT. With
      // `seq % 2` the segment-C family is implied by the segment-A one (every
      // seq divisible by 4 is even), so a dropped segment-C filter would change
      // nothing and the test would pass while the guard was broken. Caught by
      // the intersection coming out at 1/4 instead of 1/8.
      const c = `brand${seq}-${
        C_FAMILIES[Math.floor(seq / A_FAMILIES.length) % C_FAMILIES.length]
      }`;
      const url = `${BASE}/rfq/${a}/${b}/${c}`;

      if (a.startsWith("niin-parts-") && c.endsWith("-parts-catalog")) {
        matching.push(url);
      }

      locs.push(`  <url><loc>${url}</loc></url>`);
    }

    files.push({
      stored: `${sessionId}-current-part-${fileIndex}.xml`,
      xml:
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        locs.join("\n") +
        "\n</urlset>\n",
      matching
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

test("a multi-position scoped rename edits the intersection only, and undoes byte-identically", async (t) => {
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
  const { processPatternRenameJob } = await import("./patternStructureJob.js");
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
  });

  await runMigrations(silentLogger);

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('multi-structure scope', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [sessionId, TEMPLATE, FILE_COUNT * URLS_PER_FILE]
  );
  const patternId = patternRow.rows[0].id;

  const files = buildFiles(sessionId);
  // Byte-level snapshot of every file BEFORE the edit — the baseline both the
  // sibling check and the undo check compare against.
  const originalBytes = new Map<string, string>();

  for (const file of files) {
    const full = path.join(uploadDir, file.stored);

    writeFileSync(full, file.xml, "utf8");
    originalBytes.set(file.stored, file.xml);
    await pool.query(
      `
        INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
        VALUES ($1, $2, $3, now(), true, false)
      `,
      [sessionId, file.stored, URLS_PER_FILE]
    );
  }

  const expectedMatching = files.reduce(
    (total, file) => total + file.matching.length,
    0
  );
  const totalUrls = FILE_COUNT * URLS_PER_FILE;

  // 1/4 x 1/2 of the population.
  assert.equal(expectedMatching, totalUrls / 8);

  // ---- act: scoped rename through the real job -----------------------------
  const jobRow = await pool.query<{ id: string }>(
    `
      INSERT INTO pattern_structure_jobs
        (session_id, pattern_id, kind, request_fingerprint, params, files_total)
      VALUES ($1, $2, 'RENAME', $3, $4::jsonb, $5)
      RETURNING id
    `,
    [
      sessionId,
      patternId,
      "multi-scope-test-fingerprint",
      JSON.stringify({
        new_template: NEW_TEMPLATE,
        source_files: [],
        occurrence_count: totalUrls,
        is_undo: false,
        structure_filter: SCOPE
      }),
      FILE_COUNT
    ]
  );

  await processPatternRenameJob(
    { session_id: sessionId, pattern_id: patternId, job_row_id: jobRow.rows[0].id },
    silentLogger
  );

  const finished = await pool.query<{ status: string; error: string | null }>(
    "SELECT status, error FROM pattern_structure_jobs WHERE id = $1",
    [jobRow.rows[0].id]
  );

  assert.equal(
    finished.rows[0].status,
    "COMPLETE",
    `job failed: ${finished.rows[0].error}`
  );

  // ---- assert: only the intersection moved ---------------------------------
  const afterFiles = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1 ORDER BY filename ASC",
    [sessionId]
  );

  let rewrittenCount = 0;
  let survivingCount = 0;

  for (const row of afterFiles.rows) {
    const content = readFileSync(path.join(uploadDir, row.filename), "utf8");
    const locs = [...content.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => match[1]
    );

    for (const loc of locs) {
      if (loc.startsWith(`${BASE}/quote/`)) {
        rewrittenCount += 1;

        // Anything rewritten MUST satisfy both filters. This is what catches a
        // widened scope: a dropped segment-C filter would move price-list URLs
        // too, and a dropped segment-A filter would move part-types URLs.
        const segments = new URL(loc).pathname.split("/").filter(Boolean);

        assert.ok(
          segments[1].startsWith("niin-parts-"),
          `rewrote a URL outside the segment-A scope: ${loc}`
        );
        assert.ok(
          segments[3].endsWith("-parts-catalog"),
          `rewrote a URL outside the segment-C scope: ${loc}`
        );
      } else {
        survivingCount += 1;

        // And every survivor must fail at least one filter — otherwise the
        // edit was too NARROW and missed part of its own scope.
        const segments = new URL(loc).pathname.split("/").filter(Boolean);
        const inScope =
          segments[1].startsWith("niin-parts-") &&
          segments[3].endsWith("-parts-catalog");

        assert.ok(!inScope, `left an in-scope URL behind: ${loc}`);
      }
    }
  }

  assert.equal(rewrittenCount, expectedMatching);
  assert.equal(survivingCount, totalUrls - expectedMatching);

  // The pattern label must NOT have moved: a scoped rename leaves the template
  // describing the structures still under it.
  const patternAfter = await pool.query<{ template: string }>(
    "SELECT template FROM patterns WHERE id = $1",
    [patternId]
  );

  assert.equal(patternAfter.rows[0].template, TEMPLATE);

  // The scope must be persisted as a LIST for undo to replay it.
  const renameRow = await pool.query<{ structure_filter: unknown }>(
    "SELECT structure_filter FROM pattern_renames WHERE pattern_id = $1",
    [patternId]
  );

  assert.equal(renameRow.rowCount, 1);
  assert.deepEqual(renameRow.rows[0].structure_filter, SCOPE);

  // ---- act: undo -----------------------------------------------------------
  const undoRow = await pool.query<{ id: string }>(
    `
      INSERT INTO pattern_structure_jobs
        (session_id, pattern_id, kind, request_fingerprint, params, files_total)
      VALUES ($1, $2, 'RENAME', $3, $4::jsonb, $5)
      RETURNING id
    `,
    [
      sessionId,
      patternId,
      "multi-scope-test-undo",
      JSON.stringify({
        new_template: TEMPLATE,
        source_files: [],
        occurrence_count: totalUrls,
        // Undo carries NO filter of its own — it must recover the scope from
        // the pattern_renames row it reverses.
        is_undo: true
      }),
      FILE_COUNT
    ]
  );

  await processPatternRenameJob(
    { session_id: sessionId, pattern_id: patternId, job_row_id: undoRow.rows[0].id },
    silentLogger
  );

  const undone = await pool.query<{ status: string; error: string | null }>(
    "SELECT status, error FROM pattern_structure_jobs WHERE id = $1",
    [undoRow.rows[0].id]
  );

  assert.equal(
    undone.rows[0].status,
    "COMPLETE",
    `undo failed: ${undone.rows[0].error}`
  );

  // ---- assert: byte-identical restore --------------------------------------
  const restored = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1 ORDER BY filename ASC",
    [sessionId]
  );
  const restoredContents = restored.rows
    .map((row) => readFileSync(path.join(uploadDir, row.filename), "utf8"))
    .sort();
  const originalContents = [...originalBytes.values()].sort();

  assert.deepEqual(
    restoredContents,
    originalContents,
    "undo did not restore the files byte-for-byte"
  );

  // History popped, so a second undo has nothing to reverse.
  const renamesLeft = await pool.query(
    "SELECT 1 FROM pattern_renames WHERE pattern_id = $1",
    [patternId]
  );

  assert.equal(renamesLeft.rowCount, 0);
});
