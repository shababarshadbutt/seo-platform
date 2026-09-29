import { createReadStream } from "node:fs";

import { parse } from "csv-parse";

import { isHttpUrl } from "./filenames.js";

// The sitemap-regenerate wizard's CSV input: one URL per row, column 0 only.
// Tolerates a header row (anything in row 1 that isn't itself a URL is
// silently dropped, not counted as a skip) and blank lines. Streaming so a
// CSV with hundreds of thousands of rows never has to sit fully in memory.

const MAX_SKIPPED_SAMPLE = 50;

function isWellFormedUrl(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }

  try {
    void new URL(value);
    return true;
  } catch {
    return false;
  }
}

export type SkippedCsvRow = { line: number; value: string; reason: string };

export type CsvUrlListResult = {
  urls: string[];
  skippedCount: number;
  skippedSample: SkippedCsvRow[];
};

export async function parseCsvUrlList(filePath: string): Promise<CsvUrlListResult> {
  const urls: string[] = [];
  const skippedSample: SkippedCsvRow[] = [];
  let skippedCount = 0;
  let line = 0;
  let sawFirstRow = false;

  const parser = createReadStream(filePath).pipe(
    parse({
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true
    })
  );

  for await (const record of parser as AsyncIterable<string[]>) {
    line += 1;
    const value = (record[0] ?? "").trim();

    if (!value) {
      continue;
    }

    // Only row 1 gets a free pass to be a non-URL (a header like "url" or
    // "Old URL") without counting as a skip — every later row that isn't a
    // URL is a genuine bad row the operator should see.
    if (!sawFirstRow) {
      sawFirstRow = true;

      if (!isWellFormedUrl(value)) {
        continue;
      }
    }

    if (!isWellFormedUrl(value)) {
      skippedCount += 1;

      if (skippedSample.length < MAX_SKIPPED_SAMPLE) {
        skippedSample.push({ line, value, reason: "not a valid http(s) URL" });
      }

      continue;
    }

    urls.push(value);
  }

  return { urls, skippedCount, skippedSample };
}
