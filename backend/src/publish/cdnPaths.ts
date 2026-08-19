import { config, publicSitemapUrl } from "../config.js";

// CloudFront invalidation path derivation, kept in its own module so every rule
// below is unit-testable without an AWS client.
//
// The bug this module exists to fix: the invalidation used to send S3 KEYS as
// CDN paths ("/sites/example.com/sitemaps/a.xml") while CloudFront actually
// serves the path in PUBLIC_SITEMAP_URL_TEMPLATE ("/sitemaps/a.xml"). Those are
// set by different systems — our uploader vs. the distribution's origin path —
// so an invalidation built from the key evicted nothing even when it SUCCEEDED,
// and the sitemaps stayed cached at the edge until their TTL lapsed.
//
// The rule now: a CDN path is derived from the SAME helper that builds the
// index's <loc> values (publicSitemapUrl). If the index can be fetched at a
// path, that path is what gets invalidated, and the two cannot drift.

export type RejectedPath = {
  path: string;
  reason: string;
};

// Characters CloudFront accepts literally in an invalidation path. Everything
// else has to be percent-encoded, and anything that cannot be is rejected.
// Deliberately conservative: the cost of over-encoding is a path that still
// matches (CloudFront decodes before matching), the cost of under-encoding is a
// rejected batch.
const SAFE_PATH_CHARS = /^[A-Za-z0-9/._~!$&'()+,;=:@%*-]*$/;

// The path CloudFront serves one sitemap at. NOT the S3 key — see the module
// note. Returns null when the template does not produce a parseable absolute
// url, because a relative or malformed template must not silently yield "/".
export function cdnPathForFile(
  publicHost: string,
  filename: string,
  template: string = config.publicSitemapUrlTemplate
): string | null {
  const url = publicSitemapUrl(publicHost, filename, template);

  try {
    // Parsed rather than string-sliced so a template with a query, a port or a
    // different host is handled by the URL spec instead of by our guesswork.
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// Make one path safe for CreateInvalidation, or explain why it cannot be.
//
// CloudFront requires a leading slash and URL-encoded ASCII. An SFTP-pulled
// filename is never sanitized (it has to stay byte-identical to the real
// production object name), so names carrying a space, a stray "%", or a
// non-ASCII byte reach here routinely — and ONE of them used to reject the
// entire batch of 2,651 paths.
export function encodeCdnPath(rawPath: string): string | null {
  if (!rawPath || rawPath === "/") {
    return null;
  }

  // A literal "*" is only meaningful as the last character. Mid-path it is not
  // an error CloudFront reports usefully, so reject it here where we can say so.
  if (rawPath.slice(0, -1).includes("*")) {
    return null;
  }

  // Control characters cannot be carried at all, encoded or not.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return null;
  }

  // Path traversal would invalidate a path other than the one we wrote.
  if (rawPath.split("/").includes("..")) {
    return null;
  }

  const withSlash = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;

  // Decode first so an ALREADY-encoded path ("air%20parts.xml") is not
  // double-encoded into a different path ("air%2520parts.xml"), which would
  // purge nothing. A decode failure means the "%" was never an escape to begin
  // with ("100%-off.xml"), so there is nothing to normalize and the raw path
  // goes to encodeURI as-is — which escapes the bare "%" to "%25" itself.
  let normalized: string;

  try {
    normalized = decodeURI(withSlash);
  } catch {
    normalized = withSlash;
  }

  let encoded = encodeURI(normalized);

  // encodeURI does not touch these, and CloudFront treats them as delimiters.
  encoded = encoded.replaceAll("?", "%3F").replaceAll("#", "%23");

  if (!SAFE_PATH_CHARS.test(encoded)) {
    return null;
  }

  // Documented CloudFront limit.
  if (Buffer.byteLength(encoded, "utf8") > 4096) {
    return null;
  }

  return encoded;
}

// The single wildcard path that covers every sitemap for one domain.
//
// Deliberately NOT "/*": the distribution is shared with every other client
// site, so "/*" would evict all of their cached content and is never acceptable.
// This returns the directory the sitemaps are SERVED from plus "*", so the blast
// radius is exactly this domain's sitemap folder.
//
// Returns null when the template serves sitemaps from the site root — there the
// only covering wildcard IS "/*", so the caller must fall back to exact paths
// instead. That refusal is the safety property of this whole module.
export function wildcardPathFor(
  publicHost: string,
  filename: string,
  template: string = config.publicSitemapUrlTemplate
): string | null {
  const path = cdnPathForFile(publicHost, filename, template);

  if (!path) {
    return null;
  }

  const lastSlash = path.lastIndexOf("/");

  if (lastSlash <= 0) {
    // "/a.xml" -> directory is "/", whose wildcard is "/*". Refuse.
    return null;
  }

  const directory = path.slice(0, lastSlash + 1);
  const encoded = encodeCdnPath(`${directory}*`);

  // Belt and braces: nothing below may produce a distribution-wide wildcard,
  // however the template is written.
  if (!encoded || encoded === "/*" || encoded === "*") {
    return null;
  }

  return encoded;
}

export type InvalidationBatches = {
  batches: string[][];
  // Paths that could not be encoded. Reported to the user, never fatal.
  rejected: RejectedPath[];
  // Distinct paths across all batches — what CloudFront actually bills for.
  pathCount: number;
};

// Dedupe, encode and chunk paths for CreateInvalidation.
//
// Chunking matters for two independent reasons: CloudFront caps a non-wildcard
// request at 3,000 paths (so a 3,000+ file domain could not be invalidated at
// all), and a rejected batch now costs one batch instead of the whole publish.
export function buildInvalidationBatches(
  paths: string[],
  options: { maxPerRequest?: number } = {}
): InvalidationBatches {
  const maxPerRequest = Math.max(
    1,
    options.maxPerRequest ?? config.cloudfrontMaxPathsPerRequest
  );
  const rejected: RejectedPath[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    const encoded = encodeCdnPath(path);

    if (!encoded) {
      rejected.push({
        path,
        reason:
          "cannot be expressed as a valid CloudFront invalidation path (it must be URL-encodable ASCII)"
      });
      continue;
    }

    // Deduped because a duplicate path is billed twice and adds nothing.
    seen.add(encoded);
  }

  const unique = [...seen];
  const batches: string[][] = [];

  for (let index = 0; index < unique.length; index += maxPerRequest) {
    batches.push(unique.slice(index, index + maxPerRequest));
  }

  return { batches, rejected, pathCount: unique.length };
}
