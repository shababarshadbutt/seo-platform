import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import generateSitemapChunk from "./sitemapGenerateWorker.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "sitemap-generate-worker-"));

after(() => rmSync(dir, { recursive: true, force: true }));

test("writes one <url> per entry, in order, with per-URL optional <lastmod>", async () => {
  const outputPath = path.join(dir, "chunk-1.xml");

  const result = await generateSitemapChunk({
    outputPath,
    urls: [
      { loc: "https://example.com/a", lastmod: "2026-09-29" },
      { loc: "https://example.com/b", lastmod: null },
      { loc: "https://example.com/c?x=1&y=2", lastmod: "2026-09-29" }
    ]
  });

  assert.equal(result.writtenCount, 3);

  const contents = readFileSync(outputPath, "utf8");
  const urlBlocks = [...contents.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(
    (match) => match[1]
  );

  assert.equal(urlBlocks.length, 3);
  assert.match(urlBlocks[0], /<loc>https:\/\/example\.com\/a<\/loc>/);
  assert.match(urlBlocks[0], /<lastmod>2026-09-29<\/lastmod>/);
  assert.doesNotMatch(urlBlocks[1], /<lastmod>/);
  assert.match(urlBlocks[2], /<loc>https:\/\/example\.com\/c\?x=1&amp;y=2<\/loc>/);

  assert.match(contents, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(contents, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(contents.trimEnd(), /<\/urlset>$/);
});

test("writes a valid empty <urlset> for zero URLs", async () => {
  const outputPath = path.join(dir, "chunk-empty.xml");

  const result = await generateSitemapChunk({ outputPath, urls: [] });

  assert.equal(result.writtenCount, 0);
  assert.doesNotMatch(readFileSync(outputPath, "utf8"), /<url>/);
});
