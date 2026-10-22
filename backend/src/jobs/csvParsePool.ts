import { Piscina } from "piscina";

import { workerExecArgv, workerFilePath } from "./workerRuntime.js";

import type { CsvParseInput, CsvParseResult } from "../workers/csvParseWorker.js";

// Module-level singleton piscina pool that parses the sitemap-regenerate
// wizard's uploaded CSVs in worker threads, so a multi-file upload parses
// every file in parallel instead of one at a time — same convention as
// jobs/sitemapGeneratePool.ts (which this job already hands its output to).
// Created lazily on first use, destroyed on worker shutdown via
// destroyCsvParsePool(). Same "no inline-vs-pool threshold" reasoning as
// sitemapGeneratePool.ts: csvUploadIngestJob.ts only ever runs inside the
// BullMQ worker process, never inline in an HTTP request, so there's no API
// responsiveness budget to protect by staying inline for small batches.

const MAX_WORKERS = readPositiveInt("CSV_PARSE_MAX_WORKERS", 4);

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
      filename: workerFilePath("csvParseWorker"),
      minThreads: 1,
      maxThreads: MAX_WORKERS,
      // Let idle threads exit so they don't hold the process open at shutdown.
      idleTimeout: 30_000,
      execArgv: workerExecArgv
    });
  }

  return pool;
}

export function runCsvParseJob(input: CsvParseInput): Promise<CsvParseResult> {
  return getPool().run(input);
}

export async function destroyCsvParsePool(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = null;
    await current.destroy();
  }
}
