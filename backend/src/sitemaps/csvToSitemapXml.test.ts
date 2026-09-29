import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { peekRootElement } from "./peek.js";
import { writeSyntheticSitemapXml } from "./csvToSitemapXml.js";

function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "csv-to-sitemap-xml-test-"));

  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function unescapeXml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("writes a valid <urlset> with one <loc> per URL, in order", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "synthetic.xml");
    const urls = [
      "https://example.com/a",
      "https://example.com/b?x=1&y=2",
      "https://example.com/c"
    ];

    await writeSyntheticSitemapXml(urls, outPath);

    assert.equal(await peekRootElement(outPath), "urlset");

    const contents = readFileSync(outPath, "utf8");
    const seen = [...contents.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) =>
      unescapeXml(match[1])
    );

    assert.deepEqual(seen, urls);
  });
});

test("escapes XML-significant characters in the URL", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "synthetic.xml");

    await writeSyntheticSitemapXml(
      ['https://example.com/a?x=1&y=2&q="quoted"'],
      outPath
    );

    const contents = readFileSync(outPath, "utf8");

    assert.match(contents, /&amp;/);
    assert.match(contents, /&quot;/);
    assert.doesNotMatch(contents.replace(/<\?xml.*?\?>\n/, ""), /&(?!amp;|quot;|lt;|gt;)/);
  });
});
