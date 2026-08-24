
import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

import type {
  FileRewriteInput,
  FileRewriteResult
} from "../workers/fileRewriteWorker.js";

// Module-level singleton piscina pool that rewrites individual sitemap files in
// worker threads, so a big multi-file trailing-slash / bulk-replace job runs
// several file rewrites in parallel instead of one at a time (v1.32). Created
// lazily on first use, reused for every file, destroyed on worker shutdown via
// destroyFileRewritePool(). Same tsx-under-worker mechanism as the ZIP pool
// (jobs/zipPool.ts): each thread starts with `--import tsx` so it can load the
// .ts worker (no build step in this repo).

// Sessions with at least this many target files use the parallel pool; smaller
// ones stay on the simpler inline sequential loop (thread overhead isn't worth
// it, and most sessions are small).
//
// IT ALSO BOUNDS HOW LONG AN API REQUEST MAY HOLD A DB CONNECTION (v1.77), which
// is why the default came down from 200 to 25. apply-redirects uses this same
// number to decide inline-vs-queued, and since v1.75 an inline apply opens every
// file its pattern spans — sequentially, inside an open transaction, on one of
// the pool's ten connections. At 200 a 187-file pattern qualified as "small" and
// starved the API for minutes; unrelated pages then failed with "Request timed
// out". 25 files is still comfortably inside a request's budget and everything
// above it belongs to the worker.
//
// Env-tunable so the two paths can be measured against each OTHER on identical
// input — setting it above the file count forces the sequential path, which is
// how the parallel speedup on this code path is benchmarked rather than
// asserted (bench/patternRewriteScale.ts). It also lets a deployment on a
// bigger or smaller box move the crossover without a rebuild. Raising it past a
// few dozen now trades API responsiveness for it, so raise it deliberately.
export const FILE_REWRITE_PARALLEL_THRESHOLD = readPositiveInt(
  "FILE_REWRITE_PARALLEL_THRESHOLD",
  25
);

// Parallel file processors. Kept at 4 — a safe default for typical machines
// that still cuts a ~37-minute 900-file run to roughly a quarter of that.
const MAX_WORKERS = readPositiveInt("FILE_REWRITE_MAX_WORKERS", 4);

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
      filename: workerFilePath("fileRewriteWorker"),
      minThreads: 1,
      maxThreads: MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: workerExecArgv
    });
  }

  return pool;
}

export function runFileRewriteJob(
  input: FileRewriteInput
): Promise<FileRewriteResult> {
  return getPool().run(input);
}

export async function destroyFileRewritePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.destroy();
  }
}
