// Measure the transform DRY RUN at real scale, and prove its two bounded
// structures stay bounded.
//
// The dry run exists because the Update Pattern preview is computed from a
// reservoir sample capped at ~1,000 URLs while a pattern can hold millions.
// That makes it the thing standing between the user and a wrong rewrite of the
// whole fleet — so two claims about it need numbers rather than assertions:
//
//  1. What does it COST? Gating the apply on it only makes sense if the price is
//     one a user will pay.
//  2. Do the SHAPE HISTOGRAM and the COLLISION SET stay bounded? Both are
//     accumulators fed once per matching URL. An unbounded one is not a slow
//     path, it is an out-of-memory crash at 6.58M URLs — and it would only ever
//     show up in production, on the largest session, at the worst moment.
//
// MEASURED, 300 files x 2,000 urls = 600k locs, 7/8 of them in the pattern, on a
// 12-core box:
//
//     bare scan, no-op visitor          2.7s   (224k locs/s)
//     + one new URL() per loc           3.8s
//     + three new URL() per loc         5.8s
//     inline dry run                   10.4s   ( 58k locs/s)
//     pooled dry run                    2.0s   (296k locs/s)   5.1x
//
// Read the two dry-run rows together with the floor above them. The scan is
// neither I/O bound nor XML-parse bound — 2.7s of a 10.4s inline run is the
// actual reading. The rest is per-URL work (three `new URL()` parses: one to
// classify, one inside transformUrl, one to shape the result, plus transformUrl's
// own segment walk), and per-URL work is JavaScript, so inline it all queues
// behind one thread however many files are read at once. Moving it into a pool is
// what the 5.1x is.
//
// The pooled figure is STEADY STATE — the pool's threads are already up, because
// idleTimeout keeps them for 30s and the warm-up pass has run. A genuinely cold
// first scan pays thread startup and measures nearer 3x. Both are real; which one
// a user sees depends on whether they just ran another scan.
//
// Extrapolating the pooled rate, a 6.58M-URL session is ~22s against the apply's
// own measured 136s — so gating the apply on a full-population measurement costs
// well under a fifth of the operation it protects.
//
// Deliberately NO DATABASE. The scan takes resolved targets, so the measurement
// is of the scan itself rather than of Postgres.
//
// Usage:
//   npx tsx bench/transformDryRunScale.ts [fileCount] [urlsPerFile]
//   npx tsx bench/transformDryRunScale.ts 1200 2000     # 2.4M locs, the default
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { PatternScanTarget } from "../src/sitemaps/patternFileScan.js";
import { SHAPE_LIMIT } from "../src/sitemaps/transformDryRun.js";
import { scanTransformDryRun } from "../src/jobs/transformDryRunScan.js";
import { destroyDryRunScanPool } from "../src/jobs/dryRunScanPool.js";

const fileCount = Number(process.argv[2] ?? 1200);
const urlsPerFile = Number(process.argv[3] ?? 2000);

const BASE = "https://example.com";
const TEMPLATE = "/nspart/{param}";
const CURRENT_STRUCTURE = "/nspart/{A}/";
const NEW_STRUCTURE = "/nsnpart/{A|split|6|-|}/";

// Value lengths VARY on purpose. A uniform corpus would produce exactly one
// result shape and prove nothing about the histogram; this produces a handful,
// which is what a real pattern looks like and what the cap has to survive.
const DIGIT_WIDTHS = [3, 4, 5, 6, 7];

function buildFile(fileIndex: number): { xml: string; matching: number } {
  const urls: string[] = [];
  let matching = 0;

  for (let index = 0; index < urlsPerFile; index += 1) {
    const seq = fileIndex * urlsPerFile + index;

    // One in eight is outside the pattern, so `matched` and `total_locs` cannot
    // be accidentally equal and a broken denominator would show.
    if (index % 8 === 7) {
      urls.push(`  <url><loc>${BASE}/other/thing-${seq}/</loc></url>`);
      continue;
    }

    const width = DIGIT_WIDTHS[seq % DIGIT_WIDTHS.length];
    const value = String(seq % 10 ** width).padStart(width, "0");

    matching += 1;
    urls.push(`  <url><loc>${BASE}/nspart/part-${value}/</loc></url>`);
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

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const workDir = path.join(os.tmpdir(), `dry-run-bench-${process.pid}`);

  await mkdir(workDir, { recursive: true });

  const targets: PatternScanTarget[] = [];
  let expectedMatching = 0;
  const seedStarted = performance.now();

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const file = buildFile(fileIndex);
    const storedFilename = `bench-${fileIndex}.xml`;
    const inputPath = path.join(workDir, storedFilename);

    await writeFile(inputPath, file.xml, "utf8");
    expectedMatching += file.matching;
    targets.push({
      displayName: storedFilename,
      storedFilename,
      inputPath,
      isGzip: false
    });
  }

  const seedMs = performance.now() - seedStarted;
  const totalUrls = fileCount * urlsPerFile;

  console.log(
    `seeded ${fileCount} files x ${urlsPerFile} urls = ${totalUrls.toLocaleString(
      "en-US"
    )} locs in ${(seedMs / 1000).toFixed(1)}s`
  );

  async function measure(label: string, totalUrls: number) {
    if (global.gc) {
      global.gc();
    }

    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const scan = await scanTransformDryRun({
      targets,
      currentStructure: CURRENT_STRUCTURE,
      newStructure: NEW_STRUCTURE,
      template: TEMPLATE,
      structureFilters: [],
      totalUrls
    });
    const elapsedMs = performance.now() - started;
    const heapAfter = process.memoryUsage().heapUsed;

    console.log("");
    console.log(`--- ${label} (parallel=${scan.parallel}) ---`);
    console.log(`files scanned      ${scan.filesScanned}`);
    console.log(
      `locs read          ${scan.totals.total_locs.toLocaleString("en-US")}`
    );
    console.log(
      `matched            ${scan.totals.matched.toLocaleString("en-US")}`
    );
    console.log(
      `would rewrite      ${scan.totals.rewritten.toLocaleString("en-US")}`
    );
    console.log(
      `distinct shapes    ${scan.totals.shapes.length} (cap ${SHAPE_LIMIT})`
    );
    console.log(`shapes truncated   ${scan.totals.shapes_truncated}`);
    console.log(`elapsed            ${(elapsedMs / 1000).toFixed(2)}s`);
    console.log(
      `throughput         ${Math.round(
        scan.totals.total_locs / (elapsedMs / 1000)
      ).toLocaleString("en-US")} locs/s`
    );
    console.log(`heap delta         ${mb(heapAfter - heapBefore)}`);

    return { scan, elapsedMs };
  }

  // WARM UP FIRST. Whichever path runs first pays for a cold page cache and a
  // cold JIT, and hands the second one a warm machine — measured at up to 2x,
  // which is the same order as the effect being measured. Discarding one full
  // pass of each removes the ordering bias rather than hoping it is small.
  await measure("warmup inline", 0);
  await measure("warmup pooled", 10_000_000);

  // Below the threshold -> inline; far above it -> pooled. Same input, same
  // fixture, one process, so the comparison is of the two PATHS and not of two
  // runs on different data.
  const inline = await measure("inline", 0);
  const pooled = await measure("pooled", 10_000_000);

  console.log("");
  console.log(
    `speedup            ${(inline.elapsedMs / pooled.elapsedMs).toFixed(2)}x`
  );

  // The bench is also a check. Printing a speedup for two runs that disagree
  // about what they measured would be worse than failing.
  const totals = inline.scan.totals;

  if (totals.matched !== expectedMatching) {
    console.error(
      `
FAIL: matched ${totals.matched}, expected ${expectedMatching}`
    );
    process.exitCode = 1;
  }

  if (pooled.scan.totals.rewritten !== totals.rewritten) {
    console.error(
      `
FAIL: pooled rewrote ${pooled.scan.totals.rewritten}, inline ${totals.rewritten}`
    );
    process.exitCode = 1;
  }

  if (totals.shapes.length > SHAPE_LIMIT) {
    console.error(
      `
FAIL: shape histogram grew past its cap (${totals.shapes.length} > ${SHAPE_LIMIT})`
    );
    process.exitCode = 1;
  }

  await destroyDryRunScanPool();
  await rm(workDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
