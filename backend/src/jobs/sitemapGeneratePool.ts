import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

import type {
  SitemapGenerateInput,
  SitemapGenerateResult
} from "../workers/sitemapGenerateWorker.js";

// Module-level singleton piscina pool that writes sitemap-regenerate wizard
// chunk files in worker threads, so a large regeneration writes several files
// in parallel instead of one at a time — same convention as
// jobs/fileRewritePool.ts. Created lazily on first use, destroyed on worker
// shutdown via destroySitemapGeneratePool(). Unlike fileRewritePool, there is
// no inline-vs-pool threshold: this job always runs inside a background
// worker process (never inside an HTTP request), so there is no API
// responsiveness budget to protect by staying inline for small batches.

const MAX_WORKERS = readPositiveInt("SITEMAP_GENERATE_MAX_WORKERS", 4);

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
      filename: workerFilePath("sitemapGenerateWorker"),
      minThreads: 1,
      maxThreads: MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: workerExecArgv
    });
  }

  return pool;
}

export function runSitemapGenerateJob(
  input: SitemapGenerateInput
): Promise<SitemapGenerateResult> {
  return getPool().run(input);
}

export async function destroySitemapGeneratePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.destroy();
  }
}
