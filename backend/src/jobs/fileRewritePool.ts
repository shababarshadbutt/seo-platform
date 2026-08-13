import { fileURLToPath } from "node:url";

import { Piscina } from "piscina";

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

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);

  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Pattern rename/transform scale their thread count to the number of files
// instead of the all-or-nothing >= FILE_REWRITE_PARALLEL_THRESHOLD switch the
// older callers use: one thread per PATTERN_FILES_PER_THREAD files, capped.
// 1-500 -> 1, 501-1000 -> 2, 1001-1500 -> 3, 1501+ -> 4.
export const PATTERN_FILES_PER_THREAD = positiveIntEnv(
  "PATTERN_REWRITE_FILES_PER_THREAD",
  500
);
export const FILE_REWRITE_MAX_WORKERS = positiveIntEnv(
  "FILE_REWRITE_MAX_WORKERS",
  MAX_WORKERS
);

export function workerCountForFiles(fileCount: number): number {
  if (fileCount <= 0) {
    return 1;
  }

  return Math.min(
    FILE_REWRITE_MAX_WORKERS,
    Math.max(1, Math.ceil(fileCount / PATTERN_FILES_PER_THREAD))
  );
}

// Run `fn` over `items` with at most `limit` in flight at once, and ALWAYS
// settle every task before returning.
//
// This is how the per-job thread ladder is enforced: piscina's maxThreads is a
// property of the shared pool and can't be varied per job, so the ladder caps
// the number of concurrent pool.run() calls instead.
//
// Promise.all is deliberately NOT used. These tasks run alongside an open
// transaction; a first-failure reject would return while stragglers are still
// in flight, and those stragglers then query a client the catch block has
// already released — an unhandled rejection that takes the worker process down.
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  const effectiveLimit = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  async function runner(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: effectiveLimit }, () => runner())
  );

  return results;
}

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: fileURLToPath(
        new URL("../workers/fileRewriteWorker.ts", import.meta.url)
      ),
      minThreads: 1,
      // The pool ceiling. Individual jobs stay at or below this via their own
      // concurrency limit (workerCountForFiles + mapWithConcurrency); the pool
      // itself never needs to be rebuilt to change a job's thread count.
      maxThreads: FILE_REWRITE_MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: ["--import", "tsx"]
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
