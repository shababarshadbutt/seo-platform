import assert from "node:assert/strict";
import { test } from "node:test";

import {
  config,
  publicSitemapUrl,
  publishConfigError,
  readBooleanFlag,
  s3PrefixForDomain,
  sftpConfigError
} from "../config.js";
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

test("publicSitemapUrl fills the default template and is independent of the S3 key", () => {
  assert.equal(
    publicSitemapUrl("airpartshop.com", "aviation-mfg47.xml"),
    "https://airpartshop.com/sitemaps/aviation-mfg47.xml"
  );
});

// A {file}-less template yields a syntactically valid index whose every entry
// points at the same url — silent breakage, so the config gate rejects it.
// Mutates the live config and restores it; node:test runs a file's tests in
// order, so no other test observes the change.
test("publishConfigError rejects a template that would collapse every loc", () => {
  const saved = {
    enabled: config.awsPublishEnabled,
    region: config.s3.region,
    bucket: config.s3.bucket,
    template: config.publicSitemapUrlTemplate
  };

  try {
    // Get past the earlier gates so the template check is what we're reading —
    // including the AWS_PUBLISH_ENABLED flag, which is checked first.
    config.awsPublishEnabled = true;
    config.s3.region = "us-east-1";
    config.s3.bucket = "asap-cms-prod";

    config.publicSitemapUrlTemplate = "https://{domain}/sitemaps/";
    assert.match(publishConfigError() ?? "", /PUBLIC_SITEMAP_URL_TEMPLATE/);

    config.publicSitemapUrlTemplate = "https://{domain}/sitemaps/{file}";
    assert.equal(publishConfigError(), null);
  } finally {
    config.awsPublishEnabled = saved.enabled;
    config.s3.region = saved.region;
    config.s3.bucket = saved.bucket;
    config.publicSitemapUrlTemplate = saved.template;
  }
});

// AWS_PUBLISH_ENABLED gates BOTH features, and is checked before every other
// reason so a fully-configured deployment still refuses while the flag is off.
// This is what makes the hidden UI more than cosmetic.
test("AWS_PUBLISH_ENABLED=false refuses SFTP and publish even when fully configured", () => {
  const saved = {
    enabled: config.awsPublishEnabled,
    region: config.s3.region,
    bucket: config.s3.bucket,
    host: config.sftp.host,
    username: config.sftp.username
  };

  try {
    // Everything else valid: the flag alone must be the blocker.
    config.s3.region = "us-east-1";
    config.s3.bucket = "asap-cms-prod";
    config.sftp.host = "transfer.example.com";
    config.sftp.username = "svc";

    config.awsPublishEnabled = false;
    assert.match(publishConfigError() ?? "", /AWS_PUBLISH_ENABLED/);
    assert.match(sftpConfigError() ?? "", /AWS_PUBLISH_ENABLED/);

    // And with the flag on, the same config is usable — so the flag is the only
    // thing that changed, not some unrelated misconfiguration.
    config.awsPublishEnabled = true;
    assert.equal(publishConfigError(), null);
    assert.equal(sftpConfigError(), null);
  } finally {
    config.awsPublishEnabled = saved.enabled;
    config.s3.region = saved.region;
    config.s3.bucket = saved.bucket;
    config.sftp.host = saved.host;
    config.sftp.username = saved.username;
  }
});

// Default OFF is the deployment contract: DevOps takes this branch as-is and the
// unverified paths must not be live until the CloudFront + live-test gate passes.
test("AWS_PUBLISH_ENABLED defaults to off, and only the exact string 'true' enables it", () => {
  // Unset and empty both mean off — an env var present but blank (a common
  // compose/.env artefact) must not read as enabled.
  assert.equal(readBooleanFlag(undefined), false);
  assert.equal(readBooleanFlag(""), false);

  // Near-misses stay off rather than being generously interpreted.
  for (const raw of ["1", "TRUE", "True", "yes", "on", "false", " true"]) {
    assert.equal(readBooleanFlag(raw), false, `${JSON.stringify(raw)} must not enable`);
  }

  assert.equal(readBooleanFlag("true"), true);
});

test("the regenerated index lists exactly the published files", () => {
  const xml = buildPublishIndexXml(
    "airpartshop.com",
    ["aviation-mfg47.xml", "civil-aviation-rfq-with-aircraft-model-52.xml"],
    "2026-07-27"
  );

  assert.equal((xml.match(/<sitemap>/g) ?? []).length, 2);
  // The <loc> must be the PUBLIC url, not the S3 key path: the storage prefix
  // "sites/<domain>/sitemaps/" is behind CloudFront and must not leak into it.
  assert.ok(
    xml.includes("https://airpartshop.com/sitemaps/aviation-mfg47.xml"),
    "public loc must not contain the S3 key prefix"
  );
  assert.ok(
    !xml.includes("/sites/airpartshop.com/"),
    "storage layout must not appear in a public url"
  );
  assert.ok(xml.includes("<lastmod>2026-07-27</lastmod>"));
  assert.ok(xml.trimEnd().endsWith("</sitemapindex>"));
});

// The whole point of PUBLIC_SITEMAP_URL_TEMPLATE: if the real CloudFront mapping
// turns out to differ from the bucket layout, correcting it is one .env line.
// The S3 prefix is untouched by any of these — the builder never receives it.
test("the public loc follows the template, not the bucket layout", () => {
  const files = ["aviation-mfg47.xml"];

  // Served at the domain root, objects still under sites/<domain>/sitemaps/.
  assert.ok(
    buildPublishIndexXml(
      "airpartshop.com",
      files,
      "2026-07-27",
      "https://{domain}/{file}"
    ).includes("<loc>https://airpartshop.com/aviation-mfg47.xml</loc>")
  );

  // Served from a different subpath than the key's.
  assert.ok(
    buildPublishIndexXml(
      "airpartshop.com",
      files,
      "2026-07-27",
      "https://{domain}/sitemap-files/{file}"
    ).includes("<loc>https://airpartshop.com/sitemap-files/aviation-mfg47.xml</loc>")
  );

  // Served off a fixed CDN host that isn't the client domain at all.
  assert.ok(
    buildPublishIndexXml(
      "airpartshop.com",
      files,
      "2026-07-27",
      "https://cdn.example.net/sites/{domain}/sitemaps/{file}"
    ).includes(
      "<loc>https://cdn.example.net/sites/airpartshop.com/sitemaps/aviation-mfg47.xml</loc>"
    )
  );
});

// A file deleted in-session must vanish from the index — that is the ONLY
// mechanism by which a removal reaches production. Publish never issues
// DeleteObject (no bucket versioning => a wrong delete is unrecoverable), so
// the orphaned object stays put, unreferenced.
test("a file omitted from the plan drops out of the regenerated index", () => {
  const before = buildPublishIndexXml(
    "airpartshop.com",
    ["a.xml", "deleted.xml", "b.xml"],
    "2026-07-27"
  );
  const after = buildPublishIndexXml("airpartshop.com", ["a.xml", "b.xml"], "2026-07-27");

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
