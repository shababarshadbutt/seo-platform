import assert from "node:assert/strict";
import { createGzip } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { test } from "node:test";

// config.ts reads the environment at import time, so both directories have to
// exist before the module under test is pulled in — hence the dynamic import
// below rather than a static one.
const exportDir = mkdtempSync(path.join(os.tmpdir(), "transform-sample-"));
const workDir = mkdtempSync(path.join(os.tmpdir(), "transform-sample-in-"));

process.env.EXPORT_DIR = exportDir;

const {
  buildTransformSampleFile,
  isTransformSampleName,
  transformSamplePath,
  TRANSFORM_SAMPLE_LIMIT
} = await import("./transformSampleFile.js");
const { parseStructure, transformUrl } = await import("./transformStructure.js");

function sitemapXml(urls: string[]): string {
  const body = urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${body}\n</urlset>\n`;
}

// 25 in-pattern URLs plus 3 that the structure must leave alone, so "rewritten"
// and "totalLocs" cannot be accidentally equal.
const MATCHING = Array.from(
  { length: 25 },
  (_, index) => `https://x.com/nspart/part-${700 + index}/`
);
const FOREIGN = [
  "https://x.com/other/thing/",
  "https://x.com/nspart/a/b/",
  "https://x.com/blog/"
];

const current = parseStructure("/nspart/{A}/");
const next = parseStructure("/nsnpart/{A|split|6|-|}/");
const rewriteUrl = (url: string) => transformUrl(url, current, next);

test("builds a corrected copy without touching the input", () => {
  const inputPath = path.join(workDir, "sitemap-1.xml");
  const original = sitemapXml([...MATCHING, ...FOREIGN]);

  writeFileSync(inputPath, original, "utf8");

  return buildTransformSampleFile({
    sessionId: "11111111-1111-1111-1111-111111111111",
    inputPath,
    isGzip: false,
    rewriteUrl
  }).then((result) => {
    // The input is the thing this feature promises not to change.
    assert.equal(readFileSync(inputPath, "utf8"), original);

    assert.equal(result.totalLocs, MATCHING.length + FOREIGN.length);
    assert.equal(result.rewritten, MATCHING.length);
    assert.equal(result.samples.length, TRANSFORM_SAMPLE_LIMIT);
    assert.deepEqual(result.samples[0], {
      before: "https://x.com/nspart/part-700/",
      after: "https://x.com/nsnpart/part-7-00/"
    });

    const written = readFileSync(
      path.join(exportDir, result.storedName),
      "utf8"
    );

    // Every matching URL is rewritten in the copy, not just the sampled ten.
    for (const url of MATCHING) {
      assert.ok(
        !written.includes(`<loc>${url}</loc>`),
        `${url} should have been rewritten in the sample file`
      );
    }

    // And everything outside the structure is preserved byte-for-byte.
    for (const url of FOREIGN) {
      assert.ok(
        written.includes(`<loc>${url}</loc>`),
        `${url} should have been left alone`
      );
    }

    assert.ok(result.bytes > 0);
  });
});

test("the sample lands in EXPORT_DIR and nowhere else", async () => {
  const inputPath = path.join(workDir, "sitemap-2.xml");

  writeFileSync(inputPath, sitemapXml(MATCHING), "utf8");

  const result = await buildTransformSampleFile({
    sessionId: "22222222-2222-2222-2222-222222222222",
    inputPath,
    isGzip: false,
    rewriteUrl
  });

  const entries = await readdir(exportDir);

  assert.ok(entries.includes(result.storedName));
  assert.ok(isTransformSampleName(result.storedName));

  // The working directory holds only what the test put there.
  const inputs = await readdir(workDir);

  assert.deepEqual(
    inputs.filter((name) => name.startsWith("transform-sample-")),
    []
  );
});

test("round-trips a gzipped sitemap", async () => {
  const inputPath = path.join(workDir, "sitemap-3.xml.gz");

  await pipeline(
    Readable.from([sitemapXml(MATCHING)]),
    createGzip(),
    createWriteStream(inputPath)
  );

  const result = await buildTransformSampleFile({
    sessionId: "33333333-3333-3333-3333-333333333333",
    inputPath,
    isGzip: true,
    rewriteUrl
  });

  assert.equal(result.rewritten, MATCHING.length);
  assert.ok(result.storedName.endsWith(".xml.gz"));
});

test("a file with no matching URLs yields a copy and no samples", async () => {
  const inputPath = path.join(workDir, "sitemap-4.xml");

  writeFileSync(inputPath, sitemapXml(FOREIGN), "utf8");

  const result = await buildTransformSampleFile({
    sessionId: "44444444-4444-4444-4444-444444444444",
    inputPath,
    isGzip: false,
    rewriteUrl
  });

  assert.equal(result.rewritten, 0);
  assert.deepEqual(result.samples, []);
});

// --- path resolution --------------------------------------------------------

test("transformSamplePath refuses ids that could climb out of EXPORT_DIR", () => {
  assert.equal(
    transformSamplePath("../../etc", "11111111-1111-1111-1111-111111111111", false),
    null
  );
  assert.equal(
    transformSamplePath("11111111-1111-1111-1111-111111111111", "../../etc/passwd", false),
    null
  );
  assert.equal(
    transformSamplePath("11111111-1111-1111-1111-111111111111", "not-a-token", false),
    null
  );
});

test("transformSamplePath resolves inside EXPORT_DIR for well-formed ids", () => {
  const resolved = transformSamplePath(
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    false
  );

  assert.ok(resolved);
  assert.equal(path.dirname(resolved as string), exportDir);
});

test("isTransformSampleName ignores unrelated exports", () => {
  assert.equal(isTransformSampleName("session-all-2026-01-01.zip"), false);
  assert.equal(isTransformSampleName("report.csv"), false);
  assert.equal(isTransformSampleName("transform-sample-a-b.xml"), true);
  assert.equal(isTransformSampleName("transform-sample-a-b.xml.gz"), true);
});
