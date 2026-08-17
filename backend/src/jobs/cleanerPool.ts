import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { Piscina } from "piscina";

import type {
  CleanerClassifyInput,
  CleanerClassifyResult
} from "../workers/cleanerClassifyWorker.js";
import type {
  CleanerParseInput,
  CleanerParseResult
} from "../workers/cleanerParseWorker.js";

// Module-level singleton piscina pools for the Sitemap Cleaner, mirroring
// jobs/fileRewritePool.ts. Created lazily, reused, destroyed on server
// shutdown. Each thread starts with `--import tsx` so it can load the .ts
// workers with no build step.
//
// Why parallel helps this time (v1.45) where the reverted v1.44 attempt did
// not: the workers no longer ship URL-string arrays back across the thread
// boundary (that structured-clone cost was the bottleneck). Pass 1 returns only
// tiny per-file counts. Pass 2 workers write their on-domain URLs to a
// provisional file ON DISK and return only a path + count — so the cross-file
// dedup on the main thread reads the URLs back from disk, not via IPC.

// File sets with at least this many files use the parallel pools; smaller ones
// stay on the simple sequential loop. Env-overridable so the parallel vs
// sequential paths can be benchmarked on the same batch (and so it can be
// tuned / disabled in the field without a rebuild).
function readThreshold(): number {
  const raw = Number.parseInt(process.env.CLEANER_PARALLEL_THRESHOLD ?? "", 10);

  return Number.isFinite(raw) && raw >= 0 ? raw : 200;
}

// Thread count per pool. Made env-readable so the measurement matrix can sweep
// {1,2,4,8} without a rebuild. The DEFAULT IS DELIBERATELY UNCHANGED at 4: this
// release measures the cleaner, it does not tune it, and moving the default
// would mean the numbers describe a system nobody actually ran.
function readWorkers(): number {
  const raw = Number.parseInt(process.env.CLEANER_MAX_WORKERS ?? "", 10);

  if (!Number.isFinite(raw)) {
    return 4;
  }

  return Math.max(1, Math.min(16, raw));
}

export const CLEANER_PARALLEL_THRESHOLD = readThreshold();
export const CLEANER_MAX_WORKERS = readWorkers();

// Reported once per pool creation. `availableParallelism` is what makes a
// starved container visible: 4 worker threads on a 2-vCPU WSL2 VM is a very
// different run from 4 on a 16-core host, and until now nothing recorded which
// one produced a given timing.
export function cleanerPoolConfig() {
  return {
    workers: CLEANER_MAX_WORKERS,
    threshold: CLEANER_PARALLEL_THRESHOLD,
    cpus: availableParallelism()
  };
}

// Live saturation of both pools, sampled at the end of each pass. `utilization`
// near 1 means the threads are the bottleneck; near 0 means the main thread is.
export function cleanerPoolStats() {
  const snapshot = (pool: Piscina | null) =>
    pool
      ? {
          utilization: Number(pool.utilization.toFixed(3)),
          queue_size: pool.queueSize,
          threads: pool.threads.length
        }
      : null;

  return { classify: snapshot(classifyPool), parse: snapshot(parsePool) };
}

let classifyPool: Piscina | null = null;
let parsePool: Piscina | null = null;

function makePool(workerFile: string): Piscina {
  return new Piscina({
    filename: fileURLToPath(new URL(`../workers/${workerFile}`, import.meta.url)),
    minThreads: 1,
    maxThreads: CLEANER_MAX_WORKERS,
    idleTimeout: 30_000,
    execArgv: ["--import", "tsx"]
  });
}

export function runCleanerClassify(
  input: CleanerClassifyInput
): Promise<CleanerClassifyResult> {
  if (!classifyPool) {
    classifyPool = makePool("cleanerClassifyWorker.ts");
  }

  return classifyPool.run(input);
}

export function runCleanerParse(
  input: CleanerParseInput
): Promise<CleanerParseResult> {
  if (!parsePool) {
    parsePool = makePool("cleanerParseWorker.ts");
  }

  return parsePool.run(input);
}

export async function destroyCleanerPools(): Promise<void> {
  const pools = [classifyPool, parsePool].filter(
    (pool): pool is Piscina => pool !== null
  );
  classifyPool = null;
  parsePool = null;
  await Promise.all(pools.map((pool) => pool.destroy()));
}
