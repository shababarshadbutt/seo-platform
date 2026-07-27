import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

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

export const CLEANER_PARALLEL_THRESHOLD = readThreshold();
export const CLEANER_MAX_WORKERS = 4;

let classifyPool: Piscina | null = null;
let parsePool: Piscina | null = null;

function makePool(workerBaseName: string): Piscina {
  return new Piscina({
    filename: workerFilePath(workerBaseName),
    minThreads: 1,
    maxThreads: CLEANER_MAX_WORKERS,
    idleTimeout: 30_000,
    execArgv: workerExecArgv
  });
}

export function runCleanerClassify(
  input: CleanerClassifyInput
): Promise<CleanerClassifyResult> {
  if (!classifyPool) {
    classifyPool = makePool("cleanerClassifyWorker");
  }

  return classifyPool.run(input);
}

export function runCleanerParse(
  input: CleanerParseInput
): Promise<CleanerParseResult> {
  if (!parsePool) {
    parsePool = makePool("cleanerParseWorker");
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
