import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { S3Client } from "@aws-sdk/client-s3";

import { config, s3SourceRootPrefix, s3SourceConfigError } from "../config.js";
import {
  downloadS3Object,
  downloadS3Objects,
  listS3Domains,
  listS3SitemapObjects,
  S3OperationTimeoutError
} from "./s3SourceClient.js";

// Reading sitemaps back out of S3, with an injected stub client — the same seam
// s3Publish.test.ts uses, so these exercise the real control flow with no AWS and
// no credentials.
//
// The cases that matter most are the ones a live smoke test would NOT catch on a
// small bucket: pagination past 1,000 keys, and the zero-byte folder marker. Both
// are silent — they produce a plausible-looking short list rather than an error —
// and a session missing files publishes an index that de-indexes live URLs.

type ListPage = {
  Contents?: { Key?: string; Size?: number }[];
  CommonPrefixes?: { Prefix?: string }[];
  IsTruncated?: boolean;
  NextContinuationToken?: string;
};

// A stub S3 client that replays `pages` in order, one per ListObjectsV2 call, and
// serves `objects` for GetObject. Records every command so the test can assert on
// what was actually asked of S3.
function stubS3(
  options: {
    pages?: ListPage[];
    objects?: Record<string, string>;
    failFor?: string[];
  } = {}
) {
  const pages = options.pages ?? [];
  const objects = options.objects ?? {};
  const failFor = new Set(options.failFor ?? []);
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  let pageIndex = 0;

  const client = new S3Client({ region: "us-east-1" });

  client.send = (async (command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }) => {
    const name = command.constructor.name;

    sent.push({ name, input: command.input });

    if (name === "ListObjectsV2Command") {
      const page = pages[pageIndex] ?? {};

      pageIndex += 1;

      return page;
    }

    if (name === "GetObjectCommand") {
      const key = command.input.Key as string;

      if (failFor.has(key)) {
        throw new Error("AccessDenied");
      }

      return { Body: Readable.from([objects[key] ?? ""]) };
    }

    throw new Error(`unexpected command ${name}`);
  }) as typeof client.send;

  client.destroy = () => {};

  return { client, sent, listCalls: () => sent.filter((c) => c.name === "ListObjectsV2Command") };
}

test("s3SourceRootPrefix takes everything before {domain}", () => {
  assert.equal(s3SourceRootPrefix(), "sites/");
});

test("listS3Domains reads folder names from CommonPrefixes", async () => {
  const { client } = stubS3({
    pages: [
      {
        CommonPrefixes: [
          { Prefix: "sites/zeta.com/" },
          { Prefix: "sites/alpha.com/" }
        ]
      }
    ]
  });

  assert.deepEqual(await listS3Domains({ client }), [
    "alpha.com",
    "zeta.com"
  ]);
});

test("listS3Domains asks S3 for folders, not every object", async () => {
  const { client, listCalls } = stubS3({ pages: [{}] });

  await listS3Domains({ client });

  const [call] = listCalls();

  // Without Delimiter, S3 returns every object in the bucket and no
  // CommonPrefixes at all — the listing would come back empty while looking
  // perfectly healthy.
  assert.equal(call.input.Delimiter, "/");
  assert.equal(call.input.Prefix, "sites/");
  assert.equal(call.input.Bucket, config.s3.bucket);
});

test("listS3Domains follows every page", async () => {
  const { client, listCalls } = stubS3({
    pages: [
      {
        CommonPrefixes: [{ Prefix: "sites/one.com/" }],
        IsTruncated: true,
        NextContinuationToken: "token-1"
      },
      { CommonPrefixes: [{ Prefix: "sites/two.com/" }] }
    ]
  });

  assert.deepEqual(await listS3Domains({ client }), ["one.com", "two.com"]);
  assert.equal(listCalls()[1].input.ContinuationToken, "token-1");
});

test("listS3Domains drops a folder name that could escape the prefix", async () => {
  const { client } = stubS3({
    pages: [
      {
        CommonPrefixes: [
          { Prefix: "sites/../" },
          { Prefix: "sites/good.com/" }
        ]
      }
    ]
  });

  assert.deepEqual(await listS3Domains({ client }), ["good.com"]);
});

test("listS3SitemapObjects returns only real sitemap files", async () => {
  const { client } = stubS3({
    pages: [
      {
        Contents: [
          { Key: "sites/example.com/sitemaps/b.xml", Size: 20 },
          { Key: "sites/example.com/sitemaps/a.xml.gz", Size: 10 },
          // The folder marker the S3 console creates: key IS the prefix, zero
          // bytes. Ingesting it would add an unparseable empty sitemap.
          { Key: "sites/example.com/sitemaps/", Size: 0 },
          // Zero-byte sitemap — nothing to parse, and it would surface later as
          // a mystery parse failure rather than as a skipped file.
          { Key: "sites/example.com/sitemaps/empty.xml", Size: 0 },
          { Key: "sites/example.com/sitemaps/notes.txt", Size: 40 }
        ]
      }
    ]
  });

  assert.deepEqual(
    (await listS3SitemapObjects("example.com", { client })).map((o) => o.name),
    ["a.xml.gz", "b.xml"]
  );
});

test("listS3SitemapObjects normalizes the domain to one prefix", async () => {
  const { client, listCalls } = stubS3({ pages: [{}, {}] });

  await listS3SitemapObjects("WWW.Example.com", { client });
  await listS3SitemapObjects("example.com", { client });

  // www and non-www must select the SAME folder — publishing to a second,
  // www-prefixed prefix while production served the other one is the incident
  // publishTarget.ts documents.
  assert.equal(listCalls()[0].input.Prefix, "sites/example.com/sitemaps/");
  assert.equal(listCalls()[1].input.Prefix, "sites/example.com/sitemaps/");
});

test("listS3SitemapObjects follows every page", async () => {
  const { client } = stubS3({
    pages: [
      {
        Contents: [{ Key: "sites/e.com/sitemaps/p1.xml", Size: 5 }],
        IsTruncated: true,
        NextContinuationToken: "next"
      },
      { Contents: [{ Key: "sites/e.com/sitemaps/p2.xml", Size: 5 }] }
    ]
  });

  // A single unpaginated call returns the first 1,000 keys and looks entirely
  // successful; the session would silently hold a fraction of the domain.
  assert.deepEqual(
    (await listS3SitemapObjects("e.com", { client })).map((o) => o.name),
    ["p1.xml", "p2.xml"]
  );
});

test("listS3SitemapObjects rejects a domain that could escape the prefix", async () => {
  const { client } = stubS3({ pages: [{}] });

  await assert.rejects(
    () => listS3SitemapObjects("../other", { client }),
    /Invalid domain/
  );
});

test("downloadS3Object streams the body to disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s3-source-"));

  try {
    const { client } = stubS3({
      objects: { "sites/e.com/sitemaps/a.xml": "<urlset/>" }
    });
    const localPath = path.join(dir, "a.xml");

    await downloadS3Object("sites/e.com/sitemaps/a.xml", localPath, { client });

    assert.equal(await readFile(localPath, "utf8"), "<urlset/>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadS3Objects reports a failure without aborting the batch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s3-source-"));

  try {
    const { client } = stubS3({
      objects: {
        "sites/e.com/sitemaps/a.xml": "<a/>",
        "sites/e.com/sitemaps/c.xml": "<c/>"
      },
      failFor: ["sites/e.com/sitemaps/b.xml"]
    });

    const outcomes = await downloadS3Objects(
      ["a", "b", "c"].map((name) => ({
        name: `${name}.xml`,
        key: `sites/e.com/sitemaps/${name}.xml`,
        localPath: path.join(dir, `${name}.xml`)
      })),
      { seam: { client } }
    );

    // Index-aligned with the input, so the caller can pair an outcome with the
    // object that produced it — the pull job relies on that to know which stored
    // filename a success belongs to.
    assert.deepEqual(
      outcomes.map((o) => [o.name, o.ok]),
      [
        ["a.xml", true],
        ["b.xml", false],
        ["c.xml", true]
      ]
    );
    assert.equal(await readFile(path.join(dir, "c.xml"), "utf8"), "<c/>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadS3Objects reports completion counts in order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s3-source-"));

  try {
    const { client } = stubS3({
      objects: Object.fromEntries(
        ["a", "b", "c", "d", "e"].map((n) => [
          `sites/e.com/sitemaps/${n}.xml`,
          `<${n}/>`
        ])
      )
    });
    const counts: number[] = [];

    await downloadS3Objects(
      ["a", "b", "c", "d", "e"].map((name) => ({
        name: `${name}.xml`,
        key: `sites/e.com/sitemaps/${name}.xml`,
        localPath: path.join(dir, `${name}.xml`)
      })),
      {
        seam: { client },
        onSettled: (_outcome, completed) => {
          counts.push(completed);
        }
      }
    );

    // Completion COUNT, not index: with parallel workers the indexes finish out
    // of order and a progress bar driven by them jumps around and goes backwards.
    assert.deepEqual(counts, [1, 2, 3, 4, 5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A stub client whose send() never settles on its own — the same shape a
// stalled socket takes in production — and only rejects once the caller's
// AbortSignal fires, exactly what a real GetObjectCommand under the AWS SDK
// v3 does when aborted.
function stuckClient() {
  const client = new S3Client({ region: "us-east-1" });

  client.send = ((
    _command: unknown,
    options?: { abortSignal?: AbortSignal }
  ) => {
    return new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => {
        reject(options.abortSignal!.reason);
      });
    });
  }) as typeof client.send;

  client.destroy = () => {};

  return client;
}

test("downloadS3Object times out instead of hanging forever on a stalled request", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s3-source-"));
  const originalTimeout = config.s3.operationTimeoutMs;

  config.s3.operationTimeoutMs = 30;

  try {
    await assert.rejects(
      () =>
        downloadS3Object(
          "sites/e.com/sitemaps/stuck.xml",
          path.join(dir, "stuck.xml"),
          { client: stuckClient() }
        ),
      (error: unknown) => error instanceof S3OperationTimeoutError
    );
  } finally {
    config.s3.operationTimeoutMs = originalTimeout;
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadS3Objects skips a stalled file and still finishes the batch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "s3-source-"));
  const originalTimeout = config.s3.operationTimeoutMs;

  config.s3.operationTimeoutMs = 30;

  try {
    const { client } = stubS3({
      objects: {
        "sites/e.com/sitemaps/a.xml": "<a/>",
        "sites/e.com/sitemaps/c.xml": "<c/>"
      }
    });

    // Route "b" to the stuck client's send, everything else to the normal stub —
    // mirrors a real pull where only one of several objects stalls.
    const stuck = stuckClient();
    const realSend = client.send.bind(client);

    client.send = ((command: { input: Record<string, unknown> }, options?: unknown) => {
      if (command.input.Key === "sites/e.com/sitemaps/b.xml") {
        return stuck.send(command as never, options as never);
      }

      return realSend(command as never, options as never);
    }) as typeof client.send;

    const outcomes = await downloadS3Objects(
      ["a", "b", "c"].map((name) => ({
        name: `${name}.xml`,
        key: `sites/e.com/sitemaps/${name}.xml`,
        localPath: path.join(dir, `${name}.xml`)
      })),
      { seam: { client } }
    );

    assert.deepEqual(
      outcomes.map((o) => o.name),
      ["a.xml", "b.xml", "c.xml"]
    );
    assert.equal(outcomes[0].ok, true);
    assert.equal(outcomes[1].ok, false);
    assert.ok(outcomes[1].error instanceof S3OperationTimeoutError);
    assert.equal(outcomes[2].ok, true);
  } finally {
    config.s3.operationTimeoutMs = originalTimeout;
    await rm(dir, { recursive: true, force: true });
  }
});

test("s3SourceConfigError refuses when the feature flag is off", () => {
  // Tests run with AWS_PUBLISH_ENABLED unset, so this is the default posture:
  // the routes refuse regardless of what a client sends, not merely a hidden tab.
  assert.match(String(s3SourceConfigError()), /disabled on this deployment/);
});
