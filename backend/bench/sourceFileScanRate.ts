// Measure the scoped source-file preview's inline-vs-pooled scan at the WIDE
// profile the "took too long" banner names directly ("it spans enough
// files"): many REALISTICALLY SIZED files, each mostly OTHER url shapes, with
// only a sparse few matching the narrow pattern. total_urls (the matched
// count) stays well under SOURCE_FILE_SCAN_PARALLEL_THRESHOLD — every file
// still has to be read and regex-matched in full regardless of how few of
// its locs match, so cost tracks BYTES READ / FILE COUNT, not match count.
// That gap is why SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD exists in
// jobs/sourceFileScanPool.ts.
//
// Usage: npx tsx bench/sourceFileScanRate.ts <fileCount> [urlsPerFile] [matchEvery]
//   npx tsx bench/sourceFileScanRate.ts 500 2000 200   # 500 files x 2000 urls,
//                                                       # 1-in-200 matches (5k total)
//
// A first warmup pass (both paths) is discarded before the measured pass, same
// reasoning as transformDryRunScale.ts: whichever path runs first otherwise
// pays for a cold page cache and a cold JIT alone.
//
// MEASURED on a dev laptop SSD — re-run on the actual deploy host before
// trusting these numbers elsewhere, since a remote-mounted upload dir is
// almost certainly slower, which only strengthens the case for pooling:
//
//   realistic-size files (2,000 locs/file, 1-in-200 matching):
//     100 files (1,000 matched)   inline  2.32s   pooled 0.53s   4.37x
//     200 files (2,000 matched)   inline  4.19s   pooled 0.91s   4.59x
//     500 files (5,000 matched)   inline 14.91s   pooled 3.06s   4.87x
//
//   pathologically tiny files (1-10 locs/file — NOT a realistic sitemap
//   shape, included only to show the other edge):
//     4,000 files (40,000 matched)  inline 4.60s   pooled 5.03s   0.91x
//     8,000 files (8,000 matched)   inline 5.88s   pooled 8.14s   0.72x
//    12,000 files (12,000 matched)  inline 12.29s  pooled 20.39s  0.60x
//    20,000 files (20,000 matched)  inline 20.72s  pooled 16.64s  1.25x
//
//   The tiny-file numbers are noisy/non-monotonic run to run (±25%+, per
//   cleaner-timing-measured's own lesson: never conclude from one pair) —
//   they are reported as a range, not a curve, and only to show pooling's
//   per-task dispatch overhead can lose at that profile. Both regimes stay
//   under a few tens of seconds, far from the 180s wall this threshold
//   exists to avoid.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { config } from "../src/config.js";
import {
  scanResolvedFilesInline,
  scanResolvedFilesPooled,
  type ResolvedScanFile
} from "../src/sitemaps/scopedSourceFileScan.js";
import { destroySourceFileScanPool } from "../src/jobs/sourceFileScanPool.js";
import type { ResolvedStructureFilter } from "../src/sitemaps/structureClusters.js";

const FILES = Number(process.argv[2] ?? 2000);
const URLS_PER_FILE = Number(process.argv[3] ?? 2000);
// 1 in MATCH_EVERY locs matches the 4-segment template; the rest are 2- or
// 3-segment urls a real sitemap mixes in, so they fail pathMatchesTemplate
// and still have to be read and rejected like the real ones are.
const MATCH_EVERY = Number(process.argv[4] ?? 200);

const TEMPLATE = "/{param}/{param}/{param}/{param}";
const FILTERS: ResolvedStructureFilter[] = [];

function buildFile(fileIndex: number): { xml: string; matching: number } {
  const urls: string[] = [];
  let matching = 0;

  for (let index = 0; index < URLS_PER_FILE; index += 1) {
    const seq = fileIndex * URLS_PER_FILE + index;

    if (seq % MATCH_EVERY === 0) {
      matching += 1;
      urls.push(
        `  <url><loc>https://bench.example.com/cat-${seq % 50}/sub-${seq % 11}/item-${seq}/variant-${seq % 4}/</loc></url>`
      );
    } else {
      urls.push(
        `  <url><loc>https://bench.example.com/cat-${seq % 50}/item-${seq}/</loc></url>`
      );
    }
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

async function seedCorpus(
  dir: string
): Promise<{ files: ResolvedScanFile[]; expectedMatching: number }> {
  await mkdir(dir, { recursive: true });

  const files: ResolvedScanFile[] = [];
  let expectedMatching = 0;

  for (let fileIndex = 0; fileIndex < FILES; fileIndex += 1) {
    const storedFilename = path.join(
      "source-file-scan-bench",
      `bench-${String(fileIndex).padStart(5, "0")}.xml`
    );
    const fullPath = path.join(config.uploadDir, storedFilename);
    const file = buildFile(fileIndex);

    await writeFile(fullPath, file.xml, "utf8");
    expectedMatching += file.matching;
    files.push({ displayName: storedFilename, storedFilename });
  }

  return { files, expectedMatching };
}

async function measure(
  label: string,
  run: () => Promise<{
    results: Array<{ source_file: string; occurrences: number }>;
    noMatches: number;
    unreadable: number;
  }>
) {
  const started = performance.now();
  const outcome = await run();
  const elapsedMs = performance.now() - started;
  const matchedUrls = outcome.results.reduce(
    (sum, r) => sum + r.occurrences,
    0
  );

  console.log("");
  console.log(`--- ${label} ---`);
  console.log(`files matched      ${outcome.results.length}`);
  console.log(`urls matched       ${matchedUrls}`);
  console.log(`unreadable         ${outcome.unreadable}`);
  console.log(`elapsed            ${(elapsedMs / 1000).toFixed(2)}s`);
  console.log(
    `files/s            ${Math.round(FILES / (elapsedMs / 1000))}`
  );

  return { outcome, elapsedMs };
}

async function main() {
  const corpusDir = path.join(config.uploadDir, "source-file-scan-bench");
  const totalLocs = FILES * URLS_PER_FILE;

  console.log(
    `seeding ${FILES} files x ${URLS_PER_FILE} urls/file = ${totalLocs} locs, ~1 in ${MATCH_EVERY} matching (wide, shallow profile)`
  );
  const { files, expectedMatching } = await seedCorpus(corpusDir);

  console.log(`expected matching urls (total_urls): ${expectedMatching}`);

  // WARM UP FIRST, both paths, result discarded — same reasoning as
  // transformDryRunScale.ts: whichever path runs first otherwise pays for a
  // cold page cache and a cold JIT alone, biasing the comparison.
  await scanResolvedFilesInline(files, TEMPLATE, FILTERS);
  await scanResolvedFilesPooled(files, TEMPLATE, FILTERS);

  const inline = await measure("inline (concurrency 6)", () =>
    scanResolvedFilesInline(files, TEMPLATE, FILTERS)
  );
  const pooled = await measure("pooled (Piscina)", () =>
    scanResolvedFilesPooled(files, TEMPLATE, FILTERS)
  );

  console.log("");
  console.log(
    `speedup            ${(inline.elapsedMs / pooled.elapsedMs).toFixed(2)}x`
  );

  if (inline.outcome.results.length !== pooled.outcome.results.length) {
    console.error(
      `
FAIL: inline matched ${inline.outcome.results.length} files, pooled matched ${pooled.outcome.results.length}`
    );
    process.exitCode = 1;
  }

  const inlineMatched = inline.outcome.results.reduce(
    (sum, r) => sum + r.occurrences,
    0
  );

  if (inlineMatched !== expectedMatching) {
    console.error(
      `
FAIL: matched ${inlineMatched} urls, expected ${expectedMatching}`
    );
    process.exitCode = 1;
  }

  await destroySourceFileScanPool();
  await rm(corpusDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
