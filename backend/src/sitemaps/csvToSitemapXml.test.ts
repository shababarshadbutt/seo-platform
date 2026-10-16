import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSyntheticSitemapXml } from "./csvToSitemapXml.js";

function unescapeXml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("builds a valid <urlset> with one <loc> per URL, in order", () => {
  const urls = [
    "https://example.com/a",
    "https://example.com/b?x=1&y=2",
    "https://example.com/c"
  ];

  const xml = buildSyntheticSitemapXml(urls);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset /);
  assert.match(xml, /<\/urlset>\n$/);

  const seen = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) =>
    unescapeXml(match[1])
  );

  assert.deepEqual(seen, urls);
});

test("escapes XML-significant characters in the URL", () => {
  const xml = buildSyntheticSitemapXml([
    'https://example.com/a?x=1&y=2&q="quoted"'
  ]);

  assert.match(xml, /&amp;/);
  assert.match(xml, /&quot;/);
  assert.doesNotMatch(
    xml.replace(/<\?xml.*?\?>\n/, ""),
    /&(?!amp;|quot;|lt;|gt;)/
  );
});

test("returns an empty <urlset> for an empty list", () => {
  const xml = buildSyntheticSitemapXml([]);

  assert.match(xml, /<urlset[^>]*>\s*<\/urlset>\n?$/);
});
