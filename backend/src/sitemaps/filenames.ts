import path from "node:path";

export function sanitizeUploadedFilename(filename: string) {
  const baseName = path.basename(filename).trim();
  const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, "_");

  return sanitized || "sitemap.xml";
}

// Deterministic per (session, sourceRole, original filename). This is what makes
// the migration 012 UNIQUE(session_id, filename) constraint actually dedupe:
// uploading the same file twice (retry / re-submit / double upload) now collides
// on the same stored filename instead of minting a fresh randomUUID each time,
// which previously caused the processing screen to show 2x the real file count.
// sourceRole is included so a legacy file may share a basename with a current one.
export function buildStoredUploadFilename(
  sessionId: string,
  filename: string,
  sourceRole: "current" | "legacy" = "current"
) {
  return `${sessionId}-${sourceRole}-${sanitizeUploadedFilename(filename)}`;
}

export function isHttpUrl(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

// The human-facing source-file label derived from a stored upload filename.
// Strips the session id prefix and any internal prefixes (rename marker,
// per-upload UUID, or a `fetched-<timestamp>-<uuid>-` prefix used for sitemaps
// fetched from a URL). This is the value stored in patterns.source_file /
// pattern_file_occurrences, and what the rename modal sends back in
// source_files[].
export function displaySourceFilename(sessionId: string, filename: string) {
  const sessionPrefix = `${sessionId}-`;
  const internalPrefix =
    /^(?:(?:renamed|fixed|bulk|transformed|deleted|slashed)-[0-9a-f]+-)?(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-)?(?:fetched-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-)?/i;
  const withoutSession = filename.startsWith(sessionPrefix)
    ? filename.slice(sessionPrefix.length)
    : filename;

  return withoutSession.replace(internalPrefix, "");
}

// Build a unique stored filename for the rewritten copy of a source file,
// preserving its stable display label so subsequent renames/undo still match.
export function buildRenamedStoredFilename(
  sessionId: string,
  displayName: string,
  token: string
) {
  const hexToken = token.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0";

  return `${sessionId}-renamed-${hexToken}-${sanitizeUploadedFilename(displayName)}`;
}

// Build a unique stored filename for the redirect-fixed copy of a source file
// (apply-redirects). Like the renamed variant, it preserves the stable display
// label so displaySourceFilename() still maps it back to the original name.
export function buildRedirectFixedStoredFilename(
  sessionId: string,
  displayName: string,
  token: string
) {
  const hexToken = token.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0";

  return `${sessionId}-fixed-${hexToken}-${sanitizeUploadedFilename(displayName)}`;
}

// Build a unique stored filename for the bulk-pattern-replaced copy of a source
// file. Like the renamed/fixed variants, it preserves the stable display label
// so displaySourceFilename() still maps it back to the original name.
export function buildBulkReplacedStoredFilename(
  sessionId: string,
  displayName: string,
  token: string
) {
  const hexToken = token.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0";

  return `${sessionId}-bulk-${hexToken}-${sanitizeUploadedFilename(displayName)}`;
}

// Build a unique stored filename for the structure-transformed copy of a source
// file. Like the renamed/fixed/bulk variants, it preserves the stable display
// label so displaySourceFilename() still maps it back to the original name.
export function buildTransformedStoredFilename(
  sessionId: string,
  displayName: string,
  token: string
) {
  const hexToken = token.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0";

  return `${sessionId}-transformed-${hexToken}-${sanitizeUploadedFilename(displayName)}`;
}

// Build a unique stored filename for the URL-deleted copy of a source file (a
// rebuild of the original with selected <url> blocks removed). Preserves the
// stable display label so displaySourceFilename() maps it back to the original.
export function buildDeletedUrlsStoredFilename(
  sessionId: string,
  displayName: string,
  token: string
) {
  const hexToken = token.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0";

  return `${sessionId}-deleted-${hexToken}-${sanitizeUploadedFilename(displayName)}`;
}

// Build a unique stored filename for the trailing-slash-fixed copy of a source
// file. Preserves the stable display label like the other edited variants.
export function buildTrailingSlashStoredFilename(
  sessionId: string,
  displayName: string,
  token: string
) {
  const hexToken = token.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "0";

  return `${sessionId}-slashed-${hexToken}-${sanitizeUploadedFilename(displayName)}`;
}

// The filename a sitemap must carry in PRODUCTION, derived from its internal
// stored name.
//
// displaySourceFilename() is the in-app label: it strips the session id and any
// copy-on-write marker (fixed-/renamed-/transformed-/…) but deliberately keeps
// the source-role segment, because "current-foo.xml" vs "legacy-foo.xml" is how
// the UI tells the two roles apart. buildStoredUploadFilename() puts that role
// there — it is OUR prefix, never part of what the client uploaded.
//
// Publishing overwrites a live bucket, so the object key must be the client's
// real filename: uploading "current-aviation-mfg47.xml" would create a second,
// wrongly-named object beside the real "aviation-mfg47.xml" and leave the live
// one stale. Strip exactly one leading role segment to undo the convention.
//
// Caveat: a client file genuinely named "current-x.xml" would be published as
// "x.xml". That is unavoidable without storing the original name separately,
// and is far rarer than the alternative — which mis-names EVERY file.
export function productionFilename(sessionId: string, storedFilename: string) {
  const display = displaySourceFilename(sessionId, storedFilename);

  return display.replace(/^(?:current|legacy)-/, "");
}
