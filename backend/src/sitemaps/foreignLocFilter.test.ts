import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { streamSitemapWithoutForeignLocs } from "./foreignLocFilter.js";

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

const MIXED = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://industrialsurge.com/parts/a</loc></url>
  <url><loc>https://industrialautomationpartsworld.com/parts/x</loc></url>
  <url><loc>https://shop.industrialsurge.com/parts/b</loc></url>
  <url><loc>https://industrialautomationpartsworld.com/parts/y</loc></url>
  <url><loc>https://www.industrialsurge.com/parts/c</loc></url>
</urlset>
`;

async function writeTemp(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "foreignloc-"));
  const file = path.join(dir, "sitemap.xml");

  await writeFile(file, contents, "utf8");

  return file;
}

test("drops foreign-domain <url> blocks, keeps same-site and subdomain locs", async () => {
  const inputPath = await writeTemp(MIXED);
  const output = await collect(
    streamSitemapWithoutForeignLocs({
      inputPath,
      isGzip: false,
      expectedHost: "industrialsurge.com"
    })
  );

  // Same-site + subdomain + www kept.
  assert.match(output, /industrialsurge\.com\/parts\/a/);
  assert.match(output, /shop\.industrialsurge\.com\/parts\/b/);
  assert.match(output, /www\.industrialsurge\.com\/parts\/c/);
  // Foreign domain dropped entirely.
  assert.doesNotMatch(output, /industrialautomationpartsworld\.com/);
  // Kept exactly 3 <url> blocks.
  assert.equal(output.match(/<url>/g)?.length, 3);
  // Structure preserved.
  assert.match(output, /<\/urlset>/);
});

test("passes a fully same-site file through unchanged", async () => {
  const clean = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://industrialsurge.com/a</loc></url>
  <url><loc>https://industrialsurge.com/b</loc></url>
</urlset>
`;
  const inputPath = await writeTemp(clean);
  const output = await collect(
    streamSitemapWithoutForeignLocs({
      inputPath,
      isGzip: false,
      expectedHost: "industrialsurge.com"
    })
  );

  assert.equal(output.match(/<url>/g)?.length, 2);
  assert.doesNotMatch(output, /dropped/);
});
