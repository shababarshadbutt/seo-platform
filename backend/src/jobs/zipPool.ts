import { fileURLToPath } from "node:url";

import { Piscina } from "piscina";

import type {
  ZipWorkerInput,
  ZipWorkerResult
} from "../workers/zipWorker.js";

// Module-level singleton piscina pool that builds download ZIPs in worker
// threads, so a large multi-file archive build never blocks the worker PROCESS's
// main event loop (which also runs the parse/extract/sample/maintenance BullMQ
// queues). Created lazily on first use and reused for every job — never
// per-job. Destroyed on worker shutdown via destroyZipPool().
//
// The whole app runs via tsx (no build step), so the worker file is a .ts and
// each pool thread is started with `--import tsx` so it can load it.

let pool: Piscina | null = null;

function getPool(): Piscina {
  if (!pool) {
    pool = new Piscina({
      filename: fileURLToPath(new URL("../workers/zipWorker.ts", import.meta.url)),
      minThreads: 1,
      maxThreads: 2,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: ["--import", "tsx"]
    });
  }

  return pool;
}

export function runZipJob(input: ZipWorkerInput): Promise<ZipWorkerResult> {
  return getPool().run(input);
}

export async function destroyZipPool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.destroy();
  }
}
