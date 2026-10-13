import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { countSitemapLocMatches, pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";
import {
  resolveStructureFilters,
  urlMatchesStructureFilters
} from "../sitemaps/structureClusters.js";
import sourceFileScanTask from "./sourceFileScanWorker.js";

// sourceFileScanTask is sourceFileScanWorker's whole reason to exist: it must
// count EXACTLY what countSitemapLocMatches counts for the same file and
// scope, since scopedPatternSourceFileBreakdown (routes/sessions.ts) picks
// between the two purely on patterns.total_urls — a pattern that happens to
// cross SOURCE_FILE_SCAN_PARALLEL_THRESHOLD must report the same numbers a
// smaller one would, or the pooled path becomes a correctness bug disguised as
// a performance one. Run directly (not through Piscina) the same way
// countSitemapLocMatches.test.ts drives its sibling directly against real
// files on disk — this is the worker's own logic, independent of the thread
// boundary around it.

const dir = mkdtempSync(path.join(os.tmpdir(), "source-file-scan-worker-"));

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TEMPLATE = "/nsn/{param}";
const FILTER = resolveStructureFilters(
  [{ param_index: 0, anchor: "prefix" as const, value: "nsn-parts" }],
  TEMPLATE
);

assert.ok(FILTER, "test setup: filter must resolve against its own template");

function matchesUrl(url: string): boolean {
  let pathname: string;

  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }

  return (
    pathMatchesTemplate(pathname, TEMPLATE) &&
    urlMatchesStructureFilters(url, FILTER as NonNullable<typeof FILTER>)
  );
}

function sitemapXml(locs: string[]): string {
  const body = locs.map((loc) => `<url><loc>${loc}</loc></url>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${body}</urlset>`;
}

const MIXED_LOCS = [
  "https://www.nsnstocks.com/nsn/niin-parts-10011/",
  "https://www.nsnstocks.com/nsn/niin-parts-24/",
  "https://www.nsnstocks.com/nsn/nsn-parts-620/",
  "https://www.nsnstocks.com/nsn/nsn-parts-621/",
  "https://www.nsnstocks.com/nsn/nsn-parts-622/",
  "https://www.nsnstocks.com/nsn/cage-codes-42/",
  "https://www.nsnstocks.com/nsn/part-types-825/"
];

test("agrees with countSitemapLocMatches on a plain XML file", async () => {
  const inputPath = path.join(dir, "mixed.xml");

  writeFileSync(inputPath, sitemapXml(MIXED_LOCS), "utf8");

  const [expected, actual] = await Promise.all([
    countSitemapLocMatches({ inputPath, isGzip: false, matchesUrl }),
    sourceFileScanTask({
      inputPath,
      isGzip: false,
      template: TEMPLATE,
      resolvedFilters: FILTER as NonNullable<typeof FILTER>
    })
  ]);

  assert.equal(actual.failed, false);
  assert.equal(actual.occurrences, expected);
  assert.equal(actual.occurrences, 3);
});

test("agrees with countSitemapLocMatches through gzip decompression", async () => {
  const inputPath = path.join(dir, "mixed.xml.gz");

  writeFileSync(inputPath, gzipSync(Buffer.from(sitemapXml(MIXED_LOCS), "utf8")));

  const [expected, actual] = await Promise.all([
    countSitemapLocMatches({ inputPath, isGzip: true, matchesUrl }),
    sourceFileScanTask({
      inputPath,
      isGzip: true,
      template: TEMPLATE,
      resolvedFilters: FILTER as NonNullable<typeof FILTER>
    })
  ]);

  assert.equal(actual.failed, false);
  assert.equal(actual.occurrences, expected);
});

test("a file with zero matches reports zero, not failed", async () => {
  const inputPath = path.join(dir, "no-matches.xml");

  writeFileSync(
    inputPath,
    sitemapXml([
      "https://www.nsnstocks.com/nsn/niin-parts-10011/",
      "https://www.nsnstocks.com/nsn/cage-codes-42/"
    ]),
    "utf8"
  );

  const result = await sourceFileScanTask({
    inputPath,
    isGzip: false,
    template: TEMPLATE,
    resolvedFilters: FILTER as NonNullable<typeof FILTER>
  });

  assert.equal(result.failed, false);
  assert.equal(result.occurrences, 0);
});

test("a missing file reports failed rather than throwing", async () => {
  const result = await sourceFileScanTask({
    inputPath: path.join(dir, "does-not-exist.xml"),
    isGzip: false,
    template: TEMPLATE,
    resolvedFilters: FILTER as NonNullable<typeof FILTER>
  });

  assert.equal(result.failed, true);
  assert.equal(result.occurrences, 0);
});
