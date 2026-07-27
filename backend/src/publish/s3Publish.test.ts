import assert from "node:assert/strict";
import { test } from "node:test";

import { s3PrefixForDomain } from "../config.js";
import { assertSafeDomain } from "../sftp/sftpClient.js";
import { buildPublishIndexXml } from "./s3Publish.js";

// Pure logic of the publish path — no AWS calls, so this runs anywhere.

test("assertSafeDomain rejects anything that could escape the SFTP base path", () => {
  // Domains come from user input and are interpolated into a remote path.
  for (const bad of ["", "../etc", "a/b", "a\\b", "..", "foo/../../etc"]) {
    assert.throws(
      () => assertSafeDomain(bad),
      /Invalid domain/,
      `must reject ${JSON.stringify(bad)}`
    );
  }

  for (const good of ["airpartshop.com", "www.acquireelectrical.com"]) {
    assert.doesNotThrow(() => assertSafeDomain(good));
  }
});

test("s3PrefixForDomain fills the template and always ends in a slash", () => {
  assert.equal(
    s3PrefixForDomain("airpartshop.com"),
    "sites/airpartshop.com/sitemaps/"
  );
});

test("the regenerated index lists exactly the published files", () => {
  const xml = buildPublishIndexXml(
    "airpartshop.com",
    "sites/airpartshop.com/sitemaps/",
    ["aviation-mfg47.xml", "civil-aviation-rfq-with-aircraft-model-52.xml"],
    "2026-07-27"
  );

  assert.equal((xml.match(/<sitemap>/g) ?? []).length, 2);
  assert.ok(
    xml.includes(
      "https://airpartshop.com/sites/airpartshop.com/sitemaps/aviation-mfg47.xml"
    )
  );
  assert.ok(xml.includes("<lastmod>2026-07-27</lastmod>"));
  assert.ok(xml.trimEnd().endsWith("</sitemapindex>"));
});

// A file deleted in-session must vanish from the index — that is the ONLY
// mechanism by which a removal reaches production. Publish never issues
// DeleteObject (no bucket versioning => a wrong delete is unrecoverable), so
// the orphaned object stays put, unreferenced.
test("a file omitted from the plan drops out of the regenerated index", () => {
  const before = buildPublishIndexXml(
    "airpartshop.com",
    "sites/airpartshop.com/sitemaps/",
    ["a.xml", "deleted.xml", "b.xml"],
    "2026-07-27"
  );
  const after = buildPublishIndexXml(
    "airpartshop.com",
    "sites/airpartshop.com/sitemaps/",
    ["a.xml", "b.xml"],
    "2026-07-27"
  );

  assert.ok(before.includes("deleted.xml"));
  assert.ok(!after.includes("deleted.xml"));
  assert.equal((after.match(/<sitemap>/g) ?? []).length, 2);
});
