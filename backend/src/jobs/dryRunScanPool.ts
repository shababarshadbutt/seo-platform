import { cpus } from "node:os";

import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

import type {
  TransformDryRunInput,
  TransformDryRunOutput
} from "../workers/transformDryRunWorker.js";

// Module-level singleton piscina pool for the transform DRY RUN, alongside the
// one that does the writes (jobs/fileRewritePool.ts). Same lifecycle: created
// lazily, reused, destroyed on worker shutdown.
//
// SEPARATE POOL, NOT A SECOND TASK KIND ON THE EXISTING ONE. The rewrite pool's
// worker is built around producing an output file; teaching it to sometimes not
// write would put a mode flag through a path where "did it write?" must never be
// ambiguous. They also want different sizes for different reasons — the rewrite
// pool is bounded by disk writes, this one by CPU — so sharing a thread budget
// would make tuning either of them affect the other.

// Scans with at least this many URLs in the pattern use the pool; smaller ones
// stay inline.
//
// THRESHOLDED ON URL COUNT, not file count, and that is a deliberate difference
// from FILE_REWRITE_PARALLEL_THRESHOLD. bench/README.md's sizing note is blunt
// about it: "Per-file URL count is the variable that matters, and sizing a repro
// by file count alone actively misleads." A pattern of 20 files holding 500,000
// URLs each is half an hour of work that a file-count threshold would send down
// the inline path; 400 files of 50 URLs is a rounding error that it would send
// to the pool. The scan knows patterns.total_urls before it starts, so it can
// simply use the number that predicts the cost.
//
// 50,000 is about a second of inline work at the measured 48k URLs/s — below
// that, thread startup is the larger cost.
//
// Env-tunable so the two paths can be measured against each OTHER on identical
// input: setting it above the pattern's URL count forces the inline path, which
// is how bench/transformDryRunScale.ts compares them rather than asserting.
export const DRY_RUN_PARALLEL_THRESHOLD = readPositiveInt(
  "DRY_RUN_PARALLEL_THRESHOLD",
  50_000
);

// Parallel scanners.
//
// DERIVED FROM THE CORE COUNT, which no other pool here does, and the difference
// is deliberate. The rewrite pool's flat 4 is right for work bounded by disk
// writes: more threads would queue on the same device. This scan writes nothing
// and is bounded by CPU, so it scales with cores until the main-thread merge
// becomes the limit. Measured on a 12-core box, 600k locs:
//
//     inline    52k locs/s
//     4 threads 95k locs/s   (1.8x)
//     8 threads 133k locs/s  (3.1x)
//
// A flat 4 would leave that on the table on the fleet box, and would
// OVERSUBSCRIBE a 2-core one.
//
//   * minus 2 — the worker process runs the other queues on the main thread, and
//     the merge itself is main-thread work;
//   * floor 2 — below that the pool cannot beat inline and the threshold should
//     have kept us out of here anyway;
//   * ceiling 8 — past this the merge dominates, so more threads buy little.
//
// Still env-overridable for a box that wants something else.
const MAX_WORKERS = readPositiveInt(
  "DRY_RUN_MAX_WORKERS",
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
      filename: workerFilePath("transformDryRunWorker"),
      minThreads: 1,
      maxThreads: MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: workerExecArgv
    });
  }

  return pool;
}

export function runDryRunScanJob(
  input: TransformDryRunInput
): Promise<TransformDryRunOutput> {
  return getPool().run(input);
}

export async function destroyDryRunScanPool(): Promise<void> {
  if (pool) {
    const current = pool;

    pool = null;
    await current.destroy();
  }
}
