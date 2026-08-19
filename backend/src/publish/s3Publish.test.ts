import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { S3Client } from "@aws-sdk/client-s3";

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
import {
  buildPublishIndexXml,
  executePublish,
  PublishAbortedError,
  PublishFileError,
  uploadFailureTolerance,
  type PublishPlan
} from "./s3Publish.js";

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

// ---- Silent-success guards -------------------------------------------------
//
// These cover the two ways a publish could previously report success while
// leaving production wrong. Both refuse BEFORE constructing an S3 client, so
// they need no credentials and no network.

function planWith(overrides: Partial<PublishPlan>): PublishPlan {
  return {
    domain: "airpartshop.com",
    publicHost: "airpartshop.com",
    prefix: "sites/airpartshop.com/sitemaps/",
    files: [
      { displayName: "a.xml", localPath: "/tmp/a.xml", size: 10 }
    ],
    indexFilename: "sitemap-index.xml",
    omittedDeleted: [],
    missingLocal: [],
    ...overrides
  };
}

// A live file whose bytes are gone used to be dropped from the plan silently —
// so it was ALSO dropped from the regenerated index (de-indexing live URLs)
// while the publish reported success with a count nobody could check. Session
// uploads are deleted an hour after completion, so this is the normal state of
// any session published the next day.
test("executePublish refuses when a live file's content is missing from disk", async () => {
  await assert.rejects(
    () =>
      executePublish(
        planWith({ missingLocal: ["manufacturers.xml", "products-2.xml"] }),
        { today: "2026-07-29" }
      ),
    (error: Error) => {
      assert.match(error.message, /Refusing to publish/);
      // The user has to know WHICH files and WHY, not just that it failed.
      assert.match(error.message, /manufacturers\.xml/);
      assert.match(error.message, /deleted an hour after/);

      return true;
    }
  );
});

// With every child file skipped, the only PUT was a regenerated index with zero
// <sitemap> entries, landing on top of the live one — reported as
// "Published 1 file(s)" because the index counts toward `uploaded`.
test("executePublish refuses to write an empty index when no files resolved", async () => {
  await assert.rejects(
    () => executePublish(planWith({ files: [] }), { today: "2026-07-29" }),
    /EMPTY sitemap index/
  );
});

// A mid-publish failure leaves the first N objects overwritten in a bucket with
// no versioning AND the index not updated. The bare SDK error says none of that,
// so the wrapper carries the partial state into the message the user sees.
test("PublishFileError reports how far the publish got", () => {
  const error = new PublishFileError({
    key: "sites/airpartshop.com/sitemaps/products-500.xml",
    uploadedBefore: 499,
    plannedTotal: 1600,
    cause: new Error("AccessDenied")
  });

  assert.match(error.message, /products-500\.xml/);
  assert.match(error.message, /file 500 of 1600/);
  assert.match(error.message, /AccessDenied/);
  // The partial-overwrite warning is the operationally important half.
  assert.match(error.message, /499 object\(s\) were already overwritten/);
  assert.match(error.message, /index was NOT updated/);
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

// ---- Partial-failure handling ---------------------------------------------
//
// The failure these cover, in full: a 2,650-sitemap publish for nsn360.com wrote
// every object AND the regenerated index successfully, then had its CloudFront
// invalidation rejected ("Your request contains one or more invalid invalidation
// paths"). Because that call was an uncaught await, the error escaped
// executePublish, the job was marked failed, publish_runs was stamped FAILED with
// no upload count, and the UI showed a red "Publish failed" for a publish where
// everything had shipped. The obvious remedy (re-upload 8 GB) was the wrong one.
//
// The clients are injected stubs, so these exercise the real control flow with no
// AWS and no credentials.

type SentCommand = { name: string; key?: string; body?: unknown; paths?: string[] };

// A stub S3 client. failFor says which keys fail and HOW MANY TIMES, so a
// transient failure that succeeds on retry stays distinguishable from a permanent
// one. existingKeys backs HeadObject.
function stubS3(
  options: {
    failFor?: Record<string, number>;
    existingKeys?: string[];
  } = {}
) {
  const remainingFailures = { ...(options.failFor ?? {}) };
  const existing = new Set(options.existingKeys ?? []);
  const sent: SentCommand[] = [];
  const bodies: Record<string, unknown> = {};

  const client = new S3Client({ region: "us-east-1" });

  client.send = (async (command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) => {
    const name = command.constructor.name;
    const key = command.input.Key as string;

    if (name === "HeadObjectCommand") {
      sent.push({ name, key });

      if (existing.has(key)) {
        return {};
      }

      const error = new Error("Not Found");

      error.name = "NotFound";
      throw error;
    }

    if (remainingFailures[key] && remainingFailures[key] > 0) {
      remainingFailures[key] -= 1;
      sent.push({ name: name + ":failed", key });
      throw new Error("AccessDenied");
    }

    // The body is captured so a retry that re-sent a CONSUMED stream (zero bytes)
    // is detectable — that would overwrite a live sitemap with nothing.
    bodies[key] = command.input.Body;
    sent.push({ name, key, body: command.input.Body });

    return {};
  }) as typeof client.send;

  client.destroy = () => {};

  return { client, sent, bodies };
}

// A stub CloudFront client. throws rejects exactly the way the real one did.
function stubCloudFront(options: { throws?: boolean } = {}) {
  const sent: SentCommand[] = [];
  const client = new CloudFrontClient({ region: "us-east-1" });

  client.send = (async (command: {
    constructor: { name: string };
    input: { InvalidationBatch?: { Paths?: { Items?: string[] } } };
  }) => {
    sent.push({
      name: command.constructor.name,
      paths: command.input.InvalidationBatch?.Paths?.Items ?? []
    });

    if (options.throws) {
      const error = new Error(
        "Your request contains one or more invalid invalidation paths."
      );

      error.name = "InvalidArgument";
      throw error;
    }

    return { Invalidation: { Id: "I" + sent.length } };
  }) as typeof client.send;

  client.destroy = () => {};

  return { client, sent };
}

const PREFIX = "sites/airpartshop.com/sitemaps/";

// Real files on disk, because putObjectWithRetry streams from the filesystem and
// the retry behaviour under test is precisely about re-opening those streams.
async function planOnDisk(count: number) {
  const dir = await mkdtemp(path.join(tmpdir(), "publish-test-"));
  const files = [];

  for (let index = 0; index < count; index += 1) {
    const displayName = "f" + index + ".xml";
    const localPath = path.join(dir, displayName);
    const body = "<urlset><!-- " + displayName + " --></urlset>";

    await writeFile(localPath, body, "utf8");
    files.push({ displayName, localPath, size: Buffer.byteLength(body) });
  }

  return { dir, plan: planWith({ files }) };
}

// THE bug. Uploads all succeed, CloudFront rejects — the publish must REPORT
// that, not throw. Every assertion here is a fact the old code got wrong.
test("a rejected CloudFront invalidation does not fail a publish whose objects are written", async () => {
  const { dir, plan } = await planOnDisk(3);
  const saved = config.cloudfrontDistributionId;

  try {
    config.cloudfrontDistributionId = "E123456789";

    const s3 = stubS3();
    const cloudfront = stubCloudFront({ throws: true });

    // Does not reject. That is the fix.
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: s3.client, cloudfront: cloudfront.client }
    });

    // All 3 children plus the regenerated index really were written.
    assert.equal(result.uploaded, 4);
    assert.equal(result.failed_files.length, 0);
    assert.ok(result.written_keys.includes(PREFIX + "sitemap-index.xml"));

    // And the CDN failure is reported as a warning carrying the real reason.
    assert.notEqual(result.invalidation.error, null);
    assert.match(result.invalidation.error ?? "", /invalid invalidation paths/);
    assert.equal(result.invalidation.batches_failed, 1);
    assert.deepEqual(result.invalidation.invalidation_ids, []);
    assert.equal(result.invalidation_id, null);
  } finally {
    config.cloudfrontDistributionId = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

// The second invalidation defect: it sent S3 KEYS as CDN paths, so it purged
// paths the distribution does not serve even when CloudFront accepted them.
test("invalidation requests the served paths, not the S3 keys", async () => {
  const { dir, plan } = await planOnDisk(2);
  const saved = config.cloudfrontDistributionId;

  try {
    config.cloudfrontDistributionId = "E123456789";

    const cloudfront = stubCloudFront();
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: stubS3().client, cloudfront: cloudfront.client }
    });

    const paths = cloudfront.sent.flatMap((command) => command.paths ?? []);

    assert.deepEqual(paths.sort(), [
      "/sitemaps/f0.xml",
      "/sitemaps/f1.xml",
      "/sitemaps/sitemap-index.xml"
    ]);
    // The storage prefix belongs in the KEYS and never in the paths.
    assert.ok(
      paths.every((invalidated) => !invalidated.includes("/sites/")),
      "an invalidation path must not contain the S3 key prefix"
    );
    assert.equal(result.invalidation.strategy, "exact");
    assert.equal(result.invalidation_id, "I1");
  } finally {
    config.cloudfrontDistributionId = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

// Above the threshold one scoped wildcard replaces thousands of exact paths:
// CloudFront caps a request at 3,000 and bills per path beyond 1,000/month.
test("a large publish invalidates one scoped wildcard, never the whole distribution", async () => {
  const { dir, plan } = await planOnDisk(5);
  const saved = {
    id: config.cloudfrontDistributionId,
    threshold: config.cloudfrontWildcardThreshold
  };

  try {
    config.cloudfrontDistributionId = "E123456789";
    config.cloudfrontWildcardThreshold = 2;

    const cloudfront = stubCloudFront();
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: stubS3().client, cloudfront: cloudfront.client }
    });

    assert.equal(result.invalidation.strategy, "wildcard");
    assert.equal(cloudfront.sent.length, 1, "one request, not one per file");
    assert.deepEqual(cloudfront.sent[0].paths, ["/sitemaps/*"]);
    // 6 files would have been 6 billable paths; the wildcard is 1.
    assert.equal(result.invalidation.paths_requested, 1);

    // The property that protects every OTHER client site on the shared
    // distribution.
    assert.ok(
      !(cloudfront.sent[0].paths ?? []).includes("/*"),
      "a publish must never purge the whole distribution"
    );
  } finally {
    config.cloudfrontDistributionId = saved.id;
    config.cloudfrontWildcardThreshold = saved.threshold;
    await rm(dir, { recursive: true, force: true });
  }
});

// The user-facing ask: 2 or 3 bad files must not strand the other 2,647.
test("a file that cannot be uploaded is skipped and reported, not fatal", async () => {
  const { dir, plan } = await planOnDisk(4);

  try {
    // Permanent failure: more attempts than the retry budget.
    const failFor: Record<string, number> = {};

    failFor[PREFIX + "f2.xml"] = 99;

    const s3 = stubS3({ failFor });
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: s3.client, cloudfront: stubCloudFront().client }
    });

    // 3 of 4 children plus the index.
    assert.equal(result.uploaded, 4);
    assert.equal(result.failed_files.length, 1);
    assert.equal(result.failed_files[0].filename, "f2.xml");
    assert.match(result.failed_files[0].reason, /AccessDenied/);

    // The index PUT still happened — the publish completed.
    assert.ok(result.written_keys.includes(PREFIX + "sitemap-index.xml"));

    // Retried before giving up: 1 initial attempt + 2 retries.
    assert.equal(
      s3.sent.filter((command) => command.name === "PutObjectCommand:failed").length,
      3
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The sharpest edge in the retry path. A Node read stream cannot be replayed, so
// retrying with the handle from the failed attempt would PUT an empty body —
// silently overwriting a live sitemap with a zero-byte object, in a bucket with
// no versioning. Each attempt must open its own stream.
test("a transient upload failure retries from a fresh stream and writes real bytes", async () => {
  const { dir, plan } = await planOnDisk(2);

  try {
    // Fails once, then succeeds — the retry is what completes it.
    const failFor: Record<string, number> = {};

    failFor[PREFIX + "f1.xml"] = 1;

    const s3 = stubS3({ failFor });
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: s3.client, cloudfront: stubCloudFront().client }
    });

    assert.equal(result.failed_files.length, 0, "the retry must have succeeded");
    assert.equal(result.uploaded, 3);

    // The body that landed must be an UNREAD stream carrying the real file, not
    // the consumed handle from the failed attempt.
    const body = s3.bodies[PREFIX + "f1.xml"] as {
      bytesRead?: number;
      path?: string;
    };

    assert.ok(body, "the retried PUT must have sent a body");
    assert.equal(body.bytesRead, 0, "the retry must send a stream nothing has read yet");
    assert.match(String(body.path), /f1\.xml$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A failed file whose object is ALREADY live must keep its index entry. Dropping
// it would de-index live URLs over a transient upload error — the same failure the
// missingLocal guard above exists to prevent.
test("a failed file keeps its index entry when an older object is still live", async () => {
  const { dir, plan } = await planOnDisk(3);

  try {
    const failFor: Record<string, number> = {};

    failFor[PREFIX + "f1.xml"] = 99;

    // f1 exists from a previous publish.
    const s3 = stubS3({ failFor, existingKeys: [PREFIX + "f1.xml"] });
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: s3.client, cloudfront: stubCloudFront().client }
    });

    assert.equal(result.failed_files[0].still_indexed, true);

    // And it really is in the regenerated index that was written.
    const indexBody = String(s3.bodies[PREFIX + "sitemap-index.xml"]);

    assert.ok(indexBody.includes("/sitemaps/f1.xml"), "a live object must stay indexed");
    assert.equal((indexBody.match(/<sitemap>/g) ?? []).length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The other half of that rule: a file that is not on production at all must NOT be
// indexed, or the index points at a 404.
test("a failed file with no live object is dropped from the index and reported", async () => {
  const { dir, plan } = await planOnDisk(3);

  try {
    const failFor: Record<string, number> = {};

    failFor[PREFIX + "f1.xml"] = 99;

    const s3 = stubS3({ failFor, existingKeys: [] });
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: s3.client, cloudfront: stubCloudFront().client }
    });

    assert.equal(result.failed_files[0].still_indexed, false);

    const indexBody = String(s3.bodies[PREFIX + "sitemap-index.xml"]);

    assert.ok(!indexBody.includes("/sitemaps/f1.xml"), "a 404 must not be indexed");
    assert.equal((indexBody.match(/<sitemap>/g) ?? []).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Past the tolerance it is a credential/policy/network problem, not bad files, and
// grinding through the rest just delays the error and maximizes the mixed state.
test("failures over the tolerance abort the publish instead of carrying on", async () => {
  const { dir, plan } = await planOnDisk(60);

  try {
    // Every PUT fails: a revoked role, not 60 individually bad files.
    const failFor: Record<string, number> = {};

    for (let index = 0; index < 60; index += 1) {
      failFor[PREFIX + "f" + index + ".xml"] = 99;
    }

    const s3 = stubS3({ failFor });

    await assert.rejects(
      () =>
        executePublish(plan, {
          today: "2026-08-19",
          clients: { s3: s3.client, cloudfront: stubCloudFront().client }
        }),
      (error: Error) => {
        assert.ok(error instanceof PublishAbortedError);
        assert.match(error.message, /Publish aborted/);
        // The operationally important half: what state production is in.
        assert.match(error.message, /index was NOT updated/);
        assert.match(error.message, /credential, bucket-policy or network/);

        return true;
      }
    );

    // Stopped at the tolerance (10 for 60 files) rather than attempting all 60.
    assert.equal(uploadFailureTolerance(60), 10);
    assert.equal(
      s3.sent.filter((command) => command.name === "PutObjectCommand:failed").length,
      33,
      "11 files attempted (tolerance + 1), 3 attempts each — not 60"
    );

    // The index must never have been written.
    assert.equal(
      s3.sent.some((command) => (command.key ?? "").endsWith("sitemap-index.xml")),
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The tolerance shape: a floor so one flaky PUT cannot abort a small session, and
// a percentage so a large one cannot fail by the hundred.
test("the upload failure tolerance is a floor of 10 and 2% above that", () => {
  assert.equal(uploadFailureTolerance(1), 10);
  assert.equal(uploadFailureTolerance(100), 10);
  assert.equal(uploadFailureTolerance(2650), 53);
});

// Every file failing must never write an index of only-stale (or zero) entries
// over the live one — the silent-success failure this module refuses everywhere.
test("a publish where every file fails aborts rather than writing a stale index", async () => {
  const { dir, plan } = await planOnDisk(3);

  try {
    const failFor: Record<string, number> = {};

    failFor[PREFIX + "f0.xml"] = 99;
    failFor[PREFIX + "f1.xml"] = 99;
    failFor[PREFIX + "f2.xml"] = 99;

    const s3 = stubS3({ failFor, existingKeys: [PREFIX + "f0.xml"] });

    await assert.rejects(
      () =>
        executePublish(plan, {
          today: "2026-08-19",
          clients: { s3: s3.client, cloudfront: stubCloudFront().client }
        }),
      PublishAbortedError
    );

    assert.equal(
      s3.sent.some((command) => (command.key ?? "").endsWith("sitemap-index.xml")),
      false
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// With no distribution configured the stage is skipped cleanly — not an error, and
// not a silent claim that caches were purged.
test("no CloudFront distribution means a skipped invalidation, not a failure", async () => {
  const { dir, plan } = await planOnDisk(2);
  const saved = config.cloudfrontDistributionId;

  try {
    config.cloudfrontDistributionId = "";

    const cloudfront = stubCloudFront();
    const result = await executePublish(plan, {
      today: "2026-08-19",
      clients: { s3: stubS3().client, cloudfront: cloudfront.client }
    });

    assert.equal(result.invalidation.strategy, "skipped");
    assert.equal(result.invalidation.error, null);
    assert.equal(result.invalidation_id, null);
    assert.equal(cloudfront.sent.length, 0);
    assert.equal(result.uploaded, 3, "the publish itself is unaffected");
  } finally {
    config.cloudfrontDistributionId = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
