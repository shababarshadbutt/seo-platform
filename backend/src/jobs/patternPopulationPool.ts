import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

import type {
  PatternPopulationInput,
  PatternPopulationResult
} from "../workers/patternPopulationWorker.js";

// Module-level singleton piscina pool that scans sitemap files for a pattern's
// URL population in worker threads, mirroring fileRewritePool / zipPool /
// cleanerPool. Created lazily on first use, reused for every job, destroyed on
// worker shutdown.
//
// WHAT THIS BUYS. Enumeration reads every <loc> of every file in the session to
// find the ones belonging to the patterns being verified — the only way to do
// it, since nothing records a pattern-to-file index. On a large client that is
// tens of millions of parsed elements on the main thread of the process that is
// also running the parse, extract, sample and maintenance queues.
//
// WHAT IT DOES NOT BUY. Enumeration is not the slow part of a verification: the
// HTTP phase after it is rate-limited to a few requests per second and dominates
// the wall clock. This keeps the event loop free during the scan and shortens a
// phase measured in tens of seconds; it does not change the shape of the run.

// Below this many files, run sequentially on the calling thread.
//
// Same reasoning as CLEANER_PARALLEL_THRESHOLD: spinning up threads and writing
// provisional files has a fixed cost that a handful of files never earns back,
// and the sequential path has to keep working anyway for exactly that case.
export const POPULATION_PARALLEL_THRESHOLD = 8;

// Matches CLEANER_MAX_WORKERS. These threads are pure CPU + disk read, and the
// box also runs Postgres, Mongo, Redis and two Next apps — see the heap
// arithmetic in docker-compose.aws.yml before raising it.
export const POPULATION_MAX_WORKERS = 4;

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: workerFilePath("patternPopulationWorker"),
      minThreads: 1,
      maxThreads: POPULATION_MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: workerExecArgv
    });
  }

  return pool;
}

export function runPatternPopulationScan(
  input: PatternPopulationInput
): Promise<PatternPopulationResult> {
  return getPool().run(input);
}

export async function destroyPatternPopulationPool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.destroy();
  }
}
