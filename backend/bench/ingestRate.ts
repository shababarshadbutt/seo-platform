// Time the Cleaner-handoff ingest: the OLD sequential loop against the NEW
// bounded-concurrency batch, over the same corpus, at whatever scale you ask for.
//
// Why this exists separately from cleanerHandoffIngest.mjs: driving the real
// endpoint needs a real Cleaner run, and the Cleaner refuses a corpus big enough
// to make the ingest slow on fast local disks ("too large to deduplicate in
// memory" — its dedup budget is sized by URL BYTES, and the ingest cost this
// targets is per FILE). So the end-to-end script proves the wiring, and this one
// isolates the loop and measures it at the file counts that matter.
//
// The failure being measured against: undici inside the frontend proxy abandons a
// request whose response headers have not arrived in 300s (measured 305.1s,
// UND_ERR_HEADERS_TIMEOUT) and reports `TypeError: fetch failed`. So the number to
// watch is whether total ingest time crosses 300s, and how many files that takes.
//
// Usage: npx tsx bench/ingestRate.ts <fileCount> [kbPerFile]
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { buildStoredUploadFilename } from "../src/sitemaps/filenames.js";
import { createStoredSitemapFile } from "../src/sitemaps/ingest.js";
import {
  ingestFilesIntoSession,
  INGEST_CONCURRENCY
} from "../src/sitemaps/batchIngest.js";
import { copyFile, unlink } from "node:fs/promises";

const FILES = Number(process.argv[2] ?? 3000);
const KB = Number(process.argv[3] ?? 40);
const PROXY_HEADERS_TIMEOUT_S = 300;

const seconds = (ms: number) => Number((ms / 1000).toFixed(1));

async function makeCorpus(dir: string) {
  await mkdir(dir, { recursive: true });

  // One <loc> plus filler: file BYTES are what the copy pays for, and keeping the
  // URL count at 1 keeps corpus generation from dominating the run.
  const filler = "<!-- " + "p".repeat(Math.max(0, KB * 1024 - 200)) + " -->";
  const files: { path: string; filename: string }[] = [];

  for (let i = 0; i < FILES; i += 1) {
    const filename = `bench-${String(i).padStart(5, "0")}.xml`;
    const full = path.join(dir, filename);

    await writeFile(
      full,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        `  <url><loc>https://bench.example.com/p/${i}</loc></url>\n` +
        filler +
        "\n</urlset>\n",
      "utf8"
    );
    files.push({ path: full, filename });
  }

  return files;
}

async function newSession(name: string) {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, status, upload_complete)
      VALUES ($1, 'https://bench.example.com', 5, 'PENDING', false)
      RETURNING id
    `,
    [name]
  );

  return result.rows[0].id;
}

// EXACTLY what the route used to do: copy, ingest, one file at a time.
async function sequentialIngest(
  sessionId: string,
  files: { path: string; filename: string }[]
) {
  let stored = 0;

  for (const file of files) {
    const storedFilename = buildStoredUploadFilename(
      sessionId,
      file.filename,
      "current"
    );
    const destination = path.join(config.uploadDir, storedFilename);

    try {
      await copyFile(file.path, destination);
      await createStoredSitemapFile(
        sessionId,
        storedFilename,
        "current",
        file.filename
      );
      stored += 1;
    } catch {
      await unlink(destination).catch(() => undefined);
    }
  }

  return stored;
}

async function main() {
  const corpusDir = path.join(config.uploadDir, "ingest-bench-corpus");

  process.stdout.write(
    `generating ${FILES} files x ~${KB}KB (${((FILES * KB) / 1024).toFixed(
      1
    )} MB)...\n`
  );
  const files = await makeCorpus(corpusDir);

  // --- OLD: sequential ---
  const oldSession = await newSession(`ingest-bench-seq-${FILES}`);
  const oldStart = Date.now();
  const oldStored = await sequentialIngest(oldSession, files);
  const oldMs = Date.now() - oldStart;

  // --- NEW: bounded concurrency ---
  const newSession_ = await newSession(`ingest-bench-par-${FILES}`);
  const newStart = Date.now();
  const outcomes = await ingestFilesIntoSession({
    sessionId: newSession_,
    files
  });
  const newMs = Date.now() - newStart;
  const newStored = outcomes.filter((o) => o.ok).length;

  const oldPer = oldMs / FILES;
  const newPer = newMs / FILES;

  process.stdout.write(
    JSON.stringify(
      {
        files: FILES,
        kb_per_file: KB,
        concurrency: INGEST_CONCURRENCY,
        sequential: {
          stored: oldStored,
          seconds: seconds(oldMs),
          ms_per_file: Number(oldPer.toFixed(2)),
          // The whole point: at this rate, how many files put the single
          // synchronous request past the proxy's 300s wall?
          files_to_exceed_proxy_timeout: Math.ceil(
            (PROXY_HEADERS_TIMEOUT_S * 1000) / oldPer
          )
        },
        bounded_concurrency: {
          stored: newStored,
          seconds: seconds(newMs),
          ms_per_file: Number(newPer.toFixed(2)),
          files_to_exceed_proxy_timeout: Math.ceil(
            (PROXY_HEADERS_TIMEOUT_S * 1000) / newPer
          )
        },
        speedup: Number((oldMs / newMs).toFixed(2))
      },
      null,
      2
    ) + "\n"
  );

  // Clean up: corpus + both sessions' copies.
  await rm(corpusDir, { recursive: true, force: true });

  for (const sessionId of [oldSession, newSession_]) {
    const rows = await pool.query<{ filename: string }>(
      "SELECT filename FROM sitemap_files WHERE session_id = $1",
      [sessionId]
    );

    for (const row of rows.rows) {
      await unlink(path.join(config.uploadDir, row.filename)).catch(
        () => undefined
      );
    }

    await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  }

  await pool.end();
}

main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
