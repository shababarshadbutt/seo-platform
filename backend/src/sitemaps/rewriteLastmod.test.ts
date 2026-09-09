import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import { buildLastmodDecision, rewriteSitemapLastmodFile } from "./rewriteLocs.js";

// rewriteSitemapLastmodFile is the Lastmod Updater's byte-preserving rewrite:
// it must touch ONLY the <lastmod> text it decides to change, leaving <loc>,
// whitespace, and every unrelated byte exactly as they were — the same
// guarantee LocRewriteTransform gives the rename/transform/redirect features.
// Driven against real files on disk (plain and gzipped), same convention as
// countSitemapLocMatches.test.ts.

const dir = mkdtempSync(path.join(os.tmpdir(), "rewrite-lastmod-"));

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function urlEntry(loc: string, lastmod?: string): string {
  return lastmod
    ? `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`
    : `<url><loc>${loc}</loc></url>`;
}

function sitemapXml(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${entries.join("")}</urlset>`;
}

async function rewrite(
  xml: string,
  decide: Parameters<typeof rewriteSitemapLastmodFile>[0]["decide"],
  fileBaseName: string
) {
  const inputPath = path.join(dir, `${fileBaseName}.xml`);
  const outputPath = path.join(dir, `${fileBaseName}.out.xml`);

  writeFileSync(inputPath, xml, "utf8");

  const rewrittenCount = await rewriteSitemapLastmodFile({
    inputPath,
    outputPath,
    isGzip: false,
    decide
  });

  return { rewrittenCount, output: readFileSync(outputPath, "utf8") };
}

test("rewrites an existing <lastmod> to the target date, in scope", async () => {
  const xml = sitemapXml([
    urlEntry("https://x.test/a/", "2026-08-28"),
    urlEntry("https://x.test/b/", "2026-08-28")
  ]);

  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "all-in-scope"
  );

  assert.equal(rewrittenCount, 2);
  assert.equal(
    output,
    sitemapXml([
      urlEntry("https://x.test/a/", "2026-09-09"),
      urlEntry("https://x.test/b/", "2026-09-09")
    ])
  );
});

test("a <url> with no <lastmod> element is left completely alone (v1 scope)", async () => {
  const xml = sitemapXml([
    urlEntry("https://x.test/a/", "2026-08-28"),
    urlEntry("https://x.test/no-lastmod/")
  ]);

  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "missing-lastmod"
  );

  assert.equal(rewrittenCount, 1);
  assert.equal(
    output,
    sitemapXml([
      urlEntry("https://x.test/a/", "2026-09-09"),
      urlEntry("https://x.test/no-lastmod/")
    ])
  );
});

test("out-of-scope URLs are left byte-identical (Vertical wise scoping)", async () => {
  const xml = sitemapXml([
    urlEntry("https://x.test/in-scope/", "2026-08-28"),
    urlEntry("https://x.test/out-of-scope/", "2026-08-28")
  ]);

  const scope = new Set(["https://x.test/in-scope/"]);
  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", scope),
    "scoped"
  );

  assert.equal(rewrittenCount, 1);
  assert.equal(
    output,
    sitemapXml([
      urlEntry("https://x.test/in-scope/", "2026-09-09"),
      urlEntry("https://x.test/out-of-scope/", "2026-08-28")
    ])
  );
});

test("already at the target date is a true no-op, not counted as rewritten", async () => {
  const xml = sitemapXml([urlEntry("https://x.test/a/", "2026-09-09")]);

  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "idempotent"
  );

  assert.equal(rewrittenCount, 0);
  assert.equal(output, xml);
});

test("never rewrites <loc> — only <lastmod> changes", async () => {
  const xml = sitemapXml([urlEntry("https://x.test/keep-me/", "2026-08-28")]);

  const { output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "loc-untouched"
  );

  assert.match(output, /<loc>https:\/\/x\.test\/keep-me\/<\/loc>/);
});

test("CDATA-wrapped <loc> and <lastmod> are decoded and rewritten correctly", async () => {
  const xml =
    `<?xml version="1.0"?><urlset><url>` +
    `<loc><![CDATA[https://x.test/cdata/]]></loc>` +
    `<lastmod><![CDATA[2026-08-28]]></lastmod>` +
    `</url></urlset>`;

  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "cdata"
  );

  assert.equal(rewrittenCount, 1);
  assert.match(output, /<lastmod><!\[CDATA\[2026-09-09\]\]><\/lastmod>/);
  assert.match(output, /<loc><!\[CDATA\[https:\/\/x\.test\/cdata\/\]\]><\/loc>/);
});

test("gzip round-trip: decompress, rewrite, recompress", async () => {
  const xml = sitemapXml([urlEntry("https://x.test/gz/", "2026-08-28")]);
  const inputPath = path.join(dir, "gz.xml.gz");
  const outputPath = path.join(dir, "gz.out.xml.gz");

  writeFileSync(inputPath, gzipSync(Buffer.from(xml, "utf8")));

  const rewrittenCount = await rewriteSitemapLastmodFile({
    inputPath,
    outputPath,
    isGzip: true,
    decide: buildLastmodDecision("2026-09-09", null)
  });

  assert.equal(rewrittenCount, 1);
  const output = gunzipSync(readFileSync(outputPath)).toString("utf8");
  assert.equal(output, sitemapXml([urlEntry("https://x.test/gz/", "2026-09-09")]));
});

test("a sitemap-index's <sitemap><loc>/<lastmod> pair rewrites the same way", async () => {
  // The transform never looks at the enclosing tag name, only "the most
  // recent <loc> then a <lastmod>" — this documents that it works identically
  // for a sitemap index's <sitemap> blocks (excluded from scope at the job
  // level, but the parser itself is structure-agnostic).
  const xml =
    `<?xml version="1.0"?><sitemapindex>` +
    `<sitemap><loc>https://x.test/a.xml</loc><lastmod>2026-08-28</lastmod></sitemap>` +
    `</sitemapindex>`;

  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "index"
  );

  assert.equal(rewrittenCount, 1);
  assert.match(output, /<lastmod>2026-09-09<\/lastmod>/);
});

test("a file with many entries rewrites every in-scope <lastmod>, none dropped", async () => {
  // Large enough that the underlying read stream's default chunk size cannot
  // possibly deliver the whole file in one _transform call, exercising the
  // same tag-spanning-a-chunk-boundary path production traffic hits.
  const entries = Array.from({ length: 5000 }, (_, index) =>
    urlEntry(`https://x.test/page-${index}/`, "2026-08-28")
  );
  const xml = sitemapXml(entries);

  const { rewrittenCount, output } = await rewrite(
    xml,
    buildLastmodDecision("2026-09-09", null),
    "many-entries"
  );

  assert.equal(rewrittenCount, 5000);
  assert.equal(output, sitemapXml(
    entries.map((_, index) => urlEntry(`https://x.test/page-${index}/`, "2026-09-09"))
  ));
});
