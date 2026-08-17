// Reproduce a large Sitemap Cleaner run and print where the time actually went.
//
// This exists because a real 1,681-file upload took "too long" and NOTHING on
// the server recorded which stage ate the time — the stage names were only ever
// written to the browser. Run it before and after any cleaner performance
// change; the numbers here, not intuition, decide what to optimise next.
//
// Usage (from backend/):
//   node --import tsx bench/cleanerStageTiming.ts [files] [urlsPerFile]
//   CLEANER_PARALLEL_THRESHOLD=99999 node --import tsx bench/cleanerStageTiming.ts
//   CLEANER_MAX_WORKERS=8           node --import tsx bench/cleanerStageTiming.ts
//
// Sweeping those two env vars against the SAME fixture is what separates the
// candidate causes: forcing sequential removes the provisional-file hop
// entirely (2 reads + 1 write per file instead of 3 + 2), and varying the
// worker count says whether the pool or the main-thread merge is the limit.

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import v8 from "node:v8";
import os from "node:os";
import path from "node:path";

import { CLEANER_MAX_WORKERS, CLEANER_PARALLEL_THRESHOLD, cleanerPoolStats, destroyCleanerPools } from "../src/jobs/cleanerPool.js";
import { cleanSitemaps } from "../src/sitemaps/cleaner.js";
import { createCleanerMetrics } from "../src/sitemaps/cleanerMetrics.js";
import { StageTimer } from "../src/sitemaps/stageTimer.js";

// `--dir <path>` runs against a REAL corpus instead of the synthetic fixture.
// Added for v1.52: the synthetic fixture (200 URLs/file) is ~104x smaller than the
// corpus that actually crashed the API, so it cannot reproduce a memory failure. A
// benchmark that cannot reproduce the bug cannot prove the fix.
const dirFlag = process.argv.indexOf("--dir");
const REAL_DIR = dirFlag > -1 ? process.argv[dirFlag + 1] : null;
const limitFlag = process.argv.indexOf("--limit");
const FILE_LIMIT =
  limitFlag > -1 ? Number.parseInt(process.argv[limitFlag + 1] ?? "", 10) : 0;

// With --dir you MUST also pass --domain, or every file is classified
// wrong-domain in Pass 1, nothing reaches Pass 2, and the run "succeeds" in
// seconds having deduplicated nothing. That mistake produced an 18 MB peak heap
// on a corpus that had just crashed production — a benchmark that silently
// measures nothing is worse than no benchmark.
const domainFlag = process.argv.indexOf("--domain");
const REAL_DOMAIN = domainFlag > -1 ? process.argv[domainFlag + 1] : null;

const FILES = Number.parseInt(process.argv[2] ?? "", 10) || 1681;
const URLS_PER_FILE = Number.parseInt(process.argv[3] ?? "", 10) || 200;
// Every Nth URL repeats an earlier one, so the dedup map and the duplicates
// report do realistic work instead of staying empty.
const DUP_EVERY = 10;
const HOST = "https://www.example.com";

function urlset(fileIndex: number): string {
  const rows: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  ];

  for (let i = 0; i < URLS_PER_FILE; i += 1) {
    const isDup = i % DUP_EVERY === 0 && fileIndex > 0;
    const loc = isDup
      ? `${HOST}/shared/product-${i}`
      : `${HOST}/f${fileIndex}/product-${i}-some-longer-slug-for-realism`;

    rows.push(`  <url><loc>${loc}</loc><lastmod>2026-08-01</lastmod></url>`);
  }

  rows.push("</urlset>");

  return rows.join("\n");
}

function ms(value: number) {
  return `${Math.round(value)}ms`;
}

function pct(part: number, whole: number) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";
}

// Peak memory sampler. The failure this bench now has to be able to reproduce is
// a heap abort, and an abort leaves no summary behind — so the peak has to be
// observed as the run goes, not read off at the end.
function startMemorySampler() {
  let peakRssMb = 0;
  let peakHeapMb = 0;

  const timer = setInterval(() => {
    const usage = process.memoryUsage();

    peakRssMb = Math.max(peakRssMb, usage.rss / 1024 / 1024);
    peakHeapMb = Math.max(peakHeapMb, usage.heapUsed / 1024 / 1024);
    // Printed live: if V8 aborts, this trail is the only evidence of how close it
    // got and where.
    process.stderr.write(
      `    [mem] rss=${Math.round(usage.rss / 1024 / 1024)}MB heap=${Math.round(
        usage.heapUsed / 1024 / 1024
      )}MB peak_heap=${Math.round(peakHeapMb)}MB\n`
    );
  }, 5000);

  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);

      return {
        peakRssMb: Math.round(peakRssMb),
        peakHeapMb: Math.round(peakHeapMb),
        heapLimitMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024)
      };
    }
  };
}

async function main() {
  const inDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-bench-in-"));
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-bench-out-"));

  console.log(
    `fixture: ${FILES} files x ${URLS_PER_FILE} URLs = ${(
      FILES * URLS_PER_FILE
    ).toLocaleString()} URLs`
  );
  console.log(
    `config:  parallel_threshold=${CLEANER_PARALLEL_THRESHOLD} max_workers=${CLEANER_MAX_WORKERS} ` +
      `cpus=${os.availableParallelism()} platform=${process.platform}`
  );
  console.log(
    `mode:    ${FILES >= CLEANER_PARALLEL_THRESHOLD ? "PARALLEL (worker pools + provisional hop)" : "SEQUENTIAL (no provisional hop)"}\n`
  );

  const writeStartedAt = Date.now();
  let files: { filename: string; path: string }[];

  if (REAL_DIR) {
    const all = readdirSync(REAL_DIR)
      .filter((name) => /\.xml(\.gz)?$/i.test(name))
      .sort();
    const chosen = FILE_LIMIT > 0 ? all.slice(0, FILE_LIMIT) : all;

    files = chosen.map((filename) => ({
      filename,
      path: path.join(REAL_DIR, filename)
    }));

    const bytes = files.reduce((sum, f) => sum + statSync(f.path).size, 0);

    if (!REAL_DOMAIN) {
      throw new Error(
        "--dir requires --domain <https://host>; without it every file is " +
          "dropped as wrong-domain and the run measures nothing"
      );
    }

    console.log(
      `real corpus: ${files.length} files, ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` +
        (FILE_LIMIT > 0 ? ` (limited from ${all.length})` : "")
    );
    console.log(`domain:      ${REAL_DOMAIN}`);
  } else {
    files = Array.from({ length: FILES }, (_, i) => {
      const filename = `sitemap-${i}.xml`;
      const filePath = path.join(inDir, filename);

      writeFileSync(filePath, urlset(i), "utf8");

      return { filename, path: filePath };
    });

    console.log(`wrote fixture in ${ms(Date.now() - writeStartedAt)}`);
  }

  console.log(
    `heap limit: ${Math.round(
      v8.getHeapStatistics().heap_size_limit / 1024 / 1024
    )}MB\n`
  );

  const metrics = createCleanerMetrics();
  const timer = new StageTimer();
  const sampler = startMemorySampler();
  const startedAt = Date.now();

  const { result } = await cleanSitemaps({
    files,
    domain: REAL_DOMAIN ?? HOST,
    subfolder: "sitemaps",
    today: "2026-08-17",
    outDir,
    metrics,
    onProgress: (event) => {
      if (event.stage !== "dedup") {
        timer.mark(event.stage);
      }
    }
  });

  const totalMs = Date.now() - startedAt;
  const mem = sampler.stop();
  const { stage_ms } = timer.finish();
  const snapshot = metrics.snapshot();

  console.log(
    `=== MEMORY peak_heap=${mem.peakHeapMb}MB peak_rss=${mem.peakRssMb}MB limit=${mem.heapLimitMb}MB ===`
  );
  console.log(`=== TOTAL ${ms(totalMs)} for ${files.length} files (${(totalMs / FILES).toFixed(1)}ms/file) ===\n`);

  console.log("explicit spans (authoritative):");
  const spans = Object.entries(snapshot.totals).sort((a, b) => b[1] - a[1]);

  for (const [key, value] of spans) {
    console.log(`  ${key.padEnd(34)} ${ms(value).padStart(9)}  ${pct(value, totalMs).padStart(6)}`);
  }

  console.log("\nStageTimer (coarse cross-check):");
  for (const [stage, value] of Object.entries(stage_ms).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${stage.padEnd(34)} ${ms(value).padStart(9)}  ${pct(value, totalMs).padStart(6)}`);
  }

  const pass1Sax = snapshot.totals["pass1.sax_ms"] ?? 0;
  const pass1Io = snapshot.totals["pass1.io_wait_ms"] ?? 0;
  const pass2Sax = snapshot.totals["pass2.sax_ms"] ?? 0;
  const pass2Io = snapshot.totals["pass2.io_wait_ms"] ?? 0;
  const workerWait = snapshot.totals["pass2.worker_wait_ms"] ?? 0;
  const readProv = snapshot.totals["pass2.read_provisional_ms"] ?? 0;
  const unlinkProv = snapshot.totals["pass2.unlink_provisional_ms"] ?? 0;
  const dedupWrite = snapshot.totals["pass2.dedup_and_write_ms"] ?? 0;

  console.log("\n--- the questions this run answers -------------------------------");
  console.log(
    `CPU vs I/O (sax parse):   sax ${ms(pass1Sax + pass2Sax)} vs io_wait ${ms(pass1Io + pass2Io)}`
  );
  console.log(
    `double parse cost:        pass1 sax ${ms(pass1Sax)} is thrown away except two integers per file`
  );
  console.log(
    `main thread blocked on workers: ${ms(workerWait)} (${pct(workerWait, totalMs)} of the run)`
  );
  console.log(
    `provisional hop (read+unlink):  ${ms(readProv + unlinkProv)} (${pct(readProv + unlinkProv, totalMs)})`
  );
  console.log(`dedup + final write:            ${ms(dedupWrite)} (${pct(dedupWrite, totalMs)})`);
  console.log(
    `\nverdict: ${
      workerWait > readProv + unlinkProv + dedupWrite
        ? "WORKER-BOUND -> the pool is the limit; CLEANER_MAX_WORKERS is the lever"
        : "MAIN-THREAD-BOUND -> the merge/provisional hop is the limit; more workers will NOT help"
    }`
  );

  console.log(`\npools: ${JSON.stringify(cleanerPoolStats())}`);
  console.log(
    `result: ${result.output_files.length} kept, ${result.dropped_files.length} dropped, ` +
      `${result.duplicates_removed.toLocaleString()} duplicates removed`
  );

  rmSync(inDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  // NOTE: REAL_DIR is never removed — it is the user's source data.
  await destroyCleanerPools();
}

await main();
