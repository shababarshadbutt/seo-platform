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
  domain: string;
  prefix: string;
  files: PublishFile[];
  indexFilename: string;
  // Files present in the session but skipped because they were deleted in-app.
  // Recorded so the caller can report them; NOT turned into DeleteObject calls.
  omittedDeleted: string[];
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
};

function contentTypeFor(filename: string) {
  return filename.toLowerCase().endsWith(".gz")
    ? "application/gzip"
    : "application/xml; charset=utf-8";
}

// Build the publish plan for a session: every live (non-deleted) sitemap file,
// resolved to its production filename and current on-disk bytes.
export async function buildPublishPlan(
  sessionId: string,
  domain: string
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
      // The session's uploads were cleaned up — nothing to publish for this
      // file. Skipping beats uploading a zero-byte object over a live one.
      continue;
    }

    files.push({ displayName, localPath, size });
  }

  return {
    domain,
    prefix: s3PrefixForDomain(domain),
    files,
    indexFilename: indexFilename ?? "sitemap-index.xml",
    omittedDeleted
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
      await s3.send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: key,
          Body: createReadStream(file.localPath),
          ContentLength: file.size,
          ContentType: contentTypeFor(file.displayName)
        })
      );

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
    const indexXml = buildPublishIndexXml(
      plan.domain,
      plan.files.map((file) => file.displayName),
      options.today
    );
    const indexKey = `${plan.prefix}${plan.indexFilename}`;

    await s3.send(
      new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: indexKey,
        Body: indexXml,
        ContentType: "application/xml; charset=utf-8"
      })
    );

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
      invalidated_paths: writtenKeys.length
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
