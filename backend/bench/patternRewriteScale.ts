// Measure the pattern structure-transform rewrite at real scale, with a
// MULTI-POSITION structure scope, on the sequential path vs the piscina pool.
//
// Two questions this answers with numbers rather than assertions:
//
//  1. Is the parallel pool actually ACTIVE on this code path? The rename and
//     transform rewrites were moved into the shared fileRewritePool in v1.48,
//     but "the code imports the pool" and "the pool runs at scale" are different
//     claims, and only one of them is checkable.
//  2. Does a multi-position scope stay CORRECT while parallel? Every worker
//     thread rebuilds the filter list from the spec independently, so an error
//     there would show up as a wrong rewritten-loc count, not as a crash.
//
// Sizing follows bench/README.md's warning: per-file URL count matters more than
// file count. 1,200 files x 2,000 URLs is 2.4M locs — a session shape that took
// minutes before the pool existed.
//
// Usage (run BOTH, compare):
//   FILE_REWRITE_PARALLEL_THRESHOLD=99999999 npx tsx bench/patternRewriteScale.ts
//   FILE_REWRITE_PARALLEL_THRESHOLD=200      npx tsx bench/patternRewriteScale.ts
//
// The threshold is what selects the path: above the file count forces the
// sequential loop, at/below it uses the pool.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { FILE_REWRITE_PARALLEL_THRESHOLD } from "../src/jobs/fileRewritePool.js";
import { destroyFileRewritePool } from "../src/jobs/fileRewritePool.js";
import { transformPatternSourceFilesOnDisk } from "../src/sitemaps/patternFileRewrites.js";
import {
  applyStructureFilterToRewriter,
  resolveStructureFilters
} from "../src/sitemaps/structureClusters.js";
import {
  parseStructure,
  transformUrl
} from "../src/sitemaps/transformStructure.js";

const fileCount = Number(process.argv[2] ?? 1200);
const urlsPerFile = Number(process.argv[3] ?? 2000);

const BASE = "https://example.com";
const TEMPLATE = "/rfq/{param}/{param}/{param}";
// Named-slot grammar for the transform itself.
const CURRENT_STRUCTURE = "/rfq/{A}/{B}/{C}";
const NEW_STRUCTURE = "/quote/{A}/{B}/{C}";

// Segment A cycles four prefix-anchored families, segment C two suffix-anchored
// ones. The scope below picks ONE of each, so the intersection is 1/4 x 1/2 =
// 1/8 of every URL — small enough that a filter silently dropping out would
// blow the expected count wide open rather than by a rounding error.
const A_FAMILIES = ["niin-parts", "part-types", "cage-codes", "nsn-parts"];
const C_FAMILIES = ["parts-catalog", "price-list"];

const SCOPE = [
  { param_index: 0, anchor: "prefix" as const, value: "niin-parts" },
  { param_index: 2, anchor: "suffix" as const, value: "parts-catalog" }
];

function buildFile(fileIndex: number): { xml: string; matching: number } {
  const urls: string[] = [];
  let matching = 0;

  for (let i = 0; i < urlsPerFile; i += 1) {
    const seq = fileIndex * urlsPerFile + i;
    const a = `${A_FAMILIES[seq % A_FAMILIES.length]}-${seq}`;
    const b = `mid-${seq}`;
    // floor(seq/4), NOT seq: with `seq % 2` the C family is implied by the A
    // family (every multiple of 4 is even), which would make the scope check
    // blind to a dropped segment-C filter.
    const c = `brand${seq}-${
      C_FAMILIES[Math.floor(seq / A_FAMILIES.length) % C_FAMILIES.length]
    }`;

    if (a.startsWith("niin-parts-") && c.endsWith("-parts-catalog")) {
      matching += 1;
    }

    urls.push(`  <url><loc>${BASE}/rfq/${a}/${b}/${c}</loc></url>`);
  }

  return {
    xml:
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join("\n") +
      "\n</urlset>\n",
    matching
  };
}

async function main() {
  await mkdir(config.uploadDir, { recursive: true });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('bench pattern rewrite scale', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );
  const sessionId = sessionRow.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, $2, $3)
      RETURNING id
    `,
    [sessionId, TEMPLATE, fileCount * urlsPerFile]
  );

  const storedNames: string[] = [];
  let expectedMatching = 0;
  const seedStarted = performance.now();

  for (let index = 0; index < fileCount; index += 1) {
    const stored = `${sessionId}-current-part-${index}.xml`;
    const built = buildFile(index);

    expectedMatching += built.matching;
    await writeFile(path.join(config.uploadDir, stored), built.xml, "utf8");
    await pool.query(
      `
        INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
        VALUES ($1, $2, $3, now(), true, false)
      `,
      [sessionId, stored, urlsPerFile]
    );
    storedNames.push(stored);
  }

  const seedMs = Math.round(performance.now() - seedStarted);

  const resolved = resolveStructureFilters(SCOPE, CURRENT_STRUCTURE);

  if (!resolved) {
    throw new Error("scope did not resolve against the current structure");
  }

  const current = parseStructure(CURRENT_STRUCTURE);
  const next = parseStructure(NEW_STRUCTURE);
  const rewriteUrl = applyStructureFilterToRewriter(
    (url: string) => transformUrl(url, current, next),
    resolved
  );

  const parallel = fileCount >= FILE_REWRITE_PARALLEL_THRESHOLD;
  const client = await pool.connect();
  let rewrittenLocCount = 0;
  let newFilePaths: string[] = [];
  let elapsedMs = 0;

  try {
    await client.query("BEGIN");

    const started = performance.now();
    const result = await transformPatternSourceFilesOnDisk(client, {
      sessionId,
      sourceRole: "current",
      selectedDisplayFiles: [],
      currentStructure: CURRENT_STRUCTURE,
      newStructure: NEW_STRUCTURE,
      rewriteUrl,
      structureFilters: resolved
    });

    elapsedMs = Math.round(performance.now() - started);
    rewrittenLocCount = result.rewrittenLocCount;
    newFilePaths = result.newFilePaths;

    // Rolled back on purpose: this is a measurement, not a migration. The files
    // written are unlinked below, exactly as the real job does on rollback.
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const totalUrls = fileCount * urlsPerFile;
  const perSecond = elapsedMs > 0 ? Math.round(totalUrls / (elapsedMs / 1000)) : 0;

  console.log(
    JSON.stringify(
      {
        path: parallel ? "PARALLEL (piscina pool)" : "SEQUENTIAL (inline loop)",
        threshold: FILE_REWRITE_PARALLEL_THRESHOLD,
        files: fileCount,
        urls_per_file: urlsPerFile,
        total_urls: totalUrls,
        seed_ms: seedMs,
        rewrite_ms: elapsedMs,
        urls_per_second: perSecond,
        rewritten_locs: rewrittenLocCount,
        expected_locs: expectedMatching,
        // The correctness check that matters at this scale: a multi-position
        // scope must rewrite the INTERSECTION only (1/8 here). Off means a
        // filter was dropped somewhere between the caller and the worker.
        scope_correct: rewrittenLocCount === expectedMatching
      },
      null,
      2
    )
  );

  // Cleanup: unlink both the seeds and the copies the rolled-back run wrote.
  await Promise.all(
    newFilePaths.map((file) => rm(file, { force: true }).catch(() => {}))
  );
  await Promise.all(
    storedNames.map((name) =>
      rm(path.join(config.uploadDir, name), { force: true }).catch(() => {})
    )
  );
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await destroyFileRewritePool();
  await pool.end();

  if (rewrittenLocCount !== expectedMatching) {
    process.exitCode = 1;
  }
}

void main();
