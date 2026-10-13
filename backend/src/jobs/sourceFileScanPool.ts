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

export async function destroySourceFileScanPool(): Promise<void> {
  if (pool) {
    const current = pool;

    pool = null;
    await current.destroy();
  }
}
