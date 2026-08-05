// Can a crash mid-copy leave a TRUNCATED file at its real path that a later resume
// mistakes for a complete one?
//
// Reproduces the reachable path exactly, not an approximation:
//   1. ingest normally      -> row committed + complete file
//   2. delete the FILE only -> the state the resume deliberately re-copies
//   3. re-ingest, killed mid-copy
//   4. inspect: is there a partial file at the REAL path while the row exists?
//   5. resume again: is that file skipped (corruption kept) or re-copied?
//
// Step 5 is the one that differs before and after the atomic-rename fix: a partial
// file at the real path plus a committed row satisfies the skip test, so the short
// sitemap is never repaired.
//
// Usage (phases are separate processes so the kill is a real process death):
//   npx tsx bench/ingestPartialCopy.ts setup   <sizeMB> <fileCount>
//   npx tsx bench/ingestPartialCopy.ts crash   <killAfterMs>
//   npx tsx bench/ingestPartialCopy.ts inspect
//   npx tsx bench/ingestPartialCopy.ts resume
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { ingestFilesIntoSession } from "../src/sitemaps/batchIngest.js";
import { buildStoredUploadFilename } from "../src/sitemaps/filenames.js";

const MODE = process.argv[2];
const STATE = path.join(config.uploadDir, "partial-copy-state.json");
const CORPUS = path.join(config.uploadDir, "partial-copy-src");

const log = (m: string) => process.stdout.write(`${m}\n`);

type State = { sessionId: string; files: { path: string; filename: string }[] };

async function readState(): Promise<State> {
  const { readFile } = await import("node:fs/promises");

  return JSON.parse(await readFile(STATE, "utf8")) as State;
}

// Big files on purpose: the copy has to last long enough to be interrupted.
async function setup() {
  const sizeMB = Number(process.argv[3] ?? 200);
  const count = Number(process.argv[4] ?? 2);

  await rm(CORPUS, { recursive: true, force: true });
  await mkdir(CORPUS, { recursive: true });

  const filler = "x".repeat(1024 * 1024);
  const files: State["files"] = [];

  for (let i = 0; i < count; i += 1) {
    const filename = `partial-${i}.xml`;
    const full = path.join(CORPUS, filename);
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
      `  <url><loc>https://partial.example.com/p/${i}</loc></url>\n`
    ];

    for (let m = 0; m < sizeMB; m += 1) parts.push(`<!--${filler}-->\n`);

    parts.push("</urlset>\n");
    await writeFile(full, parts.join(""), "utf8");
    files.push({ path: full, filename });
  }

  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (name, base_url, sample_size, status, upload_complete)
     VALUES ($1, 'https://partial.example.com', 5, 'PENDING', false) RETURNING id`,
    [`partial-copy-${Date.now()}`]
  );
  const sessionId = session.rows[0].id;

  // Step 1: a normal, complete ingest.
  const first = await ingestFilesIntoSession({ sessionId, files });
  log(`setup: ingested ${first.filter((o) => o.ok).length}/${files.length}`);

  // Step 2: delete the FILES but keep the rows — the resume's re-copy case.
  for (const f of files) {
    const stored = buildStoredUploadFilename(sessionId, f.filename, "current");
    await unlink(path.join(config.uploadDir, stored)).catch(() => undefined);
  }
  log("setup: deleted the stored files, rows kept -> re-copy state");

  await writeFile(STATE, JSON.stringify({ sessionId, files }), "utf8");
  log(`setup: session=${sessionId}`);
  await pool.end();
}

// Step 3: start the re-ingest and die mid-copy.
async function crash() {
  const killAfterMs = Number(process.argv[3] ?? 400);
  const { sessionId, files } = await readState();

  log(`crash: re-ingesting, will hard-exit after ${killAfterMs}ms`);
  void ingestFilesIntoSession({ sessionId, files }).catch(() => undefined);

  setTimeout(() => {
    log("crash: exiting mid-copy NOW (no cleanup, no rollback)");
    process.exit(137);
  }, killAfterMs);
}

async function inspect() {
  const { sessionId, files } = await readState();
  const rows = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const haveRow = new Set(rows.rows.map((r) => r.filename));
  const entries = await readdir(config.uploadDir);
  const report: unknown[] = [];
  let partialAtRealPath = 0;
  let tempsLeft = 0;

  for (const e of entries) {
    if (e.startsWith(`${sessionId}-`) && e.endsWith(".part")) tempsLeft += 1;
  }

  for (const f of files) {
    const stored = buildStoredUploadFilename(sessionId, f.filename, "current");
    const dest = path.join(config.uploadDir, stored);
    const srcSize = (await stat(f.path)).size;
    let destSize: number | null = null;

    try {
      destSize = (await stat(dest)).size;
    } catch {
      destSize = null;
    }

    const partial = destSize !== null && destSize !== srcSize;

    if (partial) partialAtRealPath += 1;

    report.push({
      file: f.filename,
      row_exists: haveRow.has(stored),
      real_path_present: destSize !== null,
      src_bytes: srcSize,
      real_path_bytes: destSize,
      TRUNCATED_AT_REAL_PATH: partial
    });
  }

  log(
    JSON.stringify(
      { partial_at_real_path: partialAtRealPath, leftover_part_temps: tempsLeft, files: report },
      null,
      2
    )
  );
  await pool.end();
}

// Step 5: the resume. Does it repair the file or skip it?
async function resume() {
  const { sessionId, files } = await readState();
  const outcomes = await ingestFilesIntoSession({ sessionId, files });
  const rows: unknown[] = [];
  let stillTruncated = 0;

  for (const [i, f] of files.entries()) {
    const stored = buildStoredUploadFilename(sessionId, f.filename, "current");
    const dest = path.join(config.uploadDir, stored);
    const srcSize = (await stat(f.path)).size;
    let destSize: number | null = null;

    try {
      destSize = (await stat(dest)).size;
    } catch {
      destSize = null;
    }

    const bad = destSize !== srcSize;

    if (bad) stillTruncated += 1;

    rows.push({
      file: f.filename,
      resume_action: outcomes[i]?.skipped ? "SKIPPED" : outcomes[i]?.ok ? "copied" : "failed",
      src_bytes: srcSize,
      final_bytes: destSize,
      STILL_WRONG_SIZE: bad
    });
  }

  log(JSON.stringify({ files_still_truncated_after_resume: stillTruncated, rows }, null, 2));
  await pool.end();
}

const run =
  MODE === "setup" ? setup : MODE === "crash" ? crash : MODE === "inspect" ? inspect : MODE === "resume" ? resume : null;

if (!run) {
  log("usage: setup <sizeMB> <count> | crash <ms> | inspect | resume");
  process.exit(1);
}

void run();
