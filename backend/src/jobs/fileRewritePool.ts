
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
export const FILE_REWRITE_PARALLEL_THRESHOLD = 200;

// Parallel file processors. Kept at 4 — a safe default for typical machines
// that still cuts a ~37-minute 900-file run to roughly a quarter of that.
const MAX_WORKERS = 4;

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
