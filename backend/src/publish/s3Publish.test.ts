import assert from "node:assert/strict";
import { test } from "node:test";

import { s3PrefixForDomain } from "../config.js";
import { assertSafeDomain } from "../sftp/sftpClient.js";
import { productionFilename } from "../sitemaps/filenames.js";
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

// The object key must be the CLIENT's filename. displaySourceFilename keeps the
// source-role segment ("current-") that buildStoredUploadFilename adds — that
// prefix is ours, not the client's, and publishing it would create a second
// wrongly-named object beside the real one while leaving the live file stale.
test("productionFilename strips our internal prefixes, including the role", () => {
  const sid = "bbbbbbbb-cccc-4ddd-8eee-000000000001";

  // Plain upload.
  assert.equal(
    productionFilename(sid, `${sid}-current-aviation-mfg47.xml`),
    "aviation-mfg47.xml"
  );

  // Copy-on-write edit: fixed-<hex>- marker AND the role must both go.
  assert.equal(
    productionFilename(sid, `${sid}-fixed-9f2ab31c-current-aviation-mfg47.xml`),
    "aviation-mfg47.xml"
  );

  // Other mutation markers behave the same.
  assert.equal(
    productionFilename(sid, `${sid}-transformed-abc123-current-a.xml.gz`),
    "a.xml.gz"
  );

  // Legacy-role files resolve too.
  assert.equal(
    productionFilename(sid, `${sid}-legacy-old-sitemap.xml`),
    "old-sitemap.xml"
  );

  // An edited copy and its original must resolve to the SAME production name —
  // otherwise a fix would publish under a new key and orphan the live file.
  assert.equal(
    productionFilename(sid, `${sid}-fixed-deadbeef-current-x.xml`),
    productionFilename(sid, `${sid}-current-x.xml`)
  );
});
