import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  CloudFrontClient,
  CreateInvalidationCommand
} from "@aws-sdk/client-cloudfront";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { config, publicSitemapUrl, s3PrefixForDomain } from "../config.js";
import { pool } from "../db/pool.js";
import { isHttpUrl, productionFilename } from "../sitemaps/filenames.js";
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

export type PublishResult = {
  domain: string;
  bucket: string;
  prefix: string;
  uploaded: number;
  bytes: number;
  index_key: string;
  omitted_deleted: string[];
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

// Execute a plan: upload every child file, then the regenerated index, then
// invalidate exactly those paths.
export async function executePublish(
  plan: PublishPlan,
  options: { today: string; onProgress?: PublishProgress } = {
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

  const s3 = new S3Client({ region: config.s3.region });
  const writtenKeys: string[] = [];
  let bytes = 0;

  try {
    let index = 0;

    for (const file of plan.files) {
      index += 1;
      const key = `${plan.prefix}${file.displayName}`;

      // Stream from disk — a large child sitemap is never read into the heap.
      // ContentLength is required because a stream body has no known length.
      //
      // Deliberately NOT a try/continue: one failed PUT aborts the whole
      // publish. A per-file "log and carry on" would leave the index claiming
      // files that were never written, which is the failure this whole path
      // must not have. The catch only ATTACHES CONTEXT and rethrows.
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: config.s3.bucket,
            Key: key,
            Body: createReadStream(file.localPath),
            ContentLength: file.size,
            ContentType: contentTypeFor(file.displayName)
          })
        );
      } catch (error) {
        throw new PublishFileError({
          key,
          uploadedBefore: writtenKeys.length,
          plannedTotal: plan.files.length,
          cause: error
        });
      }

      writtenKeys.push(key);
      bytes += file.size;
      await options.onProgress?.({
        current: index,
        total: plan.files.length + 1,
        filename: file.displayName
      });
    }

    // plan.prefix is deliberately NOT passed: the index's public urls come from
    // the template, the keys below come from the prefix.
    //
    // publicHost, not plan.domain: plan.domain is normalized so that one site
    // maps to one storage prefix, but a site that genuinely serves at
    // www.example.com must not have the www stripped out of its <loc> values.
    const indexXml = buildPublishIndexXml(
      plan.publicHost,
      plan.files.map((file) => file.displayName),
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

    const invalidation = await invalidatePaths(writtenKeys);

    return {
      domain: plan.domain,
      bucket: config.s3.bucket,
      prefix: plan.prefix,
      uploaded: writtenKeys.length,
      bytes,
      index_key: indexKey,
      omitted_deleted: plan.omittedDeleted,
      invalidation_id: invalidation,
      invalidated_paths: writtenKeys.length,
      written_keys: writtenKeys
    };
  } finally {
    // Release the SDK's sockets as soon as this publish is done rather than
    // letting them idle — 10+ concurrent users on one VM.
    s3.destroy();
  }
}

// Invalidate exactly the paths written. Deliberately NOT "/*": that would evict
// every other client site's cached content from the shared distribution and
// cost far more per invalidation.
async function invalidatePaths(keys: string[]): Promise<string | null> {
  if (!config.cloudfrontDistributionId || keys.length === 0) {
    return null;
  }

  const client = new CloudFrontClient({ region: config.s3.region });

  try {
    const response = await client.send(
      new CreateInvalidationCommand({
        DistributionId: config.cloudfrontDistributionId,
        InvalidationBatch: {
          // Unique per call; CloudFront dedupes retries on this.
          CallerReference: `publish-${Date.now()}-${Math.round(keys.length)}`,
          Paths: {
            Quantity: keys.length,
            Items: keys.map((key) => (key.startsWith("/") ? key : `/${key}`))
          }
        }
      })
    );

    return response.Invalidation?.Id ?? null;
  } finally {
    client.destroy();
  }
}
