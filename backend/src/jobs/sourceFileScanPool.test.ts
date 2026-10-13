import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { resolveStructureFilters } from "../sitemaps/structureClusters.js";
import { destroySourceFileScanPool, runSourceFileScanJob } from "./sourceFileScanPool.js";

// sourceFileScanWorker.test.ts proves the TASK's logic agrees with
// countSitemapLocMatches, calling it directly in-process. This test proves the
// other half: that the task actually runs correctly ACROSS the Piscina thread
// boundary — the worker file resolves (workerRuntime.ts's dev/compiled path
// split), the dev execArgv (--import tsx) loads it, and structured-clone-safe
// input/output round-trips intact. A wrong extension or a missing execArgv
// entry would pass every test of the task function itself while failing here.

const dir = mkdtempSync(path.join(os.tmpdir(), "source-file-scan-pool-"));

test.after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await destroySourceFileScanPool();
});

const TEMPLATE = "/nsn/{param}";
const FILTER = resolveStructureFilters(
  [{ param_index: 0, anchor: "prefix" as const, value: "nsn-parts" }],
  TEMPLATE
);

assert.ok(FILTER, "test setup: filter must resolve against its own template");

test("runs the scan through the real Piscina pool and gets the right count back", async () => {
  const inputPath = path.join(dir, "mixed.xml");
  const locs = [
    "https://www.nsnstocks.com/nsn/nsn-parts-620/",
    "https://www.nsnstocks.com/nsn/nsn-parts-621/",
    "https://www.nsnstocks.com/nsn/cage-codes-42/"
  ];

  writeFileSync(
    inputPath,
    `<?xml version="1.0"?><urlset>${locs
      .map((loc) => `<url><loc>${loc}</loc></url>`)
      .join("")}</urlset>`,
    "utf8"
  );

  const result = await runSourceFileScanJob({
    inputPath,
    isGzip: false,
    template: TEMPLATE,
    resolvedFilters: FILTER as NonNullable<typeof FILTER>
  });

  assert.equal(result.failed, false);
  assert.equal(result.occurrences, 2);
});

test("a file the pool cannot read comes back failed, not thrown", async () => {
  const result = await runSourceFileScanJob({
    inputPath: path.join(dir, "missing.xml"),
    isGzip: false,
    template: TEMPLATE,
    resolvedFilters: FILTER as NonNullable<typeof FILTER>
  });

  assert.equal(result.failed, true);
  assert.equal(result.occurrences, 0);
});
