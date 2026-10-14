import { cpus } from "node:os";

import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

import type {
  SourceFileScanInput,
  SourceFileScanOutput
} from "../workers/sourceFileScanWorker.js";

// Module-level singleton piscina pool for the scoped source-file scan, next to
// dryRunScanPool.ts (the transform dry run's equivalent pool) and
// fileRewritePool.ts (the write side). Same lifecycle: created lazily, reused,
// destroyed on shutdown.
//
// SEPARATE POOL, same reasoning as dryRunScanPool.ts's own separation from
// fileRewritePool.ts: this one is bounded by CPU, not disk writes, so it wants
// a different size and a different scaling knob than either of those.
//
// LIVES IN THE API PROCESS, NOT THE WORKER. Unlike the dry run (a BullMQ job
// run from worker.ts), the scoped source-file scan is a synchronous read fired
// from an HTTP route in routes/sessions.ts, which only server.ts hosts — so
// this pool is created and destroyed from server.ts's lifecycle, not worker.ts's.

// Scans with at least this many URLs in the pattern use the pool; smaller ones
// stay inline. Same reasoning and same default as DRY_RUN_PARALLEL_THRESHOLD
// (jobs/dryRunScanPool.ts): thresholded on the pattern's total_urls, not file
// count, because per-file URL count is what predicts the cost, and 50,000 is
// about where thread startup stops being the larger cost at this scan's
// measured inline rate (137k <loc>/s per scanResultCache.ts's own measurement).
//
// Env-tunable for the same A/B reason: setting it above the pattern's URL
// count forces the inline path.
export const SOURCE_FILE_SCAN_PARALLEL_THRESHOLD = readPositiveInt(
  "SOURCE_FILE_SCAN_PARALLEL_THRESHOLD",
  50_000
);

// A pattern can be WIDE instead of DEEP: many files, each mostly OTHER url
// shapes with only a sparse few matching this pattern, so total_urls (the
// MATCHED count) never crosses the threshold above even though every
// candidate file still has to be read and regex-matched in full — cost
// tracks bytes-read-per-file x file count, not match count.
//
// MEASURED in bench/sourceFileScanRate.ts, realistic-size files (2,000
// locs/file, 1-in-200 matching), warmup pass discarded:
//
//     100 files (1,000 matched)   inline  2.32s   pooled 0.53s   4.37x
//     200 files (2,000 matched)   inline  4.19s   pooled 0.91s   4.59x
//     500 files (5,000 matched)   inline 14.91s   pooled 3.06s   4.87x
//
// All three stay far under total_urls' 50,000-match threshold, and the inline
// path's own rate (~34-48 files/s here) extrapolates to crossing the 180s
// client timeout around 5,000-6,000 files on this box's local SSD — fewer on
// whatever disk actually backs the deploy host's upload dir. 200 is chosen
// to catch that well before it becomes a problem, while costing under a
// second either way at this size.
//
// CAVEAT: at a pathologically tiny-file profile (1-10 locs/file — not a real
// sitemap shape, but reproduced in the same bench at 4,000-12,000 files),
// pooling's per-task dispatch overhead can make it slightly SLOWER than
// inline (0.6-0.9x). That regime stays under a few seconds either way, far
// from the 180s wall this threshold exists to avoid, so the trade is
// accepted rather than worth a second signal (e.g. a stat() per candidate
// file) to tell the two profiles apart upfront.
//
// Env-tunable for the same A/B reason as the threshold above.
export const SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD = readPositiveInt(
  "SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD",
  200
);

// Parallel scanners, derived from core count exactly like DRY_RUN_MAX_WORKERS —
// this work writes nothing and is bounded by CPU, so it scales with cores until
// the main-thread merge (summing each file's count) becomes the limit. See
// dryRunScanPool.ts for the measured curve this sizing is based on.
const MAX_WORKERS = readPositiveInt(
  "SOURCE_FILE_SCAN_MAX_WORKERS",
  Math.max(2, Math.min(8, cpus().length - 2))
);

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: workerFilePath("sourceFileScanWorker"),
      minThreads: 1,
      maxThreads: MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: workerExecArgv
    });
  }

  return pool;
}

export function runSourceFileScanJob(
  input: SourceFileScanInput
): Promise<SourceFileScanOutput> {
  return getPool().run(input);
}

// A single file cannot be split across threads, so it gains nothing from the
// pool however many URLs it holds — hence fileCount > 1 is required before
// either threshold is consulted.
export function shouldUseSourceFileScanPool(
  fileCount: number,
  totalUrls: number
): boolean {
  return (
    fileCount > 1 &&
    (totalUrls >= SOURCE_FILE_SCAN_PARALLEL_THRESHOLD ||
      fileCount >= SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD)
  );
}

export async function destroySourceFileScanPool(): Promise<void> {
  if (pool) {
    const current = pool;

    pool = null;
    await current.destroy();
  }
}
