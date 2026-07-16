import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { removeUrlBlocksFromFile } from "./deleteUrls.js";

let tmpDir: string;

before(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "deleteurls-"));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function run(input: string, targets: string[]) {
  const inputPath = path.join(tmpDir, `in-${Math.abs(hash(input))}.xml`);
  const outputPath = path.join(tmpDir, `out-${Math.abs(hash(input))}.xml`);

  await writeFile(inputPath, input, "utf8");

  const { removedCount: removed, keptCount } = await removeUrlBlocksFromFile({
    inputPath,
    outputPath,
    isGzip: false,
    targetUrls: targets
  });
  const output = await readFile(outputPath, "utf8");

  return { removed, keptCount, output };
}

// Cheap deterministic filename disambiguator (no Date.now / random needed).
function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
const FOOTER = "</urlset>\n";

function block(loc: string, extra = "") {
  return `  <url>\n    <loc>${loc}</loc>${extra}\n  </url>`;
}

describe("removeUrlBlocksFromFile", () => {
  test("removes a single matching url block and keeps the rest", async () => {
    const input = [
      HEADER,
      block("https://example.com/keep-1/"),
      block("https://example.com/delete-me/"),
      block("https://example.com/keep-2/"),
      FOOTER
    ].join("\n");

    const { removed, output } = await run(input, [
      "https://example.com/delete-me/"
    ]);

    assert.equal(removed, 1);
    assert.ok(!output.includes("delete-me"));
    assert.ok(output.includes("keep-1"));
    assert.ok(output.includes("keep-2"));
    // No orphaned blank line left where the block was.
    assert.ok(!/\n\s*\n\s*\n/.test(output), "should not leave double blank lines");
  });

  test("removes multiple targets and reports the count", async () => {
    const input = [
      HEADER,
      block("https://example.com/a/"),
      block("https://example.com/b/"),
      block("https://example.com/c/"),
      block("https://example.com/d/"),
      FOOTER
    ].join("\n");

    const { removed, output } = await run(input, [
      "https://example.com/a/",
      "https://example.com/c/"
    ]);

    assert.equal(removed, 2);
    assert.ok(!output.includes("/a/"));
    assert.ok(!output.includes("/c/"));
    assert.ok(output.includes("/b/"));
    assert.ok(output.includes("/d/"));
  });

  test("leaves the document unchanged when no target matches", async () => {
    const input = [HEADER, block("https://example.com/x/"), FOOTER].join("\n");
    const { removed, output } = await run(input, [
      "https://example.com/not-here/"
    ]);

    assert.equal(removed, 0);
    assert.equal(output, input);
  });

  test("matches a CDATA-wrapped loc", async () => {
    const input = [
      HEADER,
      "  <url>\n    <loc><![CDATA[https://example.com/cdata/]]></loc>\n  </url>",
      block("https://example.com/keep/"),
      FOOTER
    ].join("\n");

    const { removed, output } = await run(input, [
      "https://example.com/cdata/"
    ]);

    assert.equal(removed, 1);
    assert.ok(!output.includes("cdata"));
    assert.ok(output.includes("keep"));
  });

  test("matches a loc containing an XML entity", async () => {
    const input = [
      HEADER,
      block("https://example.com/search?a=1&amp;b=2"),
      block("https://example.com/keep/"),
      FOOTER
    ].join("\n");

    const { removed, output } = await run(input, [
      "https://example.com/search?a=1&b=2"
    ]);

    assert.equal(removed, 1);
    assert.ok(!output.includes("a=1&amp;b=2"));
  });

  test("preserves sibling <lastmod>/<priority> inside kept blocks", async () => {
    const input = [
      HEADER,
      block("https://example.com/keep/", "\n    <lastmod>2026-01-01</lastmod>"),
      block("https://example.com/drop/", "\n    <priority>0.5</priority>"),
      FOOTER
    ].join("\n");

    const { removed, output } = await run(input, [
      "https://example.com/drop/"
    ]);

    assert.equal(removed, 1);
    assert.ok(output.includes("<lastmod>2026-01-01</lastmod>"));
    assert.ok(!output.includes("<priority>0.5</priority>"));
  });

  test("handles a single-line (non-pretty-printed) document", async () => {
    const input =
      HEADER +
      "<url><loc>https://example.com/a/</loc></url>" +
      "<url><loc>https://example.com/b/</loc></url>" +
      FOOTER;

    const { removed, output } = await run(input, ["https://example.com/a/"]);

    assert.equal(removed, 1);
    assert.ok(!output.includes("/a/"));
    assert.ok(output.includes("<url><loc>https://example.com/b/</loc></url>"));
  });

  test("removes across many blocks in a large file (chunk boundaries)", async () => {
    const blocks = Array.from({ length: 5000 }, (_, i) =>
      block(`https://example.com/p-${i}/`)
    );
    const input = [HEADER, ...blocks, FOOTER].join("\n");
    const targets = [
      "https://example.com/p-0/",
      "https://example.com/p-2500/",
      "https://example.com/p-4999/"
    ];

    const { removed, keptCount, output } = await run(input, targets);

    assert.equal(removed, 3);
    assert.equal(keptCount, 4997);
    for (const t of targets) {
      const slug = t.replace("https://example.com", "").replace(/\//g, "");
      assert.ok(!output.includes(`<loc>${t}</loc>`), `${slug} should be gone`);
    }
    // 5000 - 3 kept blocks still present.
    assert.equal((output.match(/<url>/g) ?? []).length, 4997);
  });
});
