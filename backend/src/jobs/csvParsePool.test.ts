import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { destroyCsvParsePool, runCsvParseJob } from "./csvParsePool.js";

// csvUrlList.test.ts proves parseCsvUrlList's own logic in-process. This test
// proves the other half: that it runs correctly ACROSS the Piscina thread
// boundary — the worker file resolves (workerRuntime.ts's dev/compiled path
// split), the dev execArgv (--import tsx) loads it, and the structured-clone
// round trip (string[] out, SkippedCsvRow[] out) stays intact. A wrong
// extension or a missing execArgv entry would pass every test of the parsing
// logic itself while failing here.

const dir = mkdtempSync(path.join(os.tmpdir(), "csv-parse-pool-"));

test.after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await destroyCsvParsePool();
});

test("parses a CSV through the real Piscina pool and gets URLs + skips back", async () => {
  const filePath = path.join(dir, "urls.csv");

  writeFileSync(
    filePath,
    [
      "url",
      "https://example.com/a",
      "https://example.com/b",
      "not-a-url"
    ].join("\n"),
    "utf8"
  );

  const result = await runCsvParseJob({ filePath });

  assert.deepEqual(result.urls, [
    "https://example.com/a",
    "https://example.com/b"
  ]);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.skippedSample.length, 1);
  assert.equal(result.skippedSample[0].value, "not-a-url");
});

test("parsing multiple files concurrently through the pool merges cleanly", async () => {
  const pathA = path.join(dir, "a.csv");
  const pathB = path.join(dir, "b.csv");

  writeFileSync(pathA, "https://example.com/1\nhttps://example.com/2", "utf8");
  writeFileSync(pathB, "https://example.com/3", "utf8");

  const [resultA, resultB] = await Promise.all([
    runCsvParseJob({ filePath: pathA }),
    runCsvParseJob({ filePath: pathB })
  ]);

  const merged = [...resultA.urls, ...resultB.urls];

  assert.deepEqual(merged, [
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/3"
  ]);
});
