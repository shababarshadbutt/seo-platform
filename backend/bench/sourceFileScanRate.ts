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
// Usage: npx tsx bench/sourceFileScanRate.ts <fileCount> [urlsPerFile] [matchEvery] [filtered]
//   npx tsx bench/sourceFileScanRate.ts 500 2000 200     # 500 files x 2000 urls,
//                                                         # 1-in-200 matches (5k total)
//   npx tsx bench/sourceFileScanRate.ts 500 20000 200 1  # same, but REAL file size
//                                                         # (20k locs/file) AND a real
//                                                         # (non-empty) structure filter
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
//
//   LARGE files (20,000 locs/file) x 300 files = 6M locs, `filtered` arg
//   toggling a REAL (non-empty) structure filter on and off at the same
//   corpus size:
//     unfiltered  (30,000 matched)   inline 83.43s   pooled 16.70s   5.00x
//     filtered   (120,000 matched)   inline 49.28s   pooled 22.44s   2.20x
//
//   COUNTERINTUITIVE RESULT, reported honestly rather than forced into the
//   hypothesis that motivated adding this scenario: a structure filter's extra
//   per-loc cost (a second new URL() parse + segment split in
//   urlMatchesStructureFilters) was expected to make the filtered run slower.
//   It did not — if anything inline ran FASTER filtered. The likely reason is
//   a confound in the unfiltered corpus, not evidence the filter is free: the
//   unfiltered run's locs are two DIFFERENT shapes (199/200 are a 2-segment
//   url that pathMatchesTemplate rejects by segment count before
//   urlMatchesStructureFilters is ever reached; 1/200 are the 4-segment shape
//   that reaches it), which likely makes V8's call sites megamorphic; the
//   filtered run's corpus is uniformly 4-segment (see buildFile's FILTERED
//   branch), which is monomorphic and apparently cheaper despite doing
//   strictly more work per loc. Net effect either way: POOLING still wins
//   decisively (2.2x-5.6x across every shape tested here), so this does not
//   change SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD's reasoning. What it DOES
//   ground: extrapolating the pooled filtered rate (267k locs/s) to the
//   reported production shape (~2,700 files x ~40,000 locs/file, per the
//   40,967-occurrence file observed in production) lands at roughly 400s
//   (~6.7 min) — the real number scanResultCache.ts's
//   LOSER_ABSOLUTE_CEILING_MS/SCAN_LOCK_TTL_SECONDS (20 min) are sized
//   against, replacing the pre-measurement 5.7-14 min extrapolation with a
//   figure that actually exercised the filter-matching path.
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
// Every prior run of this bench used FILTERS: [] (see header history below),
// which makes urlMatchesStructureFilters short-circuit
// (structureClusters.ts: `if (filters.length === 0) return true`) BEFORE its
// real per-loc cost — a SECOND new URL() parse + path-segment split + anchor
// match, on top of the first new URL() parse sourceFileScanWorker.ts already
// pays for pathMatchesTemplate — ever runs. The reported production hang
// happens specifically WITH a structure filter selected, so this flag turns
// that cost on for the first time anywhere in this repo's benchmarks.
const FILTERED = process.argv[5] === "1";

const TEMPLATE = "/{param}/{param}/{param}/{param}";
// segmentIndex 0 against buildFile's "cat-${seq % 50}" first segment: an
// EXACT-prefix match on "cat-0" passes only seq % 50 === 0 (1 in 50 locs,
// ~2%), not the always-true "cat-" prefix every loc would trivially satisfy.
// A filter nothing ever fails is a shortcut the JIT could special-case and
// would measure nothing real; this one does the real segment-split-and-compare
// work and mostly returns false, same as a real structure filter does against
// most of a pattern's candidate files.
const FILTERS: ResolvedStructureFilter[] = FILTERED
  ? [{ segmentIndex: 0, anchor: "prefix", value: "cat-0" }]
  : [];

function buildFile(fileIndex: number): { xml: string; matching: number } {
  const urls: string[] = [];
  let matching = 0;

  for (let index = 0; index < URLS_PER_FILE; index += 1) {
    const seq = fileIndex * URLS_PER_FILE + index;

    if (FILTERED) {
      // EVERY loc here is 4-segment, so pathMatchesTemplate's cheap
      // segment-count check passes for all of them and urlMatchesStructureFilters'
      // real per-loc cost (a second new URL() parse + segment split + anchor
      // compare) actually runs on every one — unlike the else-branch below,
      // where a non-matching loc is a DIFFERENT segment count and gets
      // rejected by pathMatchesTemplate before the filter is ever consulted.
      // That was this bench's first version, and it measured nothing: the
      // filtered and unfiltered runs came out within noise of each other
      // because the filter path was barely exercised.
      const matches = seq % 50 === 0; // exact "cat-0" prefix, ~2%, matching FILTERS below

      if (matches) {
        matching += 1;
      }

      urls.push(
        `  <url><loc>https://bench.example.com/cat-${seq % 50}/sub-${seq % 11}/item-${seq}/variant-${seq % 4}/</loc></url>`
      );
    } else if (seq % MATCH_EVERY === 0) {
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
    `seeding ${FILES} files x ${URLS_PER_FILE} urls/file = ${totalLocs} locs, ~1 in ${MATCH_EVERY} matching` +
      (FILTERED
        ? ", structure filter ACTIVE (real urlMatchesStructureFilters cost)"
        : ", no structure filter (short-circuits urlMatchesStructureFilters)")
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
