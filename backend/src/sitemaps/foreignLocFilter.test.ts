import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  lazyStreamSitemapWithoutForeignLocs,
  streamSitemapWithoutForeignLocs
} from "./foreignLocFilter.js";

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

test("lazy variant yields byte-identical output to the eager one", async () => {
  const inputPath = await writeTemp(MIXED);
  const eager = await collect(
    streamSitemapWithoutForeignLocs({
      inputPath,
      isGzip: false,
      expectedHost: "industrialsurge.com"
    })
  );
  const lazy = await collect(
    lazyStreamSitemapWithoutForeignLocs({
      inputPath,
      isGzip: false,
      expectedHost: "industrialsurge.com"
    })
  );

  assert.equal(lazy, eager);
});

test("lazy onComplete reports bytesOut and kept/removed counts", async () => {
  const inputPath = await writeTemp(MIXED); // 3 same-site + 2 foreign blocks
  const stats: {
    bytesOut: number;
    keptCount: number;
    removedCount: number;
  }[] = [];
  const output = await collect(
    lazyStreamSitemapWithoutForeignLocs({
      inputPath,
      isGzip: false,
      expectedHost: "industrialsurge.com",
      onComplete: (s) => stats.push(s)
    })
  );

  assert.equal(stats.length, 1);
  assert.equal(stats[0].keptCount, 3);
  assert.equal(stats[0].removedCount, 2);
  assert.equal(stats[0].bytesOut, Buffer.byteLength(output));
});

test("lazy variant does not open the file until first read", async () => {
  // Point at a path that does not exist. Eager creation errors as soon as the
  // pipeline is wired up; the lazy variant must stay silent until we read it.
  const missing = path.join(tmpdir(), "does-not-exist-abcdef", "sitemap.xml");
  const stream = lazyStreamSitemapWithoutForeignLocs({
    inputPath: missing,
    isGzip: false,
    expectedHost: "industrialsurge.com"
  });

  let erroredBeforeRead = false;
  stream.on("error", () => {
    erroredBeforeRead = true;
  });
  // Give any eager pipeline a tick to fail.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(erroredBeforeRead, false, "must not open the file before reading");

  // Reading now triggers the (failing) open; the error surfaces on the stream.
  await assert.rejects(collect(stream));
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
