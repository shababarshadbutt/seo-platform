import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  CloudFrontClient,
  CreateInvalidationCommand
} from "@aws-sdk/client-cloudfront";
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

import { config, publicSitemapUrl, s3PrefixForDomain } from "../config.js";
import { pool } from "../db/pool.js";
import { isHttpUrl, productionFilename } from "../sitemaps/filenames.js";
import {
  buildInvalidationBatches,
  cdnPathForFile,
  wildcardPathFor,
  type RejectedPath
} from "./cdnPaths.js";
import type { PublishTarget } from "./publishTarget.js";

// Publish a session's corrected sitemaps to the live S3 bucket, then invalidate
// exactly the CloudFront paths written (Phase 1).
//
// Credentials: none here, deliberately. Both clients use the default AWS
// provider chain, which on the EC2 VM resolves the instance role. No access key
// is read from env or config anywhere in this file.
//
// Filename resolution is the subtle part. Internally this app is copy-on-write:
// an edited file is stored as "<session>-fixed-<hash>-<name>.xml" and the
// original is kept for undo. Production must receive the file under its REAL
// name. Since migration 031 that name is RECORDED at ingestion
// (sitemap_files.original_filename) rather than recovered from our prefixed
// stored name, because the recovery heuristic cannot distinguish our own
// "current-" role prefix from a client file genuinely called "current-x.xml" —
// and publishing the wrong key overwrites the wrong object in a bucket with no
// versioning. Pre-031 rows have no recorded name and fall back to
// productionFilename(), which is exactly the old behaviour.
//
// Deletions: this module NEVER calls DeleteObject. A file removed within a
// session simply stops appearing in the regenerated index; the orphaned object
// stays in the bucket, unreferenced and harmless. With bucket versioning off
// there is no undo for a wrong delete, so not deleting is the safe default.
// config.s3.allowDelete exists to make that decision explicit and auditable —
// it is asserted, not branched on.

export type PublishFile = {
  // Real production filename (what the object is keyed as).
  displayName: string;
  // Local path of the bytes to upload.
  localPath: string;
  size: number;
};

export type PublishPlan = {
  // The canonical host that produced `prefix`. Comes from resolvePublishTarget,
  // never from a caller-supplied string — see publish/publishTarget.ts.
  domain: string;
  // The host the public <loc> urls use. Deliberately separate from `domain`:
  // stripping "www." is right for choosing ONE storage prefix and wrong for
  // telling a search engine where to fetch the file.
  publicHost: string;
  prefix: string;
  files: PublishFile[];
  indexFilename: string;
  // Files present in the session but skipped because they were deleted in-app.
  // Recorded so the caller can report them; NOT turned into DeleteObject calls.
  omittedDeleted: string[];
  // Live files the session still lists but whose BYTES ARE GONE from disk.
  //
  // This used to be a bare `continue` with a comment saying skipping beats
  // uploading a zero-byte object. Skipping does beat that, but silently
  // dropping the file was worse than either: the regenerated index is built
  // from plan.files, so a dropped file is also dropped from the index —
  // de-indexing live URLs — while the publish reports success and a file count
  // the user has no way to compare against. Uploads are deleted an hour after
  // a session completes (CLEANUP_UPLOADS_DELAY_MS), so this is the ordinary
  // state of any session published the next day, not an exotic failure.
  //
  // Recorded here, surfaced by the preview, and refused by executePublish.
  missingLocal: string[];
};

// One file the publish could not write, after retries. Reported rather than
// fatal: a handful of bad files must not strand the other 2,600.
export type PublishFailedFile = {
  filename: string;
  reason: string;
  // Whether the regenerated index still references it. True when an OLDER
  // version of the object is already live in the bucket, so keeping the entry
  // serves a stale sitemap instead of de-indexing live URLs. False means the
  // object does not exist at all and the entry would have pointed at a 404.
  still_indexed: boolean;
};

// What the CloudFront stage did. Always returned, never thrown — see invalidateCdn.
export type InvalidationOutcome = {
  // "wildcard": one scoped path covering the whole sitemap folder.
  // "exact": one request per batch of individual paths.
  // "skipped": no distribution configured, or nothing to invalidate.
  strategy: "wildcard" | "exact" | "skipped";
  invalidation_ids: string[];
  paths_requested: number;
  batches_requested: number;
  batches_failed: number;
  // Paths that could not be encoded, or whose batch CloudFront rejected.
  failed_paths: RejectedPath[];
  // Set when the stage did not fully succeed. The publish itself has already
  // succeeded by this point, so this is a WARNING, never a failure.
  error: string | null;
};

export type PublishResult = {
  domain: string;
  bucket: string;
  prefix: string;
  uploaded: number;
  bytes: number;
  index_key: string;
  omitted_deleted: string[];
  // Files that could not be uploaded even after retries. Empty on a clean run.
  failed_files: PublishFailedFile[];
  invalidation: InvalidationOutcome;
  // Kept for compatibility with existing readers (the audit row, the SSE
  // payload). Derived from `invalidation` — the first id and the path count.
  invalidation_id: string | null;
  invalidated_paths: number;
  // Every key actually PUT, in order. Logged (a bounded sample) by the job so
  // the deployment's logs answer "which prefix did this publish write to?"
  // without needing bucket access — the question a www/non-www prefix mismatch
  // turns on.
  written_keys: string[];
};

function contentTypeFor(filename: string) {
  return filename.toLowerCase().endsWith(".gz")
    ? "application/gzip"
    : "application/xml; charset=utf-8";
}

// Build the publish plan for a session: every live (non-deleted) sitemap file,
// resolved to its production filename and current on-disk bytes.
//
// Takes a resolved PublishTarget, NOT a domain string. That is deliberate: this
// used to accept whatever host the caller had, which is how a publish request
// carrying an unnormalized base_url host could write to a second, wrong prefix.
// The type now makes the resolver the only way in.
export async function buildPublishPlan(
  sessionId: string,
  target: PublishTarget
): Promise<PublishPlan> {
  const filesResult = await pool.query<{
    filename: string;
    original_filename: string | null;
    is_deleted: boolean;
    is_index: boolean;
  }>(
    `
      SELECT filename, original_filename, is_deleted, is_index
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current'
      ORDER BY filename ASC
    `,
    [sessionId]
  );

  const files: PublishFile[] = [];
  const omittedDeleted: string[] = [];
  const missingLocal: string[] = [];
  const seen = new Set<string>();
  let indexFilename: string | null = null;

  for (const row of filesResult.rows) {
    if (isHttpUrl(row.filename)) {
      continue;
    }

    // Recorded name wins outright (migration 031). Only rows ingested BEFORE
    // that migration have NULL here, and they fall back to deriving it from the
    // stored name exactly as before — so nothing changes retroactively, and no
    // new row is ever subject to the heuristic.
    const displayName =
      row.original_filename ?? productionFilename(sessionId, row.filename);

    if (row.is_deleted) {
      // Dropped from the regenerated index below; never DeleteObject'd.
      omittedDeleted.push(displayName);
      continue;
    }

    // The uploaded index is regenerated, not copied — remember its real name so
    // the rebuilt one replaces it in place instead of introducing a new object.
    if (row.is_index) {
      indexFilename = indexFilename ?? displayName;
      continue;
    }

    if (seen.has(displayName)) {
      continue;
    }

    seen.add(displayName);
    const localPath = path.join(config.uploadDir, row.filename);

    let size: number;

    try {
      size = (await stat(localPath)).size;
    } catch {
      // The session's uploads were cleaned up (or the volume changed under us).
      // Still NOT uploaded — a zero-byte object over a live one is worse. But
      // recorded rather than dropped, because a file missing here is silently
      // missing from the regenerated index too. executePublish refuses.
      missingLocal.push(displayName);
      continue;
    }

    files.push({ displayName, localPath, size });
  }

  return {
    domain: target.prefixDomain,
    publicHost: target.publicHost,
    prefix: s3PrefixForDomain(target.prefixDomain),
    files,
    indexFilename: indexFilename ?? "sitemap-index.xml",
    omittedDeleted,
    missingLocal
  };
}

// Regenerate the index over exactly the files being published, so a file
// deleted in-session drops out of it.
//
// NOTE on the public path: a <loc> here must be the URL a search engine can
// actually FETCH, which is NOT the S3 key. This function therefore takes NO
// prefix and never sees one — the public url comes wholly from
// PUBLIC_SITEMAP_URL_TEMPLATE (config.publicSitemapUrlTemplate). Earlier
// versions derived it from the key path, which first leaked storage layout into
// the public url (https://<domain>/sites/<domain>/sitemaps/<file>) and then, once
// patched to use the prefix's last segment, still silently coupled the two.
// Where objects are laid out in the bucket and what path CloudFront serves them
// at are set by different systems; they are configured independently here so a
// mismatch is one .env line, not a code change.
//
// The default template still ASSUMES CloudFront maps <domain>/sitemaps/* onto
// the bucket prefix. That mapping is a distribution setting this code cannot
// see; step 7 of the throwaway-domain gate (docs/aws-deployment.md) confirms it
// before any real client domain is published.
export function buildPublishIndexXml(
  domain: string,
  filenames: string[],
  today: string,
  urlTemplate?: string
): string {
  const entries = filenames
    .map((filename) => {
      const loc = publicSitemapUrl(domain, filename, urlTemplate)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      return `  <sitemap>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

// May return a promise; executePublish awaits it so progress writes stay in
// ORDER. Unordered (fire-and-forget) writes let a late per-file update land
// after the terminal "done" update and clobber it, which showed a stale
// mid-upload message as the completion message.
export type PublishProgress = (event: {
  current: number;
  total: number;
  filename: string;
}) => void | Promise<void>;

// A publish that died PART WAY THROUGH. Carries how far it got, because that is
// the operationally important fact and it is otherwise unrecoverable: the first
// N objects were already overwritten in a bucket with no versioning, and the
// regenerated index was NOT written, so production is now a mixture of new
// child sitemaps and an old index. The bare SDK error says none of that.
export class PublishFileError extends Error {
  readonly key: string;
  readonly uploadedBefore: number;
  readonly plannedTotal: number;

  constructor(options: {
    key: string;
    uploadedBefore: number;
    plannedTotal: number;
    cause: unknown;
  }) {
    const reason =
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause);

    super(
      `S3 upload failed on ${options.key} (file ${
        options.uploadedBefore + 1
      } of ${options.plannedTotal}): ${reason}. ` +
        `${options.uploadedBefore} object(s) were already overwritten and the sitemap index was NOT updated — production is in a mixed state. Re-run the publish once the cause is fixed.`
    );
    this.name = "PublishFileError";
    this.key = options.key;
    this.uploadedBefore = options.uploadedBefore;
    this.plannedTotal = options.plannedTotal;
    this.cause = options.cause;
  }
}

// Too many files failed to upload for "carry on and report them" to be honest.
//
// A handful of bad files is a reportable partial success. A wholesale failure is
// a broken credential, a wrong bucket policy or a dead network, and grinding
// through 2,600 more doomed PUTs to prove it helps nobody — it just delays the
// error and leaves production maximally mixed. So the per-file tolerance is
// bounded and crossing it is fatal.
export class PublishAbortedError extends Error {
  readonly failedFiles: PublishFailedFile[];
  readonly uploaded: number;
  readonly plannedTotal: number;

  constructor(options: {
    failedFiles: PublishFailedFile[];
    uploaded: number;
    plannedTotal: number;
    tolerance: number;
  }) {
    const sample = options.failedFiles
      .slice(0, 3)
      .map((file) => `${file.filename} (${file.reason})`)
      .join("; ");

    super(
      `Publish aborted: ${options.failedFiles.length} of the first ${
        options.uploaded + options.failedFiles.length
      } file(s) failed to upload, over the tolerance of ${options.tolerance}. ` +
        `Examples: ${sample}. ` +
        `${options.uploaded} object(s) were already overwritten and the sitemap index was NOT updated — production is in a mixed state. ` +
        `This many failures means a credential, bucket-policy or network problem rather than bad files: fix that, then re-run the publish.`
    );
    this.name = "PublishAbortedError";
    this.failedFiles = options.failedFiles;
    this.uploaded = options.uploaded;
    this.plannedTotal = options.plannedTotal;
  }
}

// How many failed files are tolerated before the whole publish aborts. A floor
// of 10 so a small session is not aborted by one flaky PUT, and 2% so a large
// one is not allowed to fail by the hundred.
export function uploadFailureTolerance(plannedTotal: number): number {
  return Math.max(10, Math.ceil(plannedTotal * 0.02));
}

// Retries between attempts. Two retries, short backoff: an S3 PUT failure is
// usually a transient 500/503 or a throttle, and the publish holds a per-domain
// lock so it cannot sit here indefinitely.
const PUT_RETRY_DELAYS_MS = [250, 1000];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// PUT one object, retrying transient failures.
//
// The stream is created INSIDE the loop, once per attempt. This is the sharpest
// edge in this file: a Node read stream cannot be replayed, so retrying with the
// handle from the failed attempt would send a consumed (empty) body and silently
// overwrite a live sitemap with a zero-byte object — in a bucket with no
// versioning. ContentLength is re-sent per attempt for the same reason.
async function putObjectWithRetry(
  s3: S3Client,
  params: { key: string; localPath: string; size: number; contentType: string }
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= PUT_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, PUT_RETRY_DELAYS_MS[attempt - 1])
      );
    }

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: params.key,
          // Fresh handle per attempt — see the note above.
          Body: createReadStream(params.localPath),
          ContentLength: params.size,
          ContentType: params.contentType
        })
      );

      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

// Does this key already hold an object? Decides whether a file we FAILED to
// upload stays in the regenerated index.
//
// A Head failure that is not a clean 404 is treated as "exists". Guessing that
// way keeps a stale sitemap referenced; guessing the other way de-indexes live
// URLs, which is the strictly worse error and exactly what the missingLocal
// guard above exists to prevent. It also means a deployment whose IAM role has
// not yet been granted HeadObject degrades to "keep everything indexed" instead
// of breaking publishes.
async function objectExists(s3: S3Client, key: string): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key })
    );

    return true;
  } catch (error) {
    const name =
      error instanceof Error ? error.name : String((error as { name?: string })?.name);

    if (name === "NotFound" || name === "NoSuchKey") {
      return false;
    }

    return true;
  }
}

// Execute a plan: upload every child file, then the regenerated index, then
// invalidate exactly those paths.
export async function executePublish(
  plan: PublishPlan,
  options: {
    today: string;
    onProgress?: PublishProgress;
    // Test seam ONLY. Production passes nothing and both clients are built here
    // from the default AWS provider chain (the instance role) — see the module
    // note; no credential is ever read from config. Injecting them lets the
    // upload-failure, retry and invalidation paths be asserted without AWS,
    // which is what left the CloudFront call with zero coverage until it broke
    // a real 2,650-file publish.
    clients?: { s3?: S3Client; cloudfront?: CloudFrontClient };
  } = {
    today: new Date().toISOString().slice(0, 10)
  }
): Promise<PublishResult> {
  // Belt and braces: this module has no delete path at all, and must not grow
  // one by accident. If someone flips the flag expecting deletes, fail loudly
  // rather than silently doing nothing they asked for.
  if (config.s3.allowDelete) {
    throw new Error(
      "S3_PUBLISH_ALLOW_DELETE=true is not supported: publish never issues DeleteObject (no bucket versioning means a wrong delete is unrecoverable)"
    );
  }

  // Refuse rather than publish an index that omits files whose bytes we no
  // longer have. Uploading nothing for them and dropping them from the index
  // de-indexes live URLs, and the old code did exactly that while reporting
  // success. A session whose uploads were cleaned up must be re-ingested (or
  // re-pulled over SFTP) before it can be published again.
  if (plan.missingLocal.length > 0) {
    const sample = plan.missingLocal.slice(0, 5).join(", ");

    throw new Error(
      `Refusing to publish: ${plan.missingLocal.length} file(s) in this session no longer have their content on disk (${sample}${
        plan.missingLocal.length > 5 ? ", …" : ""
      }). Publishing would leave those sitemaps stale in the bucket AND drop them from the regenerated index. Session uploads are deleted an hour after a session completes — re-upload or re-pull this domain's files, then publish.`
    );
  }

  if (plan.files.length === 0) {
    // Would otherwise upload a sitemap index containing zero <sitemap> entries
    // over a live one, and report "Published 1 file(s)" as a success.
    throw new Error(
      "Refusing to publish: this session has no sitemap files to upload, so the only thing written would be an EMPTY sitemap index replacing the live one."
    );
  }

  const s3 = options.clients?.s3 ?? new S3Client({ region: config.s3.region });
  const writtenKeys: string[] = [];
  const uploadedNames: string[] = [];
  const failedFiles: PublishFailedFile[] = [];
  const tolerance = uploadFailureTolerance(plan.files.length);
  let bytes = 0;

  try {
    let index = 0;

    for (const file of plan.files) {
      index += 1;
      const key = `${plan.prefix}${file.displayName}`;

      // Stream from disk — a large child sitemap is never read into the heap.
      // ContentLength is required because a stream body has no known length.
      //
      // A file that still fails after retries is RECORDED AND SKIPPED rather
      // than aborting the run. This used to throw: one unwritable file out of
      // 2,650 stranded the other 2,649, which is a worse outcome than publishing
      // them and naming the one that did not make it. What made the old
      // behaviour necessary — never letting the index claim a file that was
      // never written — is preserved below by checking whether the object
      // already exists before deciding whether it stays in the index.
      try {
        await putObjectWithRetry(s3, {
          key,
          localPath: file.localPath,
          size: file.size,
          contentType: contentTypeFor(file.displayName)
        });
      } catch (error) {
        failedFiles.push({
          filename: file.displayName,
          reason: errorMessage(error),
          // Resolved after the loop, with one HeadObject per failed file.
          still_indexed: false
        });

        // Bounded tolerance: past this it is a systemic failure, not bad files.
        if (failedFiles.length > tolerance) {
          throw new PublishAbortedError({
            failedFiles,
            uploaded: writtenKeys.length,
            plannedTotal: plan.files.length,
            tolerance
          });
        }

        // Still reported, so the progress bar reaches `total` rather than
        // stalling short and looking hung.
        await options.onProgress?.({
          current: index,
          total: plan.files.length + 1,
          filename: file.displayName
        });
        continue;
      }

      writtenKeys.push(key);
      uploadedNames.push(file.displayName);
      bytes += file.size;
      await options.onProgress?.({
        current: index,
        total: plan.files.length + 1,
        filename: file.displayName
      });
    }

    if (uploadedNames.length === 0) {
      // Every file failed. Writing an index of only-stale entries (or an empty
      // one) over the live index would be the silent-success failure this module
      // refuses everywhere else.
      throw new PublishAbortedError({
        failedFiles,
        uploaded: 0,
        plannedTotal: plan.files.length,
        tolerance
      });
    }

    // Decide index membership for the files that failed. An older version of
    // the object may well be live — this publish overwrites existing sitemaps —
    // and dropping it from the index would de-index live URLs over a transient
    // upload error. So: object exists => keep the entry (stale but served);
    // absent => omit it, and say so in the report.
    for (const failed of failedFiles) {
      failed.still_indexed = await objectExists(
        s3,
        `${plan.prefix}${failed.filename}`
      );
    }

    const indexedNames = [
      ...uploadedNames,
      ...failedFiles.filter((file) => file.still_indexed).map((file) => file.filename)
    ].sort();

    // plan.prefix is deliberately NOT passed: the index's public urls come from
    // the template, the keys below come from the prefix.
    //
    // publicHost, not plan.domain: plan.domain is normalized so that one site
    // maps to one storage prefix, but a site that genuinely serves at
    // www.example.com must not have the www stripped out of its <loc> values.
    const indexXml = buildPublishIndexXml(
      plan.publicHost,
      indexedNames,
      options.today
    );
    const indexKey = `${plan.prefix}${plan.indexFilename}`;

    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: indexKey,
          Body: indexXml,
          ContentType: "application/xml; charset=utf-8"
        })
      );
    } catch (error) {
      throw new PublishFileError({
        key: indexKey,
        uploadedBefore: writtenKeys.length,
        plannedTotal: plan.files.length + 1,
        cause: error
      });
    }

    writtenKeys.push(indexKey);
    await options.onProgress?.({
      current: plan.files.length + 1,
      total: plan.files.length + 1,
      filename: plan.indexFilename
    });

    // Never throws. The bytes are already on production by this point, so a
    // CloudFront rejection is a stale-edge-cache warning — not a failed publish.
    // It used to be an uncaught await here, which turned a fully successful
    // 2,651-file publish into a red "Publish failed" and an audit row reading
    // FAILED with no upload count.
    // Only what actually CHANGED: the files written plus the regenerated index.
    // A file that failed to upload still holds its previous bytes, so
    // invalidating it would spend a billable path to re-fetch identical content.
    const invalidation = await invalidateCdn(
      plan,
      [...uploadedNames, plan.indexFilename],
      options.clients?.cloudfront
    );

    return {
      domain: plan.domain,
      bucket: config.s3.bucket,
      prefix: plan.prefix,
      uploaded: writtenKeys.length,
      bytes,
      index_key: indexKey,
      omitted_deleted: plan.omittedDeleted,
      failed_files: failedFiles,
      invalidation,
      invalidation_id: invalidation.invalidation_ids[0] ?? null,
      invalidated_paths: invalidation.paths_requested,
      written_keys: writtenKeys
    };
  } finally {
    // Release the SDK's sockets as soon as this publish is done rather than
    // letting them idle — 10+ concurrent users on one VM. Only a client we
    // constructed: tearing down a caller's is not ours to do.
    if (!options.clients?.s3) {
      s3.destroy();
    }
  }
}

// Invalidate what was published, and NEVER throw.
//
// Two things changed here after a 2,650-file publish that fully succeeded was
// reported to the user as a total failure:
//
// 1. It no longer throws. Every object is already written when this runs, so a
//    CloudFront error means "the edge may serve stale sitemaps until their TTL
//    lapses", not "the publish failed". The outcome is returned and reported.
//
// 2. It invalidates the paths CloudFront actually SERVES, derived through
//    cdnPathForFile, rather than the S3 keys. Sending "/sites/<domain>/sitemaps/x.xml"
//    at a distribution serving "/sitemaps/x.xml" evicted nothing even on success.
//
// Still deliberately not "/*": the distribution is shared with every other client
// site, and "/*" would evict all of them. The wildcard used for large publishes
// is scoped to this domain's sitemap directory, and wildcardPathFor refuses to
// return a distribution-wide one.
async function invalidateCdn(
  plan: PublishPlan,
  filenames: string[],
  injectedClient?: CloudFrontClient
): Promise<InvalidationOutcome> {
  const skipped: InvalidationOutcome = {
    strategy: "skipped",
    invalidation_ids: [],
    paths_requested: 0,
    batches_requested: 0,
    batches_failed: 0,
    failed_paths: [],
    error: null
  };

  if (!config.cloudfrontDistributionId || filenames.length === 0) {
    return skipped;
  }

  try {
    const rejected: RejectedPath[] = [];
    const paths: string[] = [];

    for (const filename of filenames) {
      const cdnPath = cdnPathForFile(plan.publicHost, filename);

      if (!cdnPath) {
        rejected.push({
          path: filename,
          reason:
            "PUBLIC_SITEMAP_URL_TEMPLATE did not resolve this file to a fetchable url"
        });
        continue;
      }

      paths.push(cdnPath);
    }

    // Above the threshold, one scoped wildcard replaces thousands of exact
    // paths: CloudFront caps a non-wildcard request at 3,000 and bills per path
    // beyond 1,000/month. Falls through to exact paths when the template serves
    // sitemaps from the site root, where the only covering wildcard would be the
    // distribution-wide "/*".
    const wildcard =
      paths.length > config.cloudfrontWildcardThreshold
        ? wildcardPathFor(plan.publicHost, plan.indexFilename)
        : null;

    let batches: string[][];
    let pathCount: number;

    if (wildcard) {
      batches = [[wildcard]];
      pathCount = 1;
    } else {
      const built = buildInvalidationBatches(paths);

      batches = built.batches;
      pathCount = built.pathCount;
      rejected.push(...built.rejected);
    }

    if (batches.length === 0) {
      return {
        ...skipped,
        strategy: wildcard ? "wildcard" : "exact",
        failed_paths: rejected,
        error:
          rejected.length > 0
            ? `No valid CloudFront invalidation path could be built for any of ${rejected.length} file(s).`
            : null
      };
    }

    const client =
      injectedClient ?? new CloudFrontClient({ region: config.s3.region });
    const invalidationIds: string[] = [];
    const failedPaths: RejectedPath[] = [...rejected];
    let batchesFailed = 0;
    let lastError: string | null = null;

    try {
      let batchIndex = 0;

      for (const batch of batches) {
        batchIndex += 1;

        // Per batch, so one rejected path costs its own batch rather than every
        // path in the publish.
        try {
          const response = await client.send(
            new CreateInvalidationCommand({
              DistributionId: config.cloudfrontDistributionId,
              InvalidationBatch: {
                // Unique per request; CloudFront dedupes retries on this.
                CallerReference: `publish-${Date.now()}-${batchIndex}-${batch.length}`,
                Paths: { Quantity: batch.length, Items: batch }
              }
            })
          );

          if (response.Invalidation?.Id) {
            invalidationIds.push(response.Invalidation.Id);
          }
        } catch (error) {
          batchesFailed += 1;
          lastError = errorMessage(error);

          for (const rejectedPath of batch) {
            failedPaths.push({ path: rejectedPath, reason: lastError });
          }
        }
      }
    } finally {
      // Release the SDK's sockets promptly — 10+ concurrent users on one VM.
      // Only a client we constructed: tearing down a caller's is not ours to do.
      if (!injectedClient) {
        client.destroy();
      }
    }

    const strategy = wildcard ? "wildcard" : "exact";
    const errors: string[] = [];

    if (batchesFailed > 0) {
      errors.push(
        `CloudFront rejected ${batchesFailed} of ${batches.length} invalidation request(s): ${lastError}`
      );
    }

    if (rejected.length > 0) {
      errors.push(
        `${rejected.length} file(s) could not be turned into a valid invalidation path`
      );
    }

    return {
      strategy,
      invalidation_ids: invalidationIds,
      paths_requested: pathCount,
      batches_requested: batches.length,
      batches_failed: batchesFailed,
      failed_paths: failedPaths,
      error: errors.length > 0 ? errors.join(". ") : null
    };
  } catch (error) {
    // Anything unforeseen — a client constructor throw, a config surprise —
    // still cannot fail a publish whose bytes are already live.
    return {
      ...skipped,
      error: `CDN invalidation could not be requested: ${errorMessage(error)}`
    };
  }
}
