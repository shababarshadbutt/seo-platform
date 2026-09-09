import { createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";

import { config, s3PrefixForDomain, s3SourceRootPrefix } from "../config.js";
import { normalizeHost } from "../sitemaps/domain.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import { assertSafeDomain } from "../sftp/sftpClient.js";

// Reading sitemaps back OUT of the bucket the publish path writes to.
//
// The publish side (publish/s3Publish.ts) only ever writes: PutObject, plus a
// HeadObject existence check. Listing and downloading are new here, and they are
// deliberately pointed at exactly the same location publishing uses — both
// resolve their prefix through s3PrefixForDomain() — so a session pulled from
// sites/<domain>/sitemaps/ publishes back over the very objects it read. That
// round trip is the whole point of the feature: revise what is live rather than
// re-uploading a copy of it from somewhere else.
//
// NO CONNECTION SEMAPHORE, unlike sftp/sftpClient.ts, and that is a decision
// rather than an omission. Every SFTP transfer is its own SSH connect against a
// shared Transfer Family endpoint with a hard connection ceiling, so that module
// queues callers to keep from swamping it. S3 is HTTPS against a service with no
// such ceiling and the SDK pools sockets itself; a semaphore here would add a
// queue that guards nothing. Downloads are still bounded (DOWNLOAD_CONCURRENCY)
// so one large pull cannot monopolise this box's sockets or disk.
//
// Credentials: none read here, matching s3Publish.ts. The default AWS provider
// chain resolves the EC2 instance role. Note the role needs s3:ListBucket for
// the listing calls below — PutObject and GetObject alone are not enough, and
// without it the browse endpoint fails with AccessDenied (docs/aws-deployment.md).

export type S3RemoteObject = {
  // Basename of the key — what the file is called, and what it is ingested and
  // later re-published as.
  name: string;
  // Full S3 key. Carried so a download never has to re-derive it from the name
  // and prefix, which is where an off-by-one slash would silently 404.
  key: string;
  size: number;
};

// How many objects download at once. Matches INGEST_CONCURRENCY in
// sitemaps/batchIngest.ts for the same reason: enough to keep the network and
// disk busy without starving the rest of the box. Not an env var — there is no
// shared remote limit to tune against, and a new variable would have to be added
// to both compose files (config.compose.test.ts enforces that).
const DOWNLOAD_CONCURRENCY = 4;

// Only real sitemaps. Same test the SFTP listing uses.
const SITEMAP_FILE = /\.xml(\.gz)?$/i;

type S3ClientSeam = {
  // Test seam ONLY, mirroring executePublish's `clients` option. Production
  // passes nothing and the client is built from the default provider chain.
  client?: S3Client;
};

// Run `work` against an S3 client, destroying it afterwards unless the caller
// injected one (whose lifetime is then the caller's business). The publish path
// destroys its clients in a finally for the same reason: 10+ concurrent users on
// one VM, and an undestroyed client keeps its socket pool alive.
async function withS3<T>(
  seam: S3ClientSeam,
  work: (client: S3Client) => Promise<T>
): Promise<T> {
  const injected = seam.client;
  const client = injected ?? new S3Client({ region: config.s3.region });

  try {
    return await work(client);
  } finally {
    if (!injected) {
      client.destroy();
    }
  }
}

// Thrown by withAbortTimeout below, so callers can tell "the socket stalled"
// apart from any other S3 failure (AccessDenied, NoSuchKey, ...).
export class S3OperationTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "S3OperationTimeoutError";
  }
}

// Bound one S3 call by `ms`, aborting it rather than merely giving up on
// waiting for it. Unlike sftp/sftpClient.ts's withTimeout — which can't cancel
// ssh2's underlying operation and only stops us awaiting it — the SDK v3
// accepts an AbortSignal on send() and Node's pipeline() accepts one too, so a
// stalled request or a stall mid-stream is actually torn down here, not left
// running in the background.
async function withAbortTimeout<T>(
  ms: number,
  label: string,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new S3OperationTimeoutError(label, ms));
  }, ms);
  timer.unref?.();

  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof S3OperationTimeoutError) {
      throw controller.signal.reason;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Every page of one ListObjectsV2 query, walked to exhaustion.
//
// PAGINATION IS NOT OPTIONAL. S3 caps a list response at 1,000 entries and says
// so only through IsTruncated/NextContinuationToken — a single unpaginated call
// against a domain with 2,600 sitemaps (a real size here; the CloudFront
// invalidation threshold exists because of one) returns the first 1,000 and
// looks perfectly successful. The session would then be silently missing 1,600
// files, and publishing it would regenerate an index that de-indexes them.
async function listAllPages(
  client: S3Client,
  input: { Prefix: string; Delimiter?: string },
  onPage: (page: {
    Contents?: { Key?: string; Size?: number }[];
    CommonPrefixes?: { Prefix?: string }[];
  }) => void
): Promise<void> {
  let continuationToken: string | undefined;

  do {
    const response = await withAbortTimeout(
      config.s3.operationTimeoutMs,
      "S3 list",
      (signal) =>
        client.send(
          new ListObjectsV2Command({
            Bucket: config.s3.bucket,
            ...input,
            ContinuationToken: continuationToken
          }),
          { abortSignal: signal }
        )
    );

    onPage(response);

    // Keyed off IsTruncated rather than the token being present: a final page
    // can carry a token, and looping on that alone would re-request forever.
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
}

// The domains available to pull — one folder per domain under the root prefix.
// The S3 counterpart of listSftpDomains().
export async function listS3Domains(
  seam: S3ClientSeam = {}
): Promise<string[]> {
  const root = s3SourceRootPrefix();
  const domains: string[] = [];

  await withS3(seam, async (client) => {
    // Delimiter "/" is what makes S3 report folders at all: it collapses
    // everything below one path segment into a CommonPrefix instead of listing
    // every object in the bucket.
    await listAllPages(client, { Prefix: root, Delimiter: "/" }, (page) => {
      for (const entry of page.CommonPrefixes ?? []) {
        if (!entry.Prefix) {
          continue;
        }

        const name = entry.Prefix.slice(root.length).replace(/\/+$/, "");

        if (!name) {
          continue;
        }

        // Filtered, not thrown on. These names come from bucket contents rather
        // than from a user, but they are about to be offered as choices that get
        // interpolated back into a key prefix — so anything that could escape it
        // is dropped from the list rather than allowed to be selected.
        try {
          assertSafeDomain(name);
        } catch {
          continue;
        }

        domains.push(name);
      }
    });
  });

  return domains.sort();
}

// The sitemap objects for one domain. Flat within <prefix>, exactly like the
// SFTP layout, so a single delimited listing is correct.
export async function listS3SitemapObjects(
  domain: string,
  seam: S3ClientSeam = {}
): Promise<S3RemoteObject[]> {
  assertSafeDomain(domain);
  // Normalized for the same reason publishTarget does it: www.example.com and
  // example.com must resolve to ONE folder, never two.
  const prefix = s3PrefixForDomain(normalizeHost(domain));
  const objects: S3RemoteObject[] = [];

  await withS3(seam, async (client) => {
    await listAllPages(client, { Prefix: prefix, Delimiter: "/" }, (page) => {
      for (const entry of page.Contents ?? []) {
        if (!entry.Key) {
          continue;
        }

        const name = entry.Key.slice(prefix.length);

        // A zero-byte object whose key IS the prefix is the "folder" marker the
        // S3 console creates. Its basename is empty, and ingesting it would add
        // an unparseable empty sitemap to the session. Any other zero-byte
        // object is skipped for the same reason: there is nothing in it to
        // parse, and it would only surface later as a mystery parse failure.
        if (!name || !SITEMAP_FILE.test(name) || !entry.Size) {
          continue;
        }

        // Nested keys cannot appear under Delimiter:"/" — they collapse into a
        // CommonPrefix — but a name carrying a separator would build a local
        // path outside uploadDir, so it is rejected rather than assumed absent.
        if (name.includes("/") || name.includes("\\")) {
          continue;
        }

        objects.push({ name, key: entry.Key, size: entry.Size });
      }
    });
  });

  return objects.sort((a, b) => a.name.localeCompare(b.name));
}

// Download one object straight to a local path.
//
// STREAMED, never buffered: GetObject's Body is a Readable and piping it to disk
// keeps a multi-hundred-MB sitemap out of the heap. Reading it into a Buffer
// first is what the Cleaner's OOM at ~2GB taught us not to do, and it is the same
// discipline fastGet gives the SFTP path for free.
export async function downloadS3Object(
  key: string,
  localPath: string,
  seam: S3ClientSeam = {}
): Promise<void> {
  await withS3(seam, async (client) => {
    await withAbortTimeout(
      config.s3.operationTimeoutMs,
      `S3 download of ${key}`,
      async (signal) => {
        const response = await client.send(
          new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }),
          { abortSignal: signal }
        );

        if (!response.Body) {
          throw new Error(`S3 returned no body for ${key}`);
        }

        // pipeline, not .pipe(): it propagates a mid-transfer error instead of
        // leaving a half-written file behind a resolved promise, and it closes
        // the write stream on failure. The signal here catches a stall
        // mid-stream too, not just before the first byte.
        await pipeline(response.Body as Readable, createWriteStream(localPath), {
          signal
        });
      }
    );
  });
}

export type S3DownloadOutcome = {
  name: string;
  localPath: string;
  ok: boolean;
  error?: unknown;
};

// Download many objects with bounded parallelism.
//
// Built on the shared runWithBoundedConcurrency rather than a private worker
// pool. downloadSftpFiles keeps its own copy because it also honours an
// AbortSignal between files and back-fills the files it never reached; neither
// applies here — nothing passes a signal — so the shared scheduler, whose index
// alignment and completion counting are already tested, is the right tool.
//
// A failed object does not abort the batch: it is reported in its outcome and
// the caller decides, exactly as the SFTP pull does.
export async function downloadS3Objects(
  objects: { name: string; key: string; localPath: string }[],
  options: {
    // Awaited, not fire-and-forget — an unordered progress write can land after
    // the terminal frame and clobber it.
    onSettled?: (
      outcome: S3DownloadOutcome,
      completed: number,
      total: number
    ) => void | Promise<void>;
    seam?: S3ClientSeam;
  } = {}
): Promise<S3DownloadOutcome[]> {
  return runWithBoundedConcurrency(
    objects,
    DOWNLOAD_CONCURRENCY,
    async (object): Promise<S3DownloadOutcome> => {
      try {
        await downloadS3Object(object.key, object.localPath, options.seam ?? {});

        return { name: object.name, localPath: object.localPath, ok: true };
      } catch (error) {
        // Settled into the result, never thrown: runWithBoundedConcurrency's
        // contract is that a task does not throw, so one bad object cannot tear
        // down the batch.
        return {
          name: object.name,
          localPath: object.localPath,
          ok: false,
          error
        };
      }
    },
    options.onSettled
  );
}
