import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import fileRewrite from "./fileRewriteWorker.js";
import {
  rewriteSitemapLocFile,
  type LocUrlRewriter
} from "../sitemaps/rewriteLocs.js";
import { parseStructure, transformUrl } from "../sitemaps/transformStructure.js";

// The pattern structure transform crosses a worker-thread boundary, and its
// rewriter is a closure over two ParsedStructures that cannot be cloned. The
// worker rebuilds it from the raw structure STRINGS instead. That is only safe
// if the rebuild is exactly equivalent — so this asserts byte-for-byte equality
// against the inline path rather than merely "it produced some output".

const dirs: string[] = [];

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "pattern-rewrite-"));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.com/manufacturer/jamco-parts-catalog/widget-1</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc><![CDATA[https://site.com/manufacturer/acme-parts-catalog/widget-2]]></loc></url>
  <url><loc>https://site.com/manufacturer/nomatch/widget-3?a=1&amp;b=2</loc></url>
  <url><loc>https://site.com/other/left-alone</loc></url>
</urlset>
`;

const CURRENT = "/manufacturer/{A}/{B}";
const NEXT = "/manufacturer/{A|-parts-catalog||}/{B}/";

test("worker rebuild produces BYTE-IDENTICAL output to the inline rewriter", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "sitemap.xml");
  const inlineOut = path.join(dir, "inline.xml");
  const workerOut = path.join(dir, "worker.xml");

  await writeFile(input, SITEMAP, "utf-8");

  const current = parseStructure(CURRENT);
  const next = parseStructure(NEXT);
  const inlineRewriter: LocUrlRewriter = (url) =>
    transformUrl(url, current, next);

  const inlineCount = await rewriteSitemapLocFile({
    inputPath: input,
    outputPath: inlineOut,
    isGzip: false,
    rewriteUrl: inlineRewriter
  });

  const workerResult = await fileRewrite({
    inputPath: input,
    outputPath: workerOut,
    isGzip: false,
    spec: {
      kind: "patternStructure",
      currentStructure: CURRENT,
      nextStructure: NEXT
    }
  });

  // Assert the fixture actually exercised the rewriter. Without this, both
  // sides could be "unchanged" and the equality below would pass for the wrong
  // reason.
  assert.ok(inlineCount > 0, "fixture rewrote nothing — the test proves nothing");
  assert.equal(workerResult.rewrittenCount, inlineCount);

  const [inlineBytes, workerBytes] = await Promise.all([
    readFile(inlineOut),
    readFile(workerOut)
  ]);

  assert.ok(inlineBytes.equals(workerBytes), "worker output differs from inline");
});

test("worker leaves non-matching <loc> values untouched", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "sitemap.xml");
  const output = path.join(dir, "out.xml");

  await writeFile(input, SITEMAP, "utf-8");
  await fileRewrite({
    inputPath: input,
    outputPath: output,
    isGzip: false,
    spec: {
      kind: "patternStructure",
      currentStructure: CURRENT,
      nextStructure: NEXT
    }
  });

  const text = await readFile(output, "utf-8");

  assert.ok(text.includes("https://site.com/other/left-alone"));
  assert.ok(text.includes("<lastmod>2026-01-01</lastmod>"));
});

test("a malformed structure REJECTS instead of silently rewriting nothing", async () => {
  const dir = await tempDir();
  const input = path.join(dir, "sitemap.xml");

  await writeFile(input, SITEMAP, "utf-8");

  await assert.rejects(
    fileRewrite({
      inputPath: input,
      outputPath: path.join(dir, "out.xml"),
      isGzip: false,
      spec: {
        kind: "patternStructure",
        currentStructure: "/manufacturer/{A",
        nextStructure: NEXT
      }
    })
  );
});
