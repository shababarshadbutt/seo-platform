import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { countSitemapLocMatches, pathMatchesTemplate } from "./rewriteLocs.js";
import {
  resolveStructureFilters,
  urlMatchesStructureFilters
} from "./structureClusters.js";

// countSitemapLocMatches is the read-only sibling of rewriteSitemapLocFile that
// backs the Update Pattern modal's scoped file-list preview
// (scopedPatternSourceFileBreakdown in routes/sessions.ts): it must count
// EXACTLY the URLs the real scoped rewrite would touch, without writing
// anything. These tests drive it directly against real files on disk (plain
// and gzipped) rather than mocking the stream, since the whole point is that
// it reuses the actual streaming <loc> parser.

const dir = mkdtempSync(path.join(os.tmpdir(), "count-loc-matches-"));

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

// The exact repro shape: four families packed under one /nsn/{param}
// template, only one of which ("nsn-parts") should count for this filter.
const MIXED_LOCS = [
  "https://www.nsnstocks.com/nsn/niin-parts-10011/",
  "https://www.nsnstocks.com/nsn/niin-parts-24/",
  "https://www.nsnstocks.com/nsn/nsn-parts-620/",
  "https://www.nsnstocks.com/nsn/nsn-parts-621/",
  "https://www.nsnstocks.com/nsn/nsn-parts-622/",
  "https://www.nsnstocks.com/nsn/cage-codes-42/",
  "https://www.nsnstocks.com/nsn/part-types-825/"
];

test("counts only the URLs matching template + structure filter, plain XML", async () => {
  const inputPath = path.join(dir, "mixed.xml");

  writeFileSync(inputPath, sitemapXml(MIXED_LOCS), "utf8");

  const count = await countSitemapLocMatches({
    inputPath,
    isGzip: false,
    matchesUrl
  });

  assert.equal(count, 3);
});

test("counts correctly through gzip decompression", async () => {
  const inputPath = path.join(dir, "mixed.xml.gz");

  writeFileSync(inputPath, gzipSync(Buffer.from(sitemapXml(MIXED_LOCS), "utf8")));

  const count = await countSitemapLocMatches({
    inputPath,
    isGzip: true,
    matchesUrl
  });

  assert.equal(count, 3);
});

test("a file with zero matches counts zero rather than erroring", async () => {
  const inputPath = path.join(dir, "no-matches.xml");

  writeFileSync(
    inputPath,
    sitemapXml([
      "https://www.nsnstocks.com/nsn/niin-parts-10011/",
      "https://www.nsnstocks.com/nsn/cage-codes-42/"
    ]),
    "utf8"
  );

  const count = await countSitemapLocMatches({
    inputPath,
    isGzip: false,
    matchesUrl
  });

  assert.equal(count, 0);
});

test("does not write or modify the input file", async () => {
  const inputPath = path.join(dir, "untouched.xml");
  const original = sitemapXml(MIXED_LOCS);

  writeFileSync(inputPath, original, "utf8");

  await countSitemapLocMatches({ inputPath, isGzip: false, matchesUrl });

  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(inputPath, "utf8"), original);
});

// CDATA-wrapped locs are a real sitemap shape (some generators emit them) —
// the counter must decode through the same CDATA handling the real rewriter
// uses, not treat the wrapper as part of the URL.
test("counts a match wrapped in CDATA", async () => {
  const inputPath = path.join(dir, "cdata.xml");

  writeFileSync(
    inputPath,
    `<?xml version="1.0"?><urlset><url><loc><![CDATA[https://www.nsnstocks.com/nsn/nsn-parts-620/]]></loc></url></urlset>`,
    "utf8"
  );

  const count = await countSitemapLocMatches({
    inputPath,
    isGzip: false,
    matchesUrl
  });

  assert.equal(count, 1);
});
