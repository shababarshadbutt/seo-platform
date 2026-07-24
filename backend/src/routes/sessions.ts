import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";

import { ZipArchive } from "archiver";
import type { MultipartFile } from "@fastify/multipart";
import type { FastifyBaseLogger, FastifyPluginAsync } from "fastify";
import type { PoolClient } from "pg";

import { config } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto/secrets.js";
import { pool } from "../db/pool.js";
import { fsErrorResponse } from "../errors/fsErrors.js";
import {
  deleteFromGSC,
  parseServiceAccount,
  type ServiceAccountCredentials
} from "../gsc/deleteSitemap.js";
import {
  generateSessionExport,
  SessionExportNotFoundError,
  type ExportFormat
} from "../exports/sessionExports.js";
import {
  enqueuePendingParseSitemapJobs,
  markSessionComplete,
  resetParsedSitemapCount,
  syncParsedSitemapCountToDb,
  tryFinalizeParsedSession
} from "../jobs/sessionCompletion.js";
import {
  enqueueExtractPatternsJob,
  enqueueParseSitemapJob,
  enqueueParseSitemapJobs,
  enqueueSamplePatternsJob,
  removeSessionJobs
} from "../queue/sitemapQueue.js";
import {
  enqueueApplyRedirectsJob,
  enqueueBulkReplaceJob,
  enqueueBulkReplaceUndoJob
} from "../queue/bulkReplaceQueue.js";
import { FILE_REWRITE_PARALLEL_THRESHOLD } from "../jobs/fileRewritePool.js";
import { isSameDomain, normalizeHost } from "../sitemaps/domain.js";
import { fetchSitemapPreview } from "../sitemaps/fetchPreview.js";
import { lazyStreamSitemapWithoutForeignLocs } from "../sitemaps/foreignLocFilter.js";
import {
  buildRenamedStoredFilename,
  buildStoredUploadFilename,
  buildTransformedStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "../sitemaps/filenames.js";
import { peekRootElement } from "../sitemaps/peek.js";
import {
  parseSitemapSource,
  streamSitemapUrlLocs,
  type ParsedSitemap
} from "../sitemaps/parser.js";
import { rebuildSessionDeletions } from "../sitemaps/urlDeletion.js";
import {
  invalidateSessionZipCache,
  isZipCacheFresh
} from "../exports/sessionZipCache.js";
import { enqueuePreGenerateZipJob } from "../queue/preGenerateZipQueue.js";
import { collectProblemFileGroups } from "../sitemaps/problemFiles.js";
import { previewTrailingSlash } from "../sitemaps/trailingSlashApply.js";
import {
  enqueueDeleteProblemUrlsJob,
  enqueueFixTrailingSlashesJob,
  enqueueFixTrailingSlashesUndoJob,
  enqueueRestoreDeletedUrlsJob
} from "../queue/maintenanceQueue.js";
import {
  buildPatternTemplateRewriter,
  countTemplateParams,
  type LocUrlRewriter,
  rewriteSitemapLocFile
} from "../sitemaps/rewriteLocs.js";
import {
  applyRedirectRule,
  deriveRedirectRule,
  type RedirectRule
} from "../sitemaps/redirectRule.js";
import {
  recomputePatternStatsSql,
  rewriteRedirectSourceFilesOnDisk,
  revertRedirectSourceFilesOnDisk
} from "../sitemaps/redirectApply.js";
import { looksLikeNotFoundUrl } from "../sitemaps/softNotFound.js";
import {
  parseStructure,
  StructureSyntaxError,
  transformUrl,
  validateStructures,
  type ParsedStructure
} from "../sitemaps/transformStructure.js";

type CreateSessionBody = {
  name?: string;
  base_url?: string;
  baseUrl?: string;
  sample_size?: number;
  sampleSize?: number;
  concurrency?: number;
  user_agent?: string;
  userAgent?: string;
};

type SitemapUrlBody = {
  sitemap_url?: string;
  sitemapUrl?: string;
  filename?: string;
  source_role?: SitemapSourceRole;
  sourceRole?: SitemapSourceRole;
};

type SitemapUrlsBody = {
  sitemaps?: SitemapUrlBody[];
};

type SessionParams = {
  id: string;
};

type FileParams = {
  id: string;
  fileId: string;
};

type PatternParams = {
  id: string;
  patternId: string;
};

type FilesListQuery = {
  status?: string;
};

type DeleteFilesBody = {
  file_ids?: unknown;
  gsc_property_url?: unknown;
  gsc_credentials?: unknown;
};

type RestoreFilesBody = {
  file_ids?: unknown;
};

type ExportQuery = {
  format?: string;
};

type FindReplaceBody = {
  find?: string;
  replace?: string;
  matchCase?: boolean;
  match_case?: boolean;
};

type RenameBody = {
  new_template?: string;
  source_files?: unknown[];
};

type TransformBody = {
  new_template?: string;
  current_structure?: string;
  new_structure?: string;
  source_files?: unknown[];
};

type SessionHistoryRow = {
  id: string;
  name: string;
  base_url: string;
  status: string;
  created_at: string;
  mismatched_url_count: string;
  total_urls: string;
  pattern_count: string;
  healthy_count: string;
  warning_count: string;
  broken_count: string;
  health_score: string;
  empty_sitemap_count: string;
};

type StoredSitemapFile = {
  sitemap_file_id: string;
  filename: string;
  is_index: boolean;
  root_element: string | null;
  source_role: SitemapSourceRole;
  parse_job_id?: string;
};

type SavedSitemapUpload = {
  original_filename: string;
  stored_filename: string;
  file_path: string;
  source_role: SitemapSourceRole;
};

type RejectedSitemapUpload = {
  filename: string;
  message: string;
  detected_host?: string;
  expected_host?: string;
};

type SitemapSourceRole = "current" | "legacy";

const allowedSampleSizes = new Set([5, 10, 20]);
const uploadFileWriteConcurrency = 5;
const uploadRouteBodyLimitBytes = 10 * 1024 * 1024 * 1024;
const uploadRouteTimeoutMs = 30 * 60 * 1000;

function parseSampleSize(body: CreateSessionBody) {
  const value = body.sample_size ?? body.sampleSize ?? 10;

  if (!Number.isInteger(value) || !allowedSampleSizes.has(value)) {
    throw new Error("sample_size must be one of 5, 10, or 20");
  }

  return value;
}

function parseConcurrency(body: CreateSessionBody) {
  const value = body.concurrency ?? 10;

  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error("concurrency must be between 1 and 30");
  }

  return value;
}

function parseBaseUrl(body: CreateSessionBody) {
  const value = body.base_url ?? body.baseUrl;

  if (!value) {
    throw new Error("base_url is required");
  }

  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("base_url must be an HTTP or HTTPS URL");
  }

  return url.toString().replace(/\/$/, "");
}

function parseSitemapUrl(body: SitemapUrlBody) {
  const value = body.sitemap_url ?? body.sitemapUrl;

  if (!value) {
    throw new Error("sitemap_url is required");
  }

  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("sitemap_url must be an HTTP or HTTPS URL");
  }

  return url.toString();
}

function parseSourceRole(body: SitemapUrlBody | undefined): SitemapSourceRole {
  const value = body?.source_role ?? body?.sourceRole ?? "current";

  if (value !== "current" && value !== "legacy") {
    throw new Error("source_role must be current or legacy");
  }

  return value;
}

async function parseFetchedFilename(body: SitemapUrlBody) {
  const value = body.filename?.trim();

  if (!value) {
    throw new Error("filename is required");
  }

  if (path.basename(value) !== value) {
    throw new Error("filename must be a stored sitemap filename");
  }

  await access(path.join(config.uploadDir, value));

  return value;
}

function parseUserAgent(body: CreateSessionBody) {
  const value = body.user_agent ?? body.userAgent ?? config.defaultHttpUserAgent;
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("user_agent cannot be empty");
  }

  if (trimmed.length > 512) {
    throw new Error("user_agent must be 512 characters or fewer");
  }

  return trimmed;
}

function badRequest(message: string) {
  return {
    error: "Bad Request",
    message
  };
}

type BulkReplaceValidation =
  | { ok: false; message: string }
  | { ok: true; fromPattern: string; toPattern: string };

// Shared validation for bulk-replace preview/apply: both templates present,
// distinct, and carrying the same number of {param} placeholders (so each
// captured value maps to exactly one target slot).
function validateBulkReplacePatterns(body: {
  from_pattern?: unknown;
  to_pattern?: unknown;
}): BulkReplaceValidation {
  const fromPattern =
    typeof body.from_pattern === "string" ? body.from_pattern.trim() : "";
  const toPattern =
    typeof body.to_pattern === "string" ? body.to_pattern.trim() : "";

  if (fromPattern.length === 0) {
    return { ok: false, message: "from_pattern is required" };
  }

  if (toPattern.length === 0) {
    return { ok: false, message: "to_pattern is required" };
  }

  if (fromPattern === toPattern) {
    return { ok: false, message: "to_pattern must differ from from_pattern" };
  }

  const fromParams = countTemplateParams(fromPattern);
  const toParams = countTemplateParams(toPattern);

  if (fromParams !== toParams) {
    return {
      ok: false,
      message: `From pattern has ${fromParams} params but To pattern has ${toParams} — counts must match`
    };
  }

  return { ok: true, fromPattern, toPattern };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The clean on-server filename for a download: the display name with the
// current-/legacy- source-role prefix also stripped, so the file matches the
// name the SEO team originally uploaded and can drop back onto their server.
function downloadDisplayName(sessionId: string, filename: string) {
  return displaySourceFilename(sessionId, filename).replace(
    /^(?:current|legacy)-/,
    ""
  );
}

// A stored filename is a rewritten (edited) copy when it carries a fix/rename/
// bulk marker right after the session id prefix. Anchored to the session id so
// a display name that merely contains "-fixed-" can't false-positive.
function isEditedStoredFilename(sessionId: string, filename: string) {
  return (
    filename.startsWith(`${sessionId}-fixed-`) ||
    filename.startsWith(`${sessionId}-renamed-`) ||
    filename.startsWith(`${sessionId}-bulk-`) ||
    filename.startsWith(`${sessionId}-transformed-`) ||
    filename.startsWith(`${sessionId}-deleted-`) ||
    filename.startsWith(`${sessionId}-slashed-`)
  );
}

// Derived display status for a sitemap file in the Files management view.
// Deleted wins over everything; otherwise invalid > empty > active.
type SitemapFileStatus = "active" | "deleted" | "empty" | "invalid";

function sitemapFileStatus(row: {
  is_deleted: boolean;
  is_valid: boolean;
  is_empty: boolean;
}): SitemapFileStatus {
  if (row.is_deleted) {
    return "deleted";
  }

  if (!row.is_valid) {
    return "invalid";
  }

  if (row.is_empty) {
    return "empty";
  }

  return "active";
}

// Accept a pasted GSC service-account key as either raw JSON or base64-encoded
// JSON (the API contract documents base64) and return the raw JSON string.
function decodeGscCredentialsInput(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();

    if (decoded.startsWith("{")) {
      return decoded;
    }
  } catch {
    // fall through — treat the original input as-is
  }

  return trimmed;
}

// Validate a body-supplied file_ids array into a de-duplicated list of UUID
// strings. Returns an error message string when the shape is wrong.
function parseFileIds(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "file_ids must be a non-empty array" };
  }

  const ids = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { error: "file_ids must contain only non-empty strings" };
    }

    ids.add(entry.trim());
  }

  return [...ids];
}

// Detect the URL path prefix an existing sitemap index uses for its child
// <loc> entries (e.g. "/sitemaps/"), so a regenerated index keeps the same
// layout. Returns null when it can't be determined.
async function detectIndexBasePath(
  storedFilename: string
): Promise<string | null> {
  if (storedFilename.toLowerCase().endsWith(".gz")) {
    return null;
  }

  try {
    const content = await readFile(
      path.join(config.uploadDir, storedFilename),
      "utf8"
    );
    const match = content.match(/<loc>\s*([^<]+?)\s*<\/loc>/i);

    if (!match) {
      return null;
    }

    const url = new URL(match[1].trim().replace(/&amp;/g, "&"));
    const lastSlash = url.pathname.lastIndexOf("/");

    return lastSlash >= 0 ? url.pathname.slice(0, lastSlash + 1) : "/";
  } catch {
    return null;
  }
}

// Build a <sitemapindex> listing the given display filenames under the session
// base URL, reusing an existing index's path layout when one is available.
async function buildSitemapIndexXml(options: {
  baseUrl: string;
  indexStoredFilename: string | null;
  displayNames: string[];
  today: string;
}): Promise<string> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let basePath = "/sitemaps/";

  if (options.indexStoredFilename) {
    const detected = await detectIndexBasePath(options.indexStoredFilename);

    if (detected) {
      basePath = detected;
    }
  }

  if (!basePath.startsWith("/")) {
    basePath = `/${basePath}`;
  }

  if (!basePath.endsWith("/")) {
    basePath = `${basePath}/`;
  }

  const entries = options.displayNames
    .map(
      (name) =>
        `  <sitemap>\n    <loc>${escapeXml(
          `${baseUrl}${basePath}${name}`
        )}</loc>\n    <lastmod>${options.today}</lastmod>\n  </sitemap>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

// A URL-safe slug of a session name, for the download filename.
export function sessionSlug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "session"
  );
}

// A fully-resolved plan for one download ZIP: the concrete source files to
// include (with clean display names + gzip flag), the base-URL host used to
// strip foreign <loc>s, and the regenerated sitemap-index.xml. Deliberately
// plain, structured-clone-serialisable data so the same plan can be handed to
// the piscina ZIP worker thread (see workers/zipWorker.ts) as well as the
// on-demand streamer below. Null when the session has no local sitemap files of
// the requested type.
export type SessionZipPlan = {
  expectedHost: string;
  indexXml: string;
  indexName: string;
  zipName: string;
  files: Array<{ sourcePath: string; displayName: string; isGzip: boolean }>;
};

// Do all the DB / filesystem lookups for a download ZIP and return a serialisable
// plan. Kept separate from the archiving so the CPU-heavy archive build can run
// off the main thread (worker) or be streamed inline (on-demand endpoint).
export async function resolveSessionZipPlan(
  sessionId: string,
  downloadType: "all" | "edited",
  // File IDs to skip entirely (v1.31 Fix 5 "Exclude X files & download"). Excluded
  // files are dropped from the ZIP and from the regenerated index — not included
  // as empty/filtered entries. Never used by the cached/pre-generated path.
  excludeFileIds: string[] = []
): Promise<SessionZipPlan | null> {
  const sessionResult = await pool.query<{ name: string; base_url: string }>(
    "SELECT name, base_url FROM sessions WHERE id = $1",
    [sessionId]
  );

  if (sessionResult.rowCount === 0) {
    return null;
  }

  const session = sessionResult.rows[0];

  const filesResult = await pool.query<{
    id: string;
    filename: string;
    is_index: boolean;
  }>(
    `
      SELECT id, filename, is_index
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
      ORDER BY filename ASC
    `,
    [sessionId]
  );

  const excluded = new Set(excludeFileIds);
  const localRows = filesResult.rows.filter(
    (row) => !isHttpUrl(row.filename) && !excluded.has(row.id)
  );
  const indexStoredFilename =
    localRows.find((row) => row.is_index)?.filename ?? null;
  let childRows = localRows.filter((row) => !row.is_index);

  if (downloadType === "edited") {
    childRows = childRows.filter((row) =>
      isEditedStoredFilename(sessionId, row.filename)
    );
  }

  const files: SessionZipPlan["files"] = [];

  for (const row of childRows) {
    const sourcePath = path.join(config.uploadDir, row.filename);

    try {
      await access(sourcePath);
    } catch {
      continue;
    }

    files.push({
      sourcePath,
      displayName: downloadDisplayName(sessionId, row.filename),
      isGzip: row.filename.toLowerCase().endsWith(".gz")
    });
  }

  if (files.length === 0) {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const indexXml = await buildSitemapIndexXml({
    baseUrl: session.base_url,
    indexStoredFilename,
    displayNames: files.map((file) => file.displayName),
    today
  });

  return {
    expectedHost: expectedHostFromBaseUrl(session.base_url),
    indexXml,
    indexName: "sitemap-index.xml",
    zipName: `${sessionSlug(session.name)}-${downloadType}-sitemaps-${today}.zip`,
    files
  };
}

// Shared builder for the download ZIP used by the on-demand download endpoint:
// streams each surviving source file in under its clean display name (foreign-
// domain <loc>s stripped) plus a regenerated sitemap-index.xml. Returns a
// not-yet-finalized archive (the caller attaches an error handler, finalizes,
// and pipes it) and the download filename, or null when there are no files of
// the requested type. The background pre-generation job builds the same archive
// off-thread via the piscina pool (see jobs/zipPool.ts + workers/zipWorker.ts).
export async function buildSessionZipArchive(
  sessionId: string,
  downloadType: "all" | "edited",
  options: {
    filtered?: boolean;
    excludeFileIds?: string[];
    trackProgress?: boolean;
  } = {}
): Promise<{ archive: ZipArchive; zipName: string } | null> {
  // filtered (default): strip foreign-domain <loc>s per file (the corrected
  // sitemaps the SEO team publishes). unfiltered: copy each source file in
  // verbatim, so cross-domain migration sitemaps download intact — used by the
  // "Download original" option. Unfiltered downloads are never cached (they are
  // just the raw originals).
  const filtered = options.filtered !== false;
  const plan = await resolveSessionZipPlan(
    sessionId,
    downloadType,
    options.excludeFileIds ?? []
  );

  if (!plan) {
    return null;
  }

  // On-demand progress (v1.31 Fix 2): report each entry as archiver processes it
  // so the results page's download overlay can show a live percentage + file
  // count. Best-effort — a failed progress write must never break the download.
  const totalEntries = plan.files.length + 1; // + regenerated sitemap-index.xml
  if (options.trackProgress) {
    void pool
      .query(
        "UPDATE sessions SET zip_progress = 0, zip_progress_file = 0 WHERE id = $1",
        [sessionId]
      )
      .catch(() => {});
  }

  // Level 0 = STORE (no compression): speed over size for large sessions, and
  // byte-for-byte identical to the pre-generated cache (v1.34).
  const archive = new ZipArchive({ zlib: { level: 0 } });

  if (options.trackProgress) {
    let entriesDone = 0;
    archive.on("entry", () => {
      entriesDone += 1;
      const percent = Math.min(
        100,
        Math.round((entriesDone / totalEntries) * 100)
      );
      void pool
        .query(
          "UPDATE sessions SET zip_progress = $2, zip_progress_file = $3 WHERE id = $1",
          [sessionId, percent, entriesDone]
        )
        .catch(() => {});
    });
  }

  // Opt-in per-file diagnostics (DEBUG_ZIP=1). Logs each entry's source size,
  // bytes actually streamed out, and kept/removed <url> counts so a truncated
  // entry (bytesOut far below sourceBytes) can be told apart from a fully
  // domain-stripped one (keptCount === 0). Off by default → zero overhead.
  const debugZip = process.env.DEBUG_ZIP === "1";

  let entryIndex = 0;

  for (const file of plan.files) {
    const index = entryIndex++;

    if (!filtered) {
      // Raw copy — archive.file() uses a lazystream wrapper internally, so files
      // are still opened one at a time (no eager-stream truncation).
      archive.file(file.sourcePath, { name: file.displayName });
      continue;
    }

    const sourceBytes = debugZip
      ? await stat(file.sourcePath).then((s) => s.size).catch(() => -1)
      : 0;

    // Lazy source: archiver opens/streams each file only when it reaches that
    // entry. Appending eagerly-created streams here opened all files at once and
    // truncated every entry past ~#37 to near-empty in large multi-file ZIPs.
    archive.append(
      lazyStreamSitemapWithoutForeignLocs({
        inputPath: file.sourcePath,
        isGzip: file.isGzip,
        expectedHost: plan.expectedHost,
        onComplete: debugZip
          ? (streamStats) => {
              // eslint-disable-next-line no-console
              console.log(
                `[DEBUG_ZIP] session=${sessionId} type=${downloadType} ` +
                  `#${index} name=${file.displayName} sourceBytes=${sourceBytes} ` +
                  `bytesOut=${streamStats.bytesOut} kept=${streamStats.keptCount} ` +
                  `removed=${streamStats.removedCount} host=${plan.expectedHost}`
              );
            }
          : undefined
      }),
      { name: file.displayName }
    );
  }

  if (debugZip) {
    // eslint-disable-next-line no-console
    console.log(
      `[DEBUG_ZIP] session=${sessionId} type=${downloadType} filtered=${filtered} entries=${plan.files.length}`
    );
  }

  archive.append(plan.indexXml, { name: plan.indexName });

  return { archive, zipName: plan.zipName };
}

// Literal find/replace (never regex from the user's perspective). A function
// replacement is used so "$" in the replacement string is not interpreted.
function applyFindReplace(
  value: string,
  find: string,
  replace: string,
  matchCase: boolean
) {
  if (matchCase) {
    return value.split(find).join(replace);
  }

  return value.replace(new RegExp(escapeRegExp(find), "gi"), () => replace);
}

// Recompute a pattern's redirect_pct / confidence_pct from its samples using the
// same weighting as the sampling job (success=1, soft_404=0.25, redirect=0.5,
// failure=0). Kept identical everywhere so apply-redirects and its undo are
// exact inverses. $1 = pattern id.
// Normalised path used to line up a sampled_urls.url (a full URL) with a
// pattern_urls.path (a bare path), so redirect candidates can be flagged as
// HTTP-verified vs inferred. (v1.42)
function pathKey(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

function urlContainsFind(value: string, find: string, matchCase: boolean) {
  if (find.length === 0) {
    return false;
  }

  return matchCase
    ? value.includes(find)
    : value.toLowerCase().includes(find.toLowerCase());
}

// Per-source-file occurrence breakdown for a pattern. Accurate per-file counts
// are persisted in pattern_file_occurrences during extraction (one row per
// contributing file; the counts sum to patterns.total_urls). For patterns
// extracted before that table existed we fall back to splitting the pattern's
// source_file column and distributing the total evenly.
async function patternSourceFileBreakdown(
  patternId: string,
  totalUrls: number,
  fallbackSourceFile: string | null
): Promise<Array<{ source_file: string; occurrences: number }>> {
  const occurrences = await pool.query<{
    source_file: string;
    occurrence_count: string;
  }>(
    `
      SELECT source_file, occurrence_count
      FROM pattern_file_occurrences
      WHERE pattern_id = $1
      ORDER BY occurrence_count DESC, source_file ASC
    `,
    [patternId]
  );

  if (occurrences.rows.length > 0) {
    return occurrences.rows.map((row) => ({
      source_file: row.source_file,
      occurrences: Number(row.occurrence_count)
    }));
  }

  const files = (fallbackSourceFile ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);

  if (files.length === 0) {
    return [];
  }

  const per = Math.round(totalUrls / files.length);

  return files.map((file) => ({ source_file: file, occurrences: per }));
}

type PatternFileRewrite = {
  // Stored filenames written this call (for pattern_renames.renamed_file_path).
  renamedStoredFilenames: string[];
  // Original files to unlink AFTER the DB transaction commits.
  oldFilePaths: string[];
  // Newly written files to unlink if the DB transaction rolls back.
  newFilePaths: string[];
  rewrittenLocCount: number;
};

// Rewrite the <loc> URLs of a pattern's selected source files on disk so their
// path segments reflect the rename (old template -> new template). Writes each
// modified file to a fresh uniquely-named copy and repoints
// sitemap_files.filename at it within the caller's transaction. Old files are
// NOT deleted here — the caller unlinks oldFilePaths only after COMMIT and
// unlinks newFilePaths on ROLLBACK, so a failure never destroys the original.
async function rewritePatternSourceFilesOnDisk(
  client: PoolClient,
  options: {
    sessionId: string;
    sourceRole: string;
    oldTemplate: string;
    newTemplate: string;
    selectedDisplayFiles: string[];
  }
): Promise<PatternFileRewrite> {
  const selectedSet = new Set(options.selectedDisplayFiles);
  const filesResult = await client.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2
    `,
    [options.sessionId, options.sourceRole]
  );
  // Order-based param mapping: carries each {param} value across even when the
  // new template changes segment count (e.g. inserting /aviation/). The old
  // index-based rewriter left a literal {param} (URL-encoded to %7Bparam%7D) in
  // that case — the "extra content in downloaded URLs" bug.
  const rewriteUrl = buildPatternTemplateRewriter(
    options.oldTemplate,
    options.newTemplate
  );
  const result: PatternFileRewrite = {
    renamedStoredFilenames: [],
    oldFilePaths: [],
    newFilePaths: [],
    rewrittenLocCount: 0
  };

  for (const file of filesResult.rows) {
    // URL-sourced entries are not stored on disk as rewritable local files.
    if (isHttpUrl(file.filename)) {
      continue;
    }

    const displayName = displaySourceFilename(options.sessionId, file.filename);

    if (selectedSet.size > 0 && !selectedSet.has(displayName)) {
      continue;
    }

    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      // File already cleaned up / missing — nothing to rewrite for this row.
      continue;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const newStored = buildRenamedStoredFilename(
      options.sessionId,
      displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);

    const rewrittenLocCount = await rewriteSitemapLocFile({
      inputPath,
      outputPath,
      isGzip,
      rewriteUrl
    });

    result.newFilePaths.push(outputPath);
    await client.query(
      "UPDATE sitemap_files SET filename = $1 WHERE id = $2",
      [newStored, file.id]
    );
    result.renamedStoredFilenames.push(newStored);
    result.oldFilePaths.push(inputPath);
    result.rewrittenLocCount += rewrittenLocCount;
  }

  return result;
}

type PatternFileTransform = {
  // Parallel arrays (same index = same file) recorded on the pattern_transforms
  // row: the pre-transform stored filename and the repointed post-transform one.
  oldStoredFilenames: string[];
  newStoredFilenames: string[];
  // Newly written files to unlink if the DB transaction ROLLS BACK.
  newFilePaths: string[];
  rewrittenLocCount: number;
};

// Rewrite a pattern's selected source files with an arbitrary per-URL rewriter
// (the structure transform), repointing sitemap_files.filename at a fresh copy.
// Unlike the rename rewriter this DOES NOT delete the previous file — a transform
// can be lossy, so its pre-transform copy is kept on disk and its filename
// recorded so undo can restore it. Files with no matching <loc> are left as-is.
async function transformPatternSourceFilesOnDisk(
  client: PoolClient,
  options: {
    sessionId: string;
    sourceRole: string;
    selectedDisplayFiles: string[];
    rewriteUrl: LocUrlRewriter;
  }
): Promise<PatternFileTransform> {
  const selectedSet = new Set(options.selectedDisplayFiles);
  const filesResult = await client.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = $2
    `,
    [options.sessionId, options.sourceRole]
  );
  const result: PatternFileTransform = {
    oldStoredFilenames: [],
    newStoredFilenames: [],
    newFilePaths: [],
    rewrittenLocCount: 0
  };

  for (const file of filesResult.rows) {
    if (isHttpUrl(file.filename)) {
      continue;
    }

    const displayName = displaySourceFilename(options.sessionId, file.filename);

    if (selectedSet.size > 0 && !selectedSet.has(displayName)) {
      continue;
    }

    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      continue;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const newStored = buildTransformedStoredFilename(
      options.sessionId,
      displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);

    let rewrittenLocCount = 0;

    try {
      rewrittenLocCount = await rewriteSitemapLocFile({
        inputPath,
        outputPath,
        isGzip,
        rewriteUrl: options.rewriteUrl
      });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    if (rewrittenLocCount === 0) {
      // Nothing matched — discard the identical copy and leave the original.
      await unlink(outputPath).catch(() => {});
      continue;
    }

    result.newFilePaths.push(outputPath);
    await client.query(
      "UPDATE sitemap_files SET filename = $1 WHERE id = $2",
      [newStored, file.id]
    );
    result.oldStoredFilenames.push(file.filename);
    result.newStoredFilenames.push(newStored);
    result.rewrittenLocCount += rewrittenLocCount;
  }

  return result;
}

async function unlinkQuietly(filePaths: string[], logger: FastifyBaseLogger) {
  for (const filePath of filePaths) {
    try {
      await unlink(filePath);
    } catch (error) {
      logger.warn(
        { file_path: filePath, error },
        "failed to remove file during pattern rename cleanup"
      );
    }
  }
}

async function directorySizeBytes(directoryPath: string): Promise<number> {
  let entries;

  try {
    entries = await readdir(directoryPath, {
      withFileTypes: true
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }

    throw error;
  }

  let totalBytes = 0;

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      totalBytes += await directorySizeBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        totalBytes += (await stat(entryPath)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  return totalBytes;
}

function isXmlFilename(filename: string) {
  return filename.toLowerCase().endsWith(".xml");
}

// Delete every uploaded file on disk for a session (stored names are prefixed
// with "<sessionId>-"). Used when an analysis is cancelled.
async function removeSessionUploadFiles(
  sessionId: string,
  logger: FastifyBaseLogger
) {
  const prefix = `${sessionId}-`;
  let entries;

  try {
    entries = await readdir(config.uploadDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }

    throw error;
  }

  let deletedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) {
      continue;
    }

    try {
      await unlink(path.join(config.uploadDir, entry.name));
      deletedCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          { session_id: sessionId, filename: entry.name, error },
          "failed to delete cancelled session upload file"
        );
      }
    }
  }

  return deletedCount;
}

async function drainMultipartFile(uploadedFile: MultipartFile) {
  uploadedFile.file.resume();
  await finished(uploadedFile.file);
}

function expectedHostFromBaseUrl(baseUrl: string) {
  return normalizeHost(new URL(baseUrl).hostname);
}

function detectedHostFromUrl(value: string) {
  const url = new URL(value);

  return normalizeHost(url.hostname);
}

function sitemapUrlDomainMismatchMessage(
  sitemapUrl: string,
  expectedHost: string
) {
  const detectedHost = detectedHostFromUrl(sitemapUrl);

  if (isSameDomain(detectedHost, expectedHost)) {
    return null;
  }

  return `Sitemap URL appears to belong to ${detectedHost}, not ${expectedHost}. Please use sitemaps for the same site.`;
}

async function createStoredSitemapFile(
  sessionId: string,
  storedFilename: string,
  sourceRole: SitemapSourceRole
): Promise<StoredSitemapFile> {
  const filePath = path.join(config.uploadDir, storedFilename);
  const rootElement = await peekRootElement(filePath);
  const isIndex = rootElement === "sitemapindex";
  const fileResult = await pool.query<{ id: string }>(
    `
      WITH inserted AS (
        INSERT INTO sitemap_files (
          session_id,
          filename,
          total_urls,
          is_valid,
          is_index,
          source_role
        )
        VALUES ($1, $2, 0, TRUE, $3, $4)
        ON CONFLICT (session_id, filename) DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION ALL
      SELECT id
      FROM sitemap_files
      WHERE session_id = $1
        AND filename = $2
      LIMIT 1
    `,
    [sessionId, storedFilename, isIndex, sourceRole]
  );
  const sitemapFileId = fileResult.rows[0].id;

  return {
    sitemap_file_id: sitemapFileId,
    filename: storedFilename,
    is_index: isIndex,
    root_element: rootElement,
    source_role: sourceRole
  };
}

async function enqueueStoredSitemapFile(
  sessionId: string,
  storedSitemapFile: StoredSitemapFile,
  logger: FastifyBaseLogger
) {
  const job = await enqueueParseSitemapJob({
    sitemap_file_id: storedSitemapFile.sitemap_file_id,
    session_id: sessionId
  });

  storedSitemapFile.parse_job_id = job.id;
  logger.info(
    {
      session_id: sessionId,
      sitemap_file_id: storedSitemapFile.sitemap_file_id,
      filename: storedSitemapFile.filename,
      job_id: job.id
    },
    "parse sitemap job enqueued"
  );

  return storedSitemapFile;
}

async function enqueueStoredSitemapFiles(
  sessionId: string,
  storedSitemapFiles: StoredSitemapFile[],
  logger: FastifyBaseLogger
) {
  const jobs = await enqueueParseSitemapJobs(
    storedSitemapFiles.map((storedSitemapFile) => ({
      sitemap_file_id: storedSitemapFile.sitemap_file_id,
      session_id: sessionId
    }))
  );

  for (let index = 0; index < storedSitemapFiles.length; index += 1) {
    storedSitemapFiles[index].parse_job_id = jobs[index]?.id;
  }

  logger.info(
    {
      session_id: sessionId,
      file_count: storedSitemapFiles.length,
      job_count: jobs.length
    },
    "parse sitemap jobs enqueued in batches"
  );

  return storedSitemapFiles;
}

async function storeUploadedSitemapFile(
  sessionId: string,
  uploadedFile: MultipartFile
): Promise<SavedSitemapUpload> {
  if (!isXmlFilename(uploadedFile.filename)) {
    uploadedFile.file.resume();
    throw new Error("Only .xml files are supported");
  }

  const sourceRole: SitemapSourceRole =
    uploadedFile.fieldname === "legacy_files" ? "legacy" : "current";
  const storedFilename = buildStoredUploadFilename(
    sessionId,
    uploadedFile.filename,
    sourceRole
  );
  const filePath = path.join(config.uploadDir, storedFilename);

  await pipeline(uploadedFile.file, createWriteStream(filePath));

  return {
    original_filename: uploadedFile.filename,
    stored_filename: storedFilename,
    file_path: filePath,
    source_role: sourceRole
  };
}

async function processUploadedSitemapFile(
  sessionId: string,
  uploadedFile: MultipartFile,
  expectedHost: string,
  uploadedFiles: StoredSitemapFile[],
  rejectedFiles: RejectedSitemapUpload[],
  logger: FastifyBaseLogger
) {
  if (!isXmlFilename(uploadedFile.filename)) {
    await drainMultipartFile(uploadedFile);
    rejectedFiles.push({
      filename: uploadedFile.filename,
      expected_host: expectedHost,
      message: "Only .xml files are supported"
    });
    return;
  }

  // Mixed-domain files are NOT rejected here: a file may legitimately hold a
  // few foreign-domain <loc>s alongside many valid ones. Those foreign URLs are
  // filtered out per-URL during pattern extraction (parseLocForExtraction), counted
  // as sitemap_files.mismatched_url_count, and recorded in mismatched_urls — so
  // the valid URLs still enter the pipeline instead of the whole file being lost.
  const savedUpload = await storeUploadedSitemapFile(sessionId, uploadedFile);

  uploadedFiles.push(
    await createStoredSitemapFile(
      sessionId,
      savedUpload.stored_filename,
      savedUpload.source_role
    )
  );
}

async function processUploadedSitemapStream(
  sessionId: string,
  uploadedFileParts: AsyncIterable<MultipartFile>,
  expectedHost: string,
  logger: FastifyBaseLogger
) {
  await mkdir(config.uploadDir, {
    recursive: true
  });

  const uploadedFiles: StoredSitemapFile[] = [];
  const rejectedFiles: RejectedSitemapUpload[] = [];
  const activeWrites = new Set<Promise<void>>();
  let firstError: unknown = null;
  let receivedFileCount = 0;

  for await (const uploadedFile of uploadedFileParts) {
    receivedFileCount += 1;

    if (firstError) {
      await drainMultipartFile(uploadedFile);
      continue;
    }

    let writeTask: Promise<void>;
    writeTask = processUploadedSitemapFile(
      sessionId,
      uploadedFile,
      expectedHost,
      uploadedFiles,
      rejectedFiles,
      logger
    )
      .catch((error) => {
        firstError ??= error;
        logger.error(
          {
            session_id: sessionId,
            filename: uploadedFile.filename,
            error
          },
          "failed to process uploaded sitemap file"
        );
      })
      .finally(() => {
        activeWrites.delete(writeTask);
      });

    activeWrites.add(writeTask);

    if (activeWrites.size >= uploadFileWriteConcurrency) {
      await Promise.race(activeWrites);
    }
  }

  while (activeWrites.size > 0) {
    await Promise.race(activeWrites);
  }

  if (firstError) {
    throw firstError;
  }

  if (uploadedFiles.length === 0) {
    await pool.query("UPDATE sessions SET status = 'FAILED' WHERE id = $1", [
      sessionId
    ]);
    logger.warn(
      {
        session_id: sessionId,
        received_file_count: receivedFileCount,
        rejected_file_count: rejectedFiles.length,
        rejected_files: rejectedFiles
      },
      "sitemap upload completed without accepted XML files"
    );
    return {
      uploadedFiles,
      rejectedFiles,
      receivedFileCount
    };
  }

  logger.info(
    {
      session_id: sessionId,
      received_file_count: receivedFileCount,
      accepted_file_count: uploadedFiles.length,
      rejected_file_count: rejectedFiles.length,
      rejected_files: rejectedFiles
    },
    "sitemap upload stream processed"
  );

  return {
    uploadedFiles,
    rejectedFiles,
    receivedFileCount
  };
}

async function markUploadFailed(
  sessionId: string,
  logger: FastifyBaseLogger,
  error: unknown
) {
  logger.error(
    {
      session_id: sessionId,
      error
    },
    "sitemap upload background processing failed"
  );
  await pool.query("UPDATE sessions SET status = 'FAILED' WHERE id = $1", [
    sessionId
  ]);
}

function sitemapUrlPreview(sitemapUrl: string, parsed: ParsedSitemap) {
  const hasSitemapRoot =
    parsed.rootElement === "urlset" || parsed.rootElement === "sitemapindex";

  return {
    sitemap_url: sitemapUrl,
    root_element: parsed.rootElement,
    total_urls: parsed.totalUrls,
    child_sitemap_count: parsed.childSitemapUrls.length,
    is_valid: parsed.isValid && hasSitemapRoot,
    parse_error:
      parsed.parseError ??
      (hasSitemapRoot ? null : "URL did not return a sitemap XML document."),
    had_preamble_stripped: parsed.hadPreambleStripped
  };
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/system/disk", async () => {
    const uploadStorageBytes = await directorySizeBytes(config.uploadDir);

    return {
      upload_storage_bytes: uploadStorageBytes,
      upload_storage_mb: Number((uploadStorageBytes / 1024 / 1024).toFixed(2))
    };
  });

  app.get("/api/sessions", async () => {
    const result = await pool.query<SessionHistoryRow>(
      `
        WITH file_totals AS (
          SELECT
            session_id,
            COALESCE(SUM(total_urls) FILTER (WHERE source_role = 'current'), 0)::bigint AS total_urls,
            COUNT(*) FILTER (WHERE is_empty = TRUE)::bigint
              AS empty_sitemap_count,
            COALESCE(SUM(mismatched_url_count) FILTER (WHERE source_role = 'current'), 0)::bigint
              AS mismatched_url_count
          FROM sitemap_files
          GROUP BY session_id
        ),
        pattern_totals AS (
          SELECT
            session_id,
            COUNT(*)::bigint AS pattern_count,
            COUNT(*) FILTER (WHERE status = 'GOOD')::bigint AS healthy_count,
            COUNT(*) FILTER (WHERE status = 'WARNING')::bigint AS warning_count,
            COUNT(*) FILTER (WHERE status = 'BAD')::bigint AS broken_count,
            COALESCE(
              ROUND(
                SUM(COALESCE(confidence_pct, 0) * coverage_pct)
                  / NULLIF(SUM(coverage_pct), 0)
              ),
              0
            )::integer AS health_score
          FROM patterns
          WHERE source_role = 'current'
          GROUP BY session_id
        )
        SELECT
          sessions.id,
          sessions.name,
          sessions.base_url,
          sessions.status,
          sessions.created_at,
          COALESCE(file_totals.mismatched_url_count, 0)::bigint
            AS mismatched_url_count,
          COALESCE(file_totals.total_urls, 0)::bigint AS total_urls,
          COALESCE(file_totals.empty_sitemap_count, 0)::bigint
            AS empty_sitemap_count,
          COALESCE(pattern_totals.pattern_count, 0)::bigint AS pattern_count,
          COALESCE(pattern_totals.healthy_count, 0)::bigint AS healthy_count,
          COALESCE(pattern_totals.warning_count, 0)::bigint AS warning_count,
          COALESCE(pattern_totals.broken_count, 0)::bigint AS broken_count,
          COALESCE(pattern_totals.health_score, 0)::integer AS health_score
        FROM sessions
        LEFT JOIN file_totals
          ON file_totals.session_id = sessions.id
        LEFT JOIN pattern_totals
          ON pattern_totals.session_id = sessions.id
        ORDER BY sessions.created_at DESC
      `
    );

    return {
      sessions: result.rows
    };
  });

  app.post<{ Body: CreateSessionBody }>("/api/sessions", async (request, reply) => {
    try {
      const name = request.body?.name?.trim();

      if (!name) {
        return reply.code(400).send(badRequest("name is required"));
      }

      const baseUrl = parseBaseUrl(request.body ?? {});
      const sampleSize = parseSampleSize(request.body ?? {});
      const concurrency = parseConcurrency(request.body ?? {});
      const userAgent = parseUserAgent(request.body ?? {});
      const result = await pool.query<{ id: string }>(
        `
          INSERT INTO sessions (
            name,
            base_url,
            sample_size,
            concurrency,
            user_agent
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `,
        [name, baseUrl, sampleSize, concurrency, userAgent]
      );
      const sessionId = result.rows[0].id;

      await resetParsedSitemapCount(sessionId);

      return reply.code(201).send({
        session_id: sessionId
      });
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send(badRequest(error.message));
      }

      throw error;
    }
  });

  app.post<{ Body: SitemapUrlBody }>(
    "/api/fetch-sitemap",
    async (request, reply) => {
      try {
        const sitemapUrl = parseSitemapUrl(request.body ?? {});

        return await fetchSitemapPreview(sitemapUrl);
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }
    }
  );

  app.post<{ Body: SitemapUrlBody }>(
    "/api/sitemap-url/preview",
    async (request, reply) => {
      try {
        const sitemapUrl = parseSitemapUrl(request.body ?? {});
        const parsed = await parseSitemapSource(sitemapUrl);

        return sitemapUrlPreview(sitemapUrl, parsed);
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }
    }
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/upload",
    {
      bodyLimit: uploadRouteBodyLimitBytes,
      onRequest: (request, reply, done) => {
        request.raw.setTimeout(uploadRouteTimeoutMs);
        reply.raw.setTimeout(uploadRouteTimeoutMs);
        done();
      }
    },
    async (request, reply) => {
      const sessionId = request.params.id;
      const sessionResult = await pool.query<{ base_url: string }>(
        "SELECT base_url FROM sessions WHERE id = $1::uuid",
        [sessionId]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const expectedHost = expectedHostFromBaseUrl(
        sessionResult.rows[0].base_url
      );

      await pool.query(
        "UPDATE sessions SET status = 'PROCESSING' WHERE id = $1::uuid AND status = 'PENDING'",
        [sessionId]
      );

      let uploadResult: Awaited<ReturnType<typeof processUploadedSitemapStream>>;

      try {
        uploadResult = await processUploadedSitemapStream(
          sessionId,
          request.files(),
          expectedHost,
          request.log
        );
      } catch (error) {
        await markUploadFailed(sessionId, request.log, error);

        if (error instanceof Error) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }

      if (uploadResult.uploadedFiles.length === 0) {
        // If everything was rejected purely for not being XML, say so plainly
        // instead of the domain-mismatch wording (which confuses SEO users who
        // tried to upload a .txt file).
        const allRejectedForNonXml =
          uploadResult.rejectedFiles.length > 0 &&
          uploadResult.rejectedFiles.every((rejected) =>
            /only \.xml files are supported/i.test(rejected.message)
          );

        return reply.code(400).send({
          ...badRequest(
            allRejectedForNonXml
              ? "Only .xml sitemap files are supported. Please upload XML files."
              : "No uploaded sitemap files matched the session base URL."
          ),
          rejected_files: uploadResult.rejectedFiles
        });
      }

      try {
        // Defer index files: their fan-out must run only after every upload
        // batch has landed, so it can dedupe child URLs against sibling files
        // the user also uploaded. upload-complete enqueues them (via
        // enqueuePendingParseSitemapJobs). Non-index files parse immediately.
        const nonIndexFiles = uploadResult.uploadedFiles.filter(
          (uploadedFile) => !uploadedFile.is_index
        );

        await enqueueStoredSitemapFiles(sessionId, nonIndexFiles, request.log);
      } catch (error) {
        await markUploadFailed(sessionId, request.log, error);
        throw error;
      }

      return reply.code(202).send({
        session_id: sessionId,
        status: "PROCESSING",
        sitemap_file_id: uploadResult.uploadedFiles[0].sitemap_file_id,
        sitemap_files: uploadResult.uploadedFiles,
        rejected_files: uploadResult.rejectedFiles,
        is_index: uploadResult.uploadedFiles[0].is_index,
        root_element: uploadResult.uploadedFiles[0].root_element
      });
    }
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/upload-complete",
    async (request, reply) => {
      const sessionId = request.params.id;
      const result = await pool.query(
        `
          UPDATE sessions
          SET upload_complete = TRUE
          WHERE id = $1::uuid
          RETURNING id
        `,
        [sessionId]
      );

      if (result.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      await enqueuePendingParseSitemapJobs(sessionId, request.log);
      await syncParsedSitemapCountToDb(sessionId);
      await tryFinalizeParsedSession(sessionId, request.log);

      return reply.code(202).send({
        session_id: sessionId,
        upload_complete: true
      });
    }
  );

  app.post<{ Params: SessionParams; Body: SitemapUrlBody }>(
    "/api/sessions/:id/url",
    async (request, reply) => {
      const sessionId = request.params.id;
      const sessionResult = await pool.query<{ base_url: string }>(
        "SELECT base_url FROM sessions WHERE id = $1",
        [sessionId]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      let sitemapUrl: string;
      let storedFilename: string;
      let sourceRole: SitemapSourceRole = "current";

      try {
        sitemapUrl = parseSitemapUrl(request.body ?? {});
        storedFilename = await parseFetchedFilename(request.body ?? {});
        sourceRole = parseSourceRole(request.body);
        const expectedHost = expectedHostFromBaseUrl(
          sessionResult.rows[0].base_url
        );
        const mismatchMessage =
          sourceRole === "current"
            ? sitemapUrlDomainMismatchMessage(sitemapUrl, expectedHost)
            : null;

        if (mismatchMessage) {
          return reply.code(400).send(badRequest(mismatchMessage));
        }
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }

      const storedSitemapFile = await createStoredSitemapFile(
        sessionId,
        storedFilename,
        sourceRole
      );

      await pool.query(
        `
          UPDATE sessions
          SET
            status = 'PROCESSING',
            upload_complete = TRUE
          WHERE id = $1 AND status = 'PENDING'
        `,
        [sessionId]
      );
      await enqueueStoredSitemapFile(sessionId, storedSitemapFile, request.log);

      return reply.code(202).send({
        sitemap_file_id: storedSitemapFile.sitemap_file_id,
        sitemap_url: sitemapUrl,
        filename: storedSitemapFile.filename,
        is_index: storedSitemapFile.is_index,
        root_element: storedSitemapFile.root_element,
        source_role: storedSitemapFile.source_role
      });
    }
  );

  app.post<{ Params: SessionParams; Body: SitemapUrlsBody }>(
    "/api/sessions/:id/urls",
    async (request, reply) => {
      const sessionId = request.params.id;
      const sessionResult = await pool.query<{ base_url: string }>(
        "SELECT base_url FROM sessions WHERE id = $1",
        [sessionId]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const sitemaps = request.body?.sitemaps;

      if (!Array.isArray(sitemaps) || sitemaps.length === 0) {
        return reply
          .code(400)
          .send(badRequest("At least one sitemap URL is required."));
      }

      if (sitemaps.length > 20) {
        return reply
          .code(400)
          .send(badRequest("A maximum of 20 sitemap URLs can be submitted."));
      }

      const expectedHost = expectedHostFromBaseUrl(
        sessionResult.rows[0].base_url
      );
      const parsedSitemaps: Array<{
        sitemap_url: string;
        filename: string;
        source_role: SitemapSourceRole;
      }> = [];

      try {
        for (const sitemap of sitemaps) {
          const sitemapUrl = parseSitemapUrl(sitemap);
          const sourceRole = parseSourceRole(sitemap);
          const mismatchMessage =
            sourceRole === "current"
              ? sitemapUrlDomainMismatchMessage(sitemapUrl, expectedHost)
              : null;

          if (mismatchMessage) {
            return reply.code(400).send(badRequest(mismatchMessage));
          }

          parsedSitemaps.push({
            sitemap_url: sitemapUrl,
            filename: await parseFetchedFilename(sitemap),
            source_role: sourceRole
          });
        }
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }

      const storedSitemapFiles: StoredSitemapFile[] = [];

      try {
        for (const parsedSitemap of parsedSitemaps) {
          storedSitemapFiles.push(
            await createStoredSitemapFile(
              sessionId,
              parsedSitemap.filename,
              parsedSitemap.source_role
            )
          );
        }
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }

      await pool.query(
        `
          UPDATE sessions
          SET
            status = 'PROCESSING',
            upload_complete = TRUE
          WHERE id = $1 AND status = 'PENDING'
        `,
        [sessionId]
      );

      for (const storedSitemapFile of storedSitemapFiles) {
        await enqueueStoredSitemapFile(sessionId, storedSitemapFile, request.log);
      }

      return reply.code(202).send({
        sitemap_file_id: storedSitemapFiles[0].sitemap_file_id,
        sitemap_files: storedSitemapFiles,
        is_index: storedSitemapFiles[0].is_index,
        root_element: storedSitemapFiles[0].root_element
      });
    }
  );

  app.get<{ Params: SessionParams }>("/api/sessions/:id", async (request, reply) => {
    const sessionResult = await pool.query(
      `
        SELECT
          sessions.id,
          sessions.name,
          sessions.base_url,
          sessions.sample_size,
          sessions.concurrency,
          sessions.user_agent,
          sessions.status,
          sessions.upload_complete,
          sessions.created_at,
          sessions.completed_at,
          sessions.zip_all_path,
          sessions.zip_edited_path,
          sessions.zip_generated_at,
          sessions.zip_progress,
          sessions.zip_progress_file,
          sessions.trailing_slash_fixed_at,
          sessions.resume_count,
          sessions.last_failed_at,
          COALESCE(
            SUM(sitemap_files.mismatched_url_count)
              FILTER (WHERE sitemap_files.source_role = 'current'),
            0
          )::bigint
            AS mismatched_url_count
        FROM sessions
        LEFT JOIN sitemap_files
          ON sitemap_files.session_id = sessions.id
        WHERE sessions.id = $1::uuid
        GROUP BY sessions.id
      `,
      [request.params.id]
    );
    const session = sessionResult.rows[0];

    if (!session) {
      return reply.code(404).send({
        error: "Not Found",
        message: "session not found"
      });
    }

    // Connectivity warning (v1.39 Fix 2): when the vast majority of sampled URLs
    // got no HTTP status, the results are almost certainly a network/proxy
    // artifact (e.g. a corporate SSL-inspection proxy) rather than a broken
    // site. sampled_urls has no session_id column, so reach the session through
    // patterns. Only meaningful once enough URLs were actually sampled (>10).
    const connectivityResult = await pool.query<{
      total: string;
      no_response: string;
    }>(
      `
        SELECT
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE sampled_urls.http_status IS NULL)::bigint
            AS no_response
        FROM sampled_urls
        JOIN patterns ON patterns.id = sampled_urls.pattern_id
        WHERE patterns.session_id = $1::uuid
      `,
      [request.params.id]
    );
    const connectivityTotal = Number(connectivityResult.rows[0]?.total ?? 0);
    const connectivityNoResponse = Number(
      connectivityResult.rows[0]?.no_response ?? 0
    );
    session.connectivity_warning =
      connectivityTotal > 10 &&
      connectivityNoResponse / connectivityTotal > 0.9;

    const filesResult = await pool.query(
      `
        SELECT
          id,
          session_id,
          filename,
          source_role,
          total_urls,
          parsed_at,
          is_valid,
          parse_error,
          parse_error_offset,
          is_index,
          had_preamble_stripped,
          is_empty,
          is_deleted,
          deleted_at,
          gsc_deletion_status,
          gsc_deletion_error,
          mismatched_url_count,
          extract_status,
          sample_status,
          (
            filename LIKE (session_id::text || '-fixed-%')
            OR filename LIKE (session_id::text || '-renamed-%')
            OR filename LIKE (session_id::text || '-bulk-%')
          ) AS is_edited
        FROM sitemap_files
        WHERE session_id = $1::uuid
        ORDER BY filename ASC, id ASC
      `,
      [request.params.id]
    );

    // A pre-generated ZIP is "ready" only if the recorded path still exists on
    // disk. Expose the flag (+ timestamp for polling) and drop the raw paths.
    // `zip_generating` is true only for a short window right after completion, so
    // the UI shows a spinner while the background job runs but falls back to an
    // (always-available) on-demand download once it's clearly not coming — the
    // download button must NEVER be blocked indefinitely on ZIP readiness.
    const zipReady = Boolean(session.zip_all_path && existsSync(session.zip_all_path));
    const zipGeneratedAt = session.zip_generated_at;
    const completedAt = session.completed_at;
    const ZIP_GENERATING_WINDOW_MS = 5 * 60 * 1000;
    const zipGenerating =
      !zipReady &&
      Boolean(completedAt) &&
      Date.now() - new Date(completedAt).getTime() < ZIP_GENERATING_WINDOW_MS;

    delete session.zip_all_path;
    delete session.zip_edited_path;
    delete session.zip_generated_at;
    session.zip_ready = zipReady;
    session.zip_generating = zipGenerating;
    session.zip_generated_at = zipGeneratedAt;

    // Self-heal: a completed session with no ready ZIP (e.g. one that finished
    // before this feature, or whose cache was invalidated) gets its download
    // ZIPs (re)generated in the background. Idempotent — the singleton job
    // coalesces and skips when a fresh cache already exists.
    if (
      !zipReady &&
      (session.status === "COMPLETE" || session.status === "COMPLETED")
    ) {
      void enqueuePreGenerateZipJob({
        session_id: request.params.id,
        type: "all"
      }).catch(() => {});
      void enqueuePreGenerateZipJob({
        session_id: request.params.id,
        type: "edited"
      }).catch(() => {});
    }

    return {
      session,
      sitemap_files: filesResult.rows
    };
  });

  app.delete<{ Params: SessionParams }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const result = await pool.query("DELETE FROM sessions WHERE id = $1", [
        request.params.id
      ]);

      if (result.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      // The DB rows cascade away, but the Redis parsed-count key does not —
      // remove it explicitly instead of waiting for its 24h TTL.
      await resetParsedSitemapCount(request.params.id);

      return reply.code(204).send();
    }
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/cancel",
    async (request, reply) => {
      const sessionId = request.params.id;
      const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
        sessionId
      ]);

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      // 1. Flip status first so any already-active job sees CANCELLED at its
      //    next guard check and exits without persisting work.
      await pool.query(
        "UPDATE sessions SET status = 'CANCELLED' WHERE id = $1",
        [sessionId]
      );
      // 2. Drop all not-yet-running jobs for this session.
      const removedJobs = await removeSessionJobs(sessionId);
      // 3. Delete the Redis progress counter.
      await resetParsedSitemapCount(sessionId);
      // 4. Discard all analysis data (session row is kept for history). Deleting
      //    patterns and sitemap_files cascades to samples / partial / mismatch rows.
      await pool.query("DELETE FROM patterns WHERE session_id = $1", [sessionId]);
      await pool.query("DELETE FROM sitemap_files WHERE session_id = $1", [
        sessionId
      ]);
      // 5. Remove uploaded files from disk.
      const removedFiles = await removeSessionUploadFiles(sessionId, request.log);

      request.log.info(
        {
          session_id: sessionId,
          removed_jobs: removedJobs,
          removed_files: removedFiles
        },
        "analysis cancelled"
      );

      return reply.send({
        cancelled: true,
        session_id: sessionId
      });
    }
  );

  // Resume a session that FAILED (or got stuck) partway through processing.
  // Rather than restart from scratch, re-queue only the work that never
  // completed, picking up from the earliest incomplete phase. Each phase
  // auto-chains to the next on completion (parse → extract → sample), so kicking
  // off the earliest incomplete phase is enough to drive the session to
  // COMPLETE. (v1.36 Fix 2)
  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/resume",
    async (request, reply) => {
      const sessionId = request.params.id;
      const sessionResult = await pool.query<{
        status: string;
        upload_complete: boolean;
      }>(
        "SELECT status, upload_complete FROM sessions WHERE id = $1::uuid",
        [sessionId]
      );
      const session = sessionResult.rows[0];

      if (!session) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      // Only sessions that stalled short of completion can be resumed. COMPLETE
      // has nothing left to do; CANCELLED discarded its analysis data; PENDING
      // never began.
      const resumableStates = [
        "FAILED",
        "PROCESSING",
        "EXTRACTING",
        "EXTRACTED",
        "SAMPLING"
      ];

      if (!resumableStates.includes(session.status)) {
        return reply.code(409).send({
          error: "Conflict",
          message: `session cannot be resumed from status ${session.status}`
        });
      }

      // Count the work outstanding in each phase. `extractable` mirrors the
      // predicate loadExtractableFiles / the extract & sample checkpoints use.
      const [unparsed, extractable, patterns] = await Promise.all([
        pool.query<{ id: string }>(
          `
            SELECT id
            FROM sitemap_files
            WHERE session_id = $1::uuid
              AND parsed_at IS NULL
              AND is_valid = TRUE
            ORDER BY id ASC
          `,
          [sessionId]
        ),
        pool.query<{
          total: string;
          extract_done: string;
          sample_done: string;
          fallback_file_id: string | null;
        }>(
          `
            SELECT
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE extract_status = 'done')::bigint
                AS extract_done,
              COUNT(*) FILTER (WHERE sample_status = 'done')::bigint
                AS sample_done,
              MIN(id::text) AS fallback_file_id
            FROM sitemap_files
            WHERE session_id = $1::uuid
              AND parsed_at IS NOT NULL
              AND is_index = FALSE
              AND (
                (is_valid = TRUE AND is_empty = FALSE)
                OR EXISTS (
                  SELECT 1
                  FROM sitemap_partial_urls
                  WHERE sitemap_partial_urls.sitemap_file_id = sitemap_files.id
                )
              )
          `,
          [sessionId]
        ),
        pool.query<{ count: string }>(
          "SELECT COUNT(*)::bigint AS count FROM patterns WHERE session_id = $1::uuid AND source_role = 'current'",
          [sessionId]
        )
      ]);

      const unparsedCount = unparsed.rowCount ?? 0;
      const extractableTotal = Number(extractable.rows[0]?.total ?? 0);
      const extractDone = Number(extractable.rows[0]?.extract_done ?? 0);
      const sampleDone = Number(extractable.rows[0]?.sample_done ?? 0);
      const patternCount = Number(patterns.rows[0]?.count ?? 0);
      const fallbackFileId = extractable.rows[0]?.fallback_file_id ?? null;

      // Flip back to PROCESSING and record the resume before enqueueing so the
      // processing screen immediately reflects the retry.
      await pool.query(
        `
          UPDATE sessions
          SET status = 'PROCESSING',
              resume_count = resume_count + 1,
              last_failed_at = NULL
          WHERE id = $1::uuid
        `,
        [sessionId]
      );
      // Realign the Redis parsed-count with what's actually on disk so the
      // finalize gate (parsed_count >= total_file_count) is accurate on resume.
      await syncParsedSitemapCountToDb(sessionId);

      let phase: "parse" | "extract" | "sample" | "complete";
      let requeuedCount = 0;

      if (unparsedCount > 0) {
        // Earliest incomplete phase is parsing. Re-queue only the unparsed
        // files; the parse → extract → sample chain resumes automatically.
        await enqueueParseSitemapJobs(
          unparsed.rows.map((row) => ({
            sitemap_file_id: row.id,
            session_id: sessionId
          }))
        );
        // In case every remaining file is already terminal, nudge finalization.
        await tryFinalizeParsedSession(sessionId, request.log);
        phase = "parse";
        requeuedCount = unparsedCount;
      } else if (extractableTotal === 0) {
        // No content to extract or sample (e.g. every file empty/invalid).
        await markSessionComplete(sessionId);
        phase = "complete";
      } else if (extractDone < extractableTotal || patternCount === 0) {
        // Extraction never finished — re-run it (idempotent). It chains to
        // sampling once complete.
        await enqueueExtractPatternsJob({
          sitemap_file_id: fallbackFileId ?? "",
          session_id: sessionId
        });
        phase = "extract";
        requeuedCount = extractableTotal - extractDone;
      } else if (sampleDone < extractableTotal) {
        // Everything extracted; sampling stalled. Re-run sampling with resume so
        // patterns that already have sampled URLs are skipped.
        await enqueueSamplePatternsJob({
          session_id: sessionId,
          resume: true
        });
        phase = "sample";
        requeuedCount = extractableTotal - sampleDone;
      } else {
        // All phases report done but the session was left non-complete — just
        // finalize it.
        await markSessionComplete(sessionId);
        phase = "complete";
      }

      request.log.info(
        {
          session_id: sessionId,
          resumed_from: session.status,
          phase,
          requeued_count: requeuedCount,
          unparsed_count: unparsedCount,
          extractable_total: extractableTotal,
          extract_done: extractDone,
          sample_done: sampleDone,
          pattern_count: patternCount
        },
        "session resume requested"
      );

      return reply.send({
        resumed: true,
        session_id: sessionId,
        phase,
        requeued_count: requeuedCount
      });
    }
  );

  app.get<{ Params: SessionParams; Querystring: ExportQuery }>(
    "/api/sessions/:id/export",
    async (request, reply) => {
      const format = request.query.format;

      if (format !== "csv" && format !== "xlsx" && format !== "pdf") {
        return reply
          .code(400)
          .send(badRequest("format must be csv, xlsx, or pdf"));
      }

      try {
        const exportFile = await generateSessionExport(
          request.params.id,
          format as ExportFormat
        );

        return reply
          .header(
            "content-disposition",
            `attachment; filename="${exportFile.fileName}"`
          )
          .type(exportFile.mimeType)
          .send(createReadStream(exportFile.filePath));
      } catch (error) {
        if (error instanceof SessionExportNotFoundError) {
          return reply.code(404).send({
            error: "Not Found",
            message: "session not found"
          });
        }

        // The export is built on disk under EXPORT_DIR; a full disk (ENOSPC) or
        // a missing source file (ENOENT) maps to a clear, actionable response.
        const fsError = fsErrorResponse(error);

        if (fsError) {
          return reply.code(fsError.status).send(fsError.body);
        }

        return reply.code(500).send({
          error: "Export Failed",
          message:
            error instanceof Error
              ? `Unable to generate export: ${error.message}`
              : "Unable to generate export."
        });
      }
    }
  );

  app.get<{ Params: SessionParams }>(
    "/api/sessions/:id/patterns",
    async (request, reply) => {
      const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
        request.params.id
      ]);

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const patternsResult = await pool.query(
        `
          SELECT
            id,
            session_id,
            source_role,
            template,
            total_urls,
            coverage_pct,
            confidence_pct,
            status,
            has_suspicious_segment,
            suspicious_segment_value,
            redirect_pct,
            missing_in_current,
            source_file,
            (
              SELECT old_template
              FROM pattern_renames
              WHERE pattern_renames.pattern_id = patterns.id
              ORDER BY renamed_at DESC
              LIMIT 1
            ) AS original_template,
            (
              SELECT old_template
              FROM pattern_transforms
              WHERE pattern_transforms.pattern_id = patterns.id
              ORDER BY transformed_at DESC
              LIMIT 1
            ) AS transform_original_template
          FROM patterns
          WHERE session_id = $1::uuid
          ORDER BY
            CASE source_role WHEN 'current' THEN 0 ELSE 1 END,
            missing_in_current DESC,
            total_urls DESC,
            template ASC
        `,
        [request.params.id]
      );

      return {
        patterns: patternsResult.rows
      };
    }
  );

  app.get<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/samples",
    async (request, reply) => {
      const patternResult = await pool.query(
        `
          SELECT 1
          FROM patterns
          WHERE session_id = $1 AND id = $2
        `,
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "pattern not found"
        });
      }

      const samplesResult = await pool.query(
        `
          SELECT
            id,
            pattern_id,
            url,
            original_url,
            http_status,
            response_ms,
            is_hit,
            is_soft_404,
            checked_at,
            final_url,
            redirect_count,
            http_status_category,
            source_file,
            error_reason,
            is_deleted_from_sitemap,
            deleted_from_files
          FROM sampled_urls
          WHERE pattern_id = $1
          ORDER BY checked_at ASC, id ASC
        `,
        [request.params.patternId]
      );

      return {
        sampled_urls: samplesResult.rows
      };
    }
  );

  app.get<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/source-files",
    async (request, reply) => {
      const patternResult = await pool.query<{
        total_urls: string;
        source_file: string | null;
      }>(
        "SELECT total_urls, source_file FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "pattern not found"
        });
      }

      const sourceFiles = await patternSourceFileBreakdown(
        request.params.patternId,
        Number(patternResult.rows[0].total_urls),
        patternResult.rows[0].source_file
      );

      return { source_files: sourceFiles };
    }
  );

  app.patch<{ Params: PatternParams; Body: RenameBody }>(
    "/api/sessions/:id/patterns/:patternId/rename",
    async (request, reply) => {
      const newTemplate = request.body?.new_template;
      const sourceFiles = Array.isArray(request.body?.source_files)
        ? request.body!.source_files.filter(
            (file): file is string => typeof file === "string"
          )
        : [];

      if (typeof newTemplate !== "string" || newTemplate.trim().length === 0) {
        return reply.code(400).send(badRequest("new_template is required"));
      }

      if (newTemplate.length > 500) {
        return reply
          .code(400)
          .send(badRequest("new_template must be 500 characters or fewer"));
      }

      const patternResult = await pool.query<{
        template: string;
        total_urls: string;
        source_file: string | null;
        source_role: string;
      }>(
        "SELECT template, total_urls, source_file, source_role FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "pattern not found"
        });
      }

      const currentTemplate = patternResult.rows[0].template;
      const sourceRole = patternResult.rows[0].source_role;

      if (newTemplate === currentTemplate) {
        return reply
          .code(400)
          .send(badRequest("new_template must differ from the current template"));
      }

      // Reverting to the most recent rename's old_template is an undo: pop that
      // history row instead of recording a new rename (one level of undo).
      const lastRename = await pool.query<{
        id: string;
        old_template: string;
        source_files: string[] | null;
      }>(
        "SELECT id, old_template, source_files FROM pattern_renames WHERE pattern_id = $1 ORDER BY renamed_at DESC LIMIT 1",
        [request.params.patternId]
      );
      const isUndo =
        (lastRename.rowCount ?? 0) > 0 &&
        lastRename.rows[0].old_template === newTemplate;

      const client = await pool.connect();
      // Old files are removed only after COMMIT; new files are removed on
      // failure — so a file-write error never destroys the original sitemap.
      let filesToDeleteAfterCommit: string[] = [];
      let filesToDeleteOnError: string[] = [];
      let committed = false;

      try {
        await client.query("BEGIN");
        await client.query("UPDATE patterns SET template = $1 WHERE id = $2", [
          newTemplate,
          request.params.patternId
        ]);

        if (isUndo) {
          // Revert the on-disk URLs: rewrite the current (renamed) files from
          // the current template back to the template we are restoring.
          const rewrite = await rewritePatternSourceFilesOnDisk(client, {
            sessionId: request.params.id,
            sourceRole,
            oldTemplate: currentTemplate,
            newTemplate,
            selectedDisplayFiles: lastRename.rows[0].source_files ?? []
          });

          filesToDeleteOnError = rewrite.newFilePaths;
          filesToDeleteAfterCommit = rewrite.oldFilePaths;

          await client.query("DELETE FROM pattern_renames WHERE id = $1", [
            lastRename.rows[0].id
          ]);
          await client.query("COMMIT");
          committed = true;
          await unlinkQuietly(filesToDeleteAfterCommit, request.log);

          return reply.send({
            old_template: currentTemplate,
            new_template: newTemplate,
            occurrence_count: 0,
            source_files_count: 0,
            files_rewritten: rewrite.renamedStoredFilenames.length,
            undo: true
          });
        }

        const breakdown = await patternSourceFileBreakdown(
          request.params.patternId,
          Number(patternResult.rows[0].total_urls),
          patternResult.rows[0].source_file
        );
        const selectedFiles =
          sourceFiles.length > 0
            ? sourceFiles
            : breakdown.map((entry) => entry.source_file);
        const selectedSet = new Set(selectedFiles);
        const occurrenceCount =
          breakdown
            .filter((entry) => selectedSet.has(entry.source_file))
            .reduce((sum, entry) => sum + entry.occurrences, 0) ||
          Number(patternResult.rows[0].total_urls);

        // Rewrite the matching source files on disk so their <loc> URLs carry
        // the new path segments. Failures bubble to the catch and roll back.
        const rewrite = await rewritePatternSourceFilesOnDisk(client, {
          sessionId: request.params.id,
          sourceRole,
          oldTemplate: currentTemplate,
          newTemplate,
          selectedDisplayFiles: selectedFiles
        });

        filesToDeleteOnError = rewrite.newFilePaths;
        filesToDeleteAfterCommit = rewrite.oldFilePaths;

        await client.query(
          `
            INSERT INTO pattern_renames (
              pattern_id,
              old_template,
              new_template,
              source_files,
              occurrence_count,
              renamed_file_path
            )
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            request.params.patternId,
            currentTemplate,
            newTemplate,
            selectedFiles,
            occurrenceCount,
            rewrite.renamedStoredFilenames.length > 0
              ? rewrite.renamedStoredFilenames.join(",")
              : null
          ]
        );
        await client.query("COMMIT");
        committed = true;
        await unlinkQuietly(filesToDeleteAfterCommit, request.log);
        await invalidateSessionZipCache(request.params.id);

        return reply.send({
          old_template: currentTemplate,
          new_template: newTemplate,
          occurrence_count: occurrenceCount,
          source_files_count: selectedFiles.length,
          files_rewritten: rewrite.renamedStoredFilenames.length
        });
      } catch (error) {
        await client.query("ROLLBACK");

        if (!committed) {
          await unlinkQuietly(filesToDeleteOnError, request.log);
        }

        throw error;
      } finally {
        client.release();
      }
    }
  );

  // Pattern-scoped URL structure transformation: rewrites each matching <loc>
  // URL's PATH per the current/new structure rules (can modify param values,
  // e.g. strip "-parts-catalog" and add a trailing slash) plus, optionally, the
  // pattern's display template. Synchronous like rename — the DB samples are
  // bounded and the file rewrite streams — with pre-transform snapshots kept so
  // the (possibly lossy) change can be undone per-pattern.
  app.post<{ Params: PatternParams; Body: TransformBody }>(
    "/api/sessions/:id/patterns/:patternId/transform",
    async (request, reply) => {
      const currentStructureRaw = request.body?.current_structure;
      const newStructureRaw = request.body?.new_structure;

      if (
        typeof currentStructureRaw !== "string" ||
        currentStructureRaw.trim().length === 0
      ) {
        return reply
          .code(400)
          .send(badRequest("current_structure is required"));
      }

      if (
        typeof newStructureRaw !== "string" ||
        newStructureRaw.trim().length === 0
      ) {
        return reply.code(400).send(badRequest("new_structure is required"));
      }

      const sourceFiles = Array.isArray(request.body?.source_files)
        ? request.body!.source_files.filter(
            (file): file is string => typeof file === "string"
          )
        : [];

      // Parse both structures up front — syntax errors become 400s the modal
      // shows inline before a preview/apply is allowed.
      let current: ParsedStructure;
      let next: ParsedStructure;

      try {
        current = parseStructure(currentStructureRaw);
        next = parseStructure(newStructureRaw);
      } catch (error) {
        if (error instanceof StructureSyntaxError) {
          return reply.code(400).send(badRequest(error.message));
        }

        throw error;
      }

      const patternResult = await pool.query<{
        template: string;
        total_urls: string;
        source_file: string | null;
        source_role: string;
      }>(
        "SELECT template, total_urls, source_file, source_role FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "pattern not found" });
      }

      const currentTemplate = patternResult.rows[0].template;
      const sourceRole = patternResult.rows[0].source_role;

      const validationError = validateStructures(
        current,
        next,
        countTemplateParams(currentTemplate)
      );

      if (validationError) {
        return reply.code(400).send(badRequest(validationError));
      }

      // The label rename is optional; default to the existing template so a
      // structure-only transform leaves the pattern name untouched.
      const newTemplateRaw = request.body?.new_template;
      const newTemplate =
        typeof newTemplateRaw === "string" && newTemplateRaw.trim().length > 0
          ? newTemplateRaw
          : currentTemplate;

      if (newTemplate.length > 500) {
        return reply
          .code(400)
          .send(badRequest("new_template must be 500 characters or fewer"));
      }

      const rewriteUrl: LocUrlRewriter = (url) =>
        transformUrl(url, current, next);

      const breakdown = await patternSourceFileBreakdown(
        request.params.patternId,
        Number(patternResult.rows[0].total_urls),
        patternResult.rows[0].source_file
      );
      const selectedFiles =
        sourceFiles.length > 0
          ? sourceFiles
          : breakdown.map((entry) => entry.source_file);

      const client = await pool.connect();
      // New files are removed on ROLLBACK; pre-transform originals are KEPT (undo
      // restores them), so there is nothing to delete after COMMIT.
      let filesToDeleteOnError: string[] = [];
      let committed = false;
      const sampleBeforeAfter: Array<{ before: string; after: string }> = [];

      try {
        await client.query("BEGIN");

        // 1. Rewrite the matching source files on disk.
        const rewrite = await transformPatternSourceFilesOnDisk(client, {
          sessionId: request.params.id,
          sourceRole,
          selectedDisplayFiles: selectedFiles,
          rewriteUrl
        });
        filesToDeleteOnError = rewrite.newFilePaths;

        // 2. Transform the bounded sampled URLs, snapshotting the originals.
        const sampled = await client.query<{ id: string; url: string }>(
          "SELECT id, url FROM sampled_urls WHERE pattern_id = $1",
          [request.params.patternId]
        );
        const sampledUpdates = sampled.rows
          .map((row) => ({
            id: row.id,
            oldUrl: row.url,
            newUrl: transformUrl(row.url, current, next)
          }))
          .filter(
            (
              update
            ): update is { id: string; oldUrl: string; newUrl: string } =>
              update.newUrl !== null
          );

        if (sampledUpdates.length > 0) {
          await client.query(
            `
              UPDATE sampled_urls AS s
              SET url = u.new_url, pre_transform_url = u.old_url
              FROM UNNEST($1::uuid[], $2::text[], $3::text[])
                AS u(id, new_url, old_url)
              WHERE s.id = u.id
            `,
            [
              sampledUpdates.map((u) => u.id),
              sampledUpdates.map((u) => u.newUrl),
              sampledUpdates.map((u) => u.oldUrl)
            ]
          );

          for (const update of sampledUpdates.slice(0, 3)) {
            sampleBeforeAfter.push({
              before: update.oldUrl,
              after: update.newUrl
            });
          }
        }

        // 3. Transform the bounded pattern_urls sample (drives re-sampling),
        //    snapshotting the original path. source_url is kept in sync by
        //    swapping its pathname so undo can rebuild it from original_path.
        const patternUrls = await client.query<{
          id: string;
          source_url: string;
          path: string;
        }>(
          "SELECT id, source_url, path FROM pattern_urls WHERE pattern_id = $1",
          [request.params.patternId]
        );
        const patternUrlUpdates = patternUrls.rows
          .map((row) => {
            const newSourceUrl = transformUrl(row.source_url, current, next);

            if (newSourceUrl === null) {
              return null;
            }

            let newPath = row.path;

            try {
              newPath = new URL(newSourceUrl).pathname;
            } catch {
              // Keep the prior path if the rebuilt URL is somehow unparsable.
            }

            return { id: row.id, newSourceUrl, newPath };
          })
          .filter(
            (
              update
            ): update is { id: string; newSourceUrl: string; newPath: string } =>
              update !== null
          );

        if (patternUrlUpdates.length > 0) {
          await client.query(
            `
              UPDATE pattern_urls AS p
              SET source_url = u.new_source_url,
                  path = u.new_path,
                  original_path = p.path
              FROM UNNEST($1::uuid[], $2::text[], $3::text[])
                AS u(id, new_source_url, new_path)
              WHERE p.id = u.id
            `,
            [
              patternUrlUpdates.map((u) => u.id),
              patternUrlUpdates.map((u) => u.newSourceUrl),
              patternUrlUpdates.map((u) => u.newPath)
            ]
          );
        }

        // 4. Apply the (optional) label rename.
        await client.query("UPDATE patterns SET template = $1 WHERE id = $2", [
          newTemplate,
          request.params.patternId
        ]);

        // 5. Record the operation for undo — only when something actually
        //    changed, so a no-op transform doesn't leave a phantom undo entry.
        const changedAnything =
          rewrite.newStoredFilenames.length > 0 ||
          sampledUpdates.length > 0 ||
          patternUrlUpdates.length > 0 ||
          newTemplate !== currentTemplate;

        if (changedAnything) {
          await client.query(
            `
              INSERT INTO pattern_transforms (
                pattern_id,
                old_template,
                new_template,
                current_structure,
                new_structure,
                source_files,
                urls_transformed,
                files_rewritten,
                original_file_paths,
                new_file_paths
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `,
            [
              request.params.patternId,
              currentTemplate,
              newTemplate,
              currentStructureRaw,
              newStructureRaw,
              selectedFiles,
              rewrite.rewrittenLocCount,
              rewrite.newStoredFilenames.length,
              rewrite.oldStoredFilenames,
              rewrite.newStoredFilenames
            ]
          );
        }

        await client.query("COMMIT");
        committed = true;
        await invalidateSessionZipCache(request.params.id);

        return reply.send({
          urls_transformed: rewrite.rewrittenLocCount,
          files_rewritten: rewrite.newStoredFilenames.length,
          old_template: currentTemplate,
          new_template: newTemplate,
          sample_before_after: sampleBeforeAfter
        });
      } catch (error) {
        await client.query("ROLLBACK");

        if (!committed) {
          await unlinkQuietly(filesToDeleteOnError, request.log);
        }

        throw error;
      } finally {
        client.release();
      }
    }
  );

  // Undo the most recent structure transform for a pattern: repoint each file to
  // its kept pre-transform copy, restore the template and the snapshotted DB
  // samples, and drop the log row. (Restores from stored originals rather than
  // reverse-transforming, since transforms may be lossy.)
  app.post<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/transform-undo",
    async (request, reply) => {
      const last = await pool.query<{
        id: string;
        old_template: string;
        original_file_paths: string[] | null;
        new_file_paths: string[] | null;
      }>(
        `
          SELECT id, old_template, original_file_paths, new_file_paths
          FROM pattern_transforms
          WHERE pattern_id = $1
          ORDER BY transformed_at DESC
          LIMIT 1
        `,
        [request.params.patternId]
      );

      if (last.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "no transform to undo for this pattern"
        });
      }

      const oldFiles = last.rows[0].original_file_paths ?? [];
      const newFiles = last.rows[0].new_file_paths ?? [];
      const client = await pool.connect();
      let filesToDeleteAfterCommit: string[] = [];
      let committed = false;

      try {
        await client.query("BEGIN");

        // Repoint each transformed file back to its pre-transform copy.
        for (let index = 0; index < newFiles.length; index += 1) {
          await client.query(
            "UPDATE sitemap_files SET filename = $1 WHERE session_id = $2 AND filename = $3",
            [oldFiles[index], request.params.id, newFiles[index]]
          );
        }
        filesToDeleteAfterCommit = newFiles.filter(
          (file, index) => file !== oldFiles[index]
        );

        await client.query("UPDATE patterns SET template = $1 WHERE id = $2", [
          last.rows[0].old_template,
          request.params.patternId
        ]);

        await client.query(
          `
            UPDATE sampled_urls
            SET url = pre_transform_url, pre_transform_url = NULL
            WHERE pattern_id = $1 AND pre_transform_url IS NOT NULL
          `,
          [request.params.patternId]
        );

        const restore = await client.query<{
          id: string;
          source_url: string;
          original_path: string;
        }>(
          `
            SELECT id, source_url, original_path
            FROM pattern_urls
            WHERE pattern_id = $1 AND original_path IS NOT NULL
          `,
          [request.params.patternId]
        );
        const restoreUpdates = restore.rows.map((row) => {
          let source = row.source_url;

          try {
            const url = new URL(row.source_url);
            url.pathname = row.original_path;
            source = url.toString();
          } catch {
            // Keep the stored source_url if it can't be reparsed.
          }

          return { id: row.id, source, path: row.original_path };
        });

        if (restoreUpdates.length > 0) {
          await client.query(
            `
              UPDATE pattern_urls AS p
              SET source_url = u.source, path = u.path, original_path = NULL
              FROM UNNEST($1::uuid[], $2::text[], $3::text[])
                AS u(id, source, path)
              WHERE p.id = u.id
            `,
            [
              restoreUpdates.map((u) => u.id),
              restoreUpdates.map((u) => u.source),
              restoreUpdates.map((u) => u.path)
            ]
          );
        }

        await client.query("DELETE FROM pattern_transforms WHERE id = $1", [
          last.rows[0].id
        ]);
        await client.query("COMMIT");
        committed = true;
        await unlinkQuietly(filesToDeleteAfterCommit, request.log);
        await invalidateSessionZipCache(request.params.id);

        return reply.send({
          undo: true,
          files_restored: newFiles.length,
          template: last.rows[0].old_template
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  );

  app.get<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/download-sitemap",
    async (request, reply) => {
      const patternResult = await pool.query<{ source_role: string }>(
        "SELECT source_role FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "pattern not found"
        });
      }

      const sourceRole = patternResult.rows[0].source_role;

      // Resolve the CURRENT stored filename(s) this pattern's URLs live in
      // straight from sitemap_files — the single source of truth every
      // mutation (plain rename, structure transform, redirect "Fix", bulk
      // replace, trailing-slash fix) swaps in place. This used to read only
      // the latest pattern_renames row, which went stale (or 404'd outright)
      // the instant a pattern was corrected via the "Fix" button or the
      // pencil-icon structure-transform modal instead of a plain rename —
      // those write to pattern_transforms / sitemap_files directly and never
      // touch pattern_renames, so the old lookup kept serving a pre-fix (or
      // no) file. Going straight to sitemap_files fixes all edit paths at once.
      const occurrenceResult = await pool.query<{ source_file: string }>(
        "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
        [request.params.patternId]
      );
      const targetDisplays = new Set(
        occurrenceResult.rows.map((row) => row.source_file)
      );

      const filesResult = await pool.query<{ filename: string }>(
        `
          SELECT filename
          FROM sitemap_files
          WHERE session_id = $1 AND source_role = $2 AND is_deleted = false
          ORDER BY filename ASC
        `,
        [request.params.id, sourceRole]
      );

      // Only ever surface an actually-edited copy — this endpoint means
      // "download the CORRECTED sitemap," so an untouched pattern must still
      // 404 with "apply a fix first" exactly as before, not silently serve
      // the unedited original relabelled as corrected-*.xml.
      const candidates = filesResult.rows
        .map((row) => row.filename)
        .filter((filename) => !isHttpUrl(filename))
        .filter((filename) => isEditedStoredFilename(request.params.id, filename))
        .filter(
          (filename) =>
            targetDisplays.size === 0 ||
            targetDisplays.has(
              displaySourceFilename(request.params.id, filename)
            )
        );

      let downloadName: string | null = null;

      for (const candidate of candidates) {
        const candidatePath = path.join(config.uploadDir, candidate);

        try {
          await access(candidatePath);
          downloadName = candidate;
          break;
        } catch {
          // Try the next candidate file.
        }
      }

      if (!downloadName) {
        return reply.code(404).send({
          error: "Not Found",
          message:
            "no corrected sitemap is available for this pattern — apply a fix first"
        });
      }

      const displayName = displaySourceFilename(request.params.id, downloadName);
      const isGzip = downloadName.toLowerCase().endsWith(".gz");

      reply.header(
        "content-type",
        isGzip ? "application/gzip" : "application/xml; charset=utf-8"
      );
      reply.header(
        "content-disposition",
        `attachment; filename="corrected-${displayName}"`
      );

      return reply.send(createReadStream(path.join(config.uploadDir, downloadName)));
    }
  );

  // Stream a ZIP of the session's sitemap files. type=edited → only files that
  // were rewritten (fixed / renamed / bulk-replaced); type=all → every current
  // file (edited ones use their corrected version). A regenerated
  // sitemap-index.xml listing the included files is always added at the root.
  app.get<{
    Params: SessionParams;
    Querystring: { type?: string; filter?: string; exclude?: string };
  }>(
    "/api/sessions/:id/download-sitemaps",
    async (request, reply) => {
      const downloadType = request.query.type === "all" ? "all" : "edited";
      // filter=false → raw originals, no foreign-<loc> stripping. Default true.
      const filtered = request.query.filter !== "false";
      // exclude=<id>,<id>,… → sitemap_files to drop entirely (v1.31 Fix 5). These
      // downloads are always built on demand: the cache never accounts for a
      // per-download exclusion set.
      const excludeFileIds = (request.query.exclude ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

      // Fast path (filtered, non-excluded downloads only): serve a pre-generated
      // ZIP if one exists on disk. Unfiltered / excluded downloads are always
      // built on demand — the cache holds the filtered/corrected full set.
      const cacheResult = await pool.query<{
        name: string;
        zip_all_path: string | null;
        zip_edited_path: string | null;
        zip_generated_at: string | null;
        files_mutated_at: string | null;
      }>(
        "SELECT name, zip_all_path, zip_edited_path, zip_generated_at, files_mutated_at FROM sessions WHERE id = $1",
        [request.params.id]
      );

      if (cacheResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const cachedPath =
        downloadType === "all"
          ? cacheResult.rows[0].zip_all_path
          : cacheResult.rows[0].zip_edited_path;

      // Freshness gate (v1.42): never serve a cached ZIP that predates the last
      // file mutation. Guards against a pre-gen build that recorded a path while
      // racing an edit (the download used to serve the cache unconditionally).
      const cacheIsFresh = isZipCacheFresh(
        cacheResult.rows[0].zip_generated_at,
        cacheResult.rows[0].files_mutated_at
      );

      if (
        filtered &&
        excludeFileIds.length === 0 &&
        cachedPath &&
        cacheIsFresh &&
        existsSync(cachedPath)
      ) {
        const dateMatch = cachedPath.match(/(\d{4}-\d{2}-\d{2})\.zip$/);
        const zipName = `${sessionSlug(cacheResult.rows[0].name)}-${downloadType}-sitemaps-${
          dateMatch?.[1] ?? new Date().toISOString().slice(0, 10)
        }.zip`;

        reply.header("content-type", "application/zip");
        reply.header(
          "content-disposition",
          `attachment; filename="${zipName}"`
        );
        // Set Content-Length from the cached file so the browser shows a real
        // progress bar and doesn't fall back to slow chunked transfer (v1.33
        // Fix 3). Best-effort — if the stat fails, stream without it.
        try {
          reply.header("content-length", statSync(cachedPath).size);
        } catch {
          // ignore — stream without an explicit length
        }

        return reply.send(createReadStream(cachedPath));
      }

      // Fallback: generate on demand (unfiltered downloads always land here; also
      // sessions that completed before caching, or whose cache is regenerating).
      const built = await buildSessionZipArchive(
        request.params.id,
        downloadType,
        { filtered, excludeFileIds, trackProgress: true }
      );

      if (!built) {
        return reply.code(404).send(
          badRequest(
            downloadType === "edited"
              ? "no edited sitemap files to download"
              : "no sitemap files to download"
          )
        );
      }

      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename="${built.zipName}"`
      );

      built.archive.on("error", (error) => {
        request.log.error({ error }, "download-sitemaps archive error");
        reply.raw.destroy(error);
      });

      void built.archive.finalize();

      return reply.send(built.archive);
    }
  );

  // Pre-download check: which files in this session contain foreign-domain
  // <loc>s that the (filtered) download will strip? Fast — reads the per-file
  // mismatched_url_count recorded at extraction, no re-scan. NOTE: that count is
  // a capped SAMPLE (up to ~500 example URLs), so it is a reliable "this file
  // has foreign URLs" signal and a LOWER BOUND on how many will be removed — the
  // true count can be anywhere up to total_urls. `foreign_url_count_is_minimum`
  // flags that; `will_be_empty` is only asserted when provably all-foreign.
  app.get<{ Params: SessionParams; Querystring: { type?: string } }>(
    "/api/sessions/:id/download-sitemaps/preview",
    async (request, reply) => {
      const downloadType = request.query.type === "all" ? "all" : "edited";

      const sessionResult = await pool.query<{ base_url: string }>(
        "SELECT base_url FROM sessions WHERE id = $1",
        [request.params.id]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const filesResult = await pool.query<{
        id: string;
        filename: string;
        is_index: boolean;
        total_urls: string | number | null;
        mismatched_url_count: string | number | null;
      }>(
        `
          SELECT id, filename, is_index, total_urls, mismatched_url_count
          FROM sitemap_files
          WHERE session_id = $1
            AND source_role = 'current'
            AND is_deleted = false
          ORDER BY filename ASC
        `,
        [request.params.id]
      );

      const affected: Array<{
        file_id: string;
        filename: string;
        total_urls: number;
        foreign_url_count: number;
        foreign_url_count_is_minimum: boolean;
        will_be_empty: boolean;
      }> = [];

      for (const row of filesResult.rows) {
        if (row.is_index || isHttpUrl(row.filename)) {
          continue;
        }

        if (
          downloadType === "edited" &&
          !isEditedStoredFilename(request.params.id, row.filename)
        ) {
          continue;
        }

        const foreign = Number(row.mismatched_url_count ?? 0);

        if (foreign <= 0) {
          continue;
        }

        const total = Number(row.total_urls ?? 0);

        affected.push({
          file_id: row.id,
          filename: downloadDisplayName(request.params.id, row.filename),
          total_urls: total,
          foreign_url_count: foreign,
          // Sampled counts cap out below the file total; the real number can be
          // higher (often the whole file).
          foreign_url_count_is_minimum: total > foreign,
          // Only assert emptiness when the (exact, unsampled) count covers every
          // URL — for large sampled files we cannot prove it here.
          will_be_empty: total > 0 && foreign >= total
        });
      }

      // Largest impact first.
      affected.sort((a, b) => b.foreign_url_count - a.foreign_url_count);

      return {
        has_foreign_urls: affected.length > 0,
        session_base_url: sessionResult.rows[0].base_url,
        total_affected_files: affected.length,
        total_foreign_urls_min: affected.reduce(
          (sum, f) => sum + f.foreign_url_count,
          0
        ),
        counts_are_sampled: affected.some((f) => f.foreign_url_count_is_minimum),
        affected_files: affected
      };
    }
  );

  // List EVERY URL in a pattern as a redirect-fix candidate (v1.42): the
  // HTTP-verified sampled redirects (confirmed source→destination) plus every
  // other URL in the pattern with an inferred destination, computed by applying
  // the single rewrite rule distilled from the confirmed samples. The modal
  // shows both, distinguishing verified from inferred; apply-redirects then
  // rewrites the whole selected set.
  app.get<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/redirect-candidates",
    async (request, reply) => {
      const patternResult = await pool.query<{ id: string }>(
        "SELECT id FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "pattern not found"
        });
      }

      // Confirmed redirect samples — the evidence for the rule and the set of
      // HTTP-verified rows.
      const sampledResult = await pool.query<{
        id: string;
        url: string;
        final_url: string;
        http_status: number | null;
      }>(
        `
          SELECT id, url, final_url, http_status
          FROM sampled_urls
          WHERE pattern_id = $1
            AND http_status_category = 'redirect'
            AND final_url IS NOT NULL
            AND final_url <> url
        `,
        [request.params.patternId]
      );

      const rule = deriveRedirectRule(
        sampledResult.rows.map((row) => ({
          source: row.url,
          dest: row.final_url
        }))
      );

      const sampledByPath = new Map<
        string,
        { id: string; final_url: string; http_status: number | null }
      >();

      for (const row of sampledResult.rows) {
        const key = pathKey(row.url);

        if (!sampledByPath.has(key)) {
          sampledByPath.set(key, {
            id: row.id,
            final_url: row.final_url,
            http_status: row.http_status
          });
        }
      }

      const urlsResult = await pool.query<{ source_url: string; path: string }>(
        "SELECT source_url, path FROM pattern_urls WHERE pattern_id = $1 ORDER BY source_url ASC",
        [request.params.patternId]
      );

      const candidates: Array<{
        key: string;
        url: string;
        final_url: string;
        is_sampled: boolean;
        sampled_url_id: string | null;
        http_status: number | null;
        // The destination itself looks like a not-found / soft-404 landing page
        // — redirecting to it is useless, so the source URL is a delete
        // candidate rather than a rewrite one. (v1.42.1)
        destination_not_found: boolean;
      }> = [];
      const seen = new Set<string>();

      for (const row of urlsResult.rows) {
        if (seen.has(row.source_url)) {
          continue;
        }

        seen.add(row.source_url);
        const sampled = sampledByPath.get(pathKey(row.path));

        if (sampled) {
          candidates.push({
            key: sampled.id,
            url: row.source_url,
            final_url: sampled.final_url,
            is_sampled: true,
            sampled_url_id: sampled.id,
            http_status: sampled.http_status,
            destination_not_found: looksLikeNotFoundUrl(sampled.final_url)
          });
        } else if (rule) {
          const dest = applyRedirectRule(row.source_url, rule);

          if (dest) {
            candidates.push({
              key: `inferred:${row.source_url}`,
              url: row.source_url,
              final_url: dest,
              is_sampled: false,
              sampled_url_id: null,
              http_status: null,
              destination_not_found: looksLikeNotFoundUrl(dest)
            });
          }
        }
      }

      // Verified rows first, then inferred.
      candidates.sort((a, b) => Number(b.is_sampled) - Number(a.is_sampled));

      return {
        rule: rule ?? null,
        pattern_total_urls: urlsResult.rowCount ?? 0,
        sampled_redirect_count: sampledResult.rowCount ?? 0,
        inferred_count: candidates.filter((c) => !c.is_sampled).length,
        candidates
      };
    }
  );

  app.post<{
    Params: PatternParams;
    Body: { url_ids?: unknown[]; inferred_urls?: unknown[] };
  }>(
    "/api/sessions/:id/patterns/:patternId/apply-redirects",
    async (request, reply) => {
      const patternResult = await pool.query<{ source_role: string }>(
        "SELECT source_role FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "pattern not found"
        });
      }

      const sourceRole = patternResult.rows[0].source_role;

      // Optional: restrict to specific sampled_url rows. Omit → all redirects.
      const urlIds = Array.isArray(request.body?.url_ids)
        ? request.body!.url_ids.filter(
            (id): id is string => typeof id === "string"
          )
        : null;

      // Optional (v1.42): unsampled URLs to also rewrite by inference. The
      // client only sends WHICH urls; the server recomputes their destinations
      // from the rule distilled from the confirmed samples, so it stays
      // authoritative and a client can't inject arbitrary rewrites.
      const inferredUrls = Array.isArray(request.body?.inferred_urls)
        ? request.body!.inferred_urls.filter(
            (url): url is string => typeof url === "string"
          )
        : [];

      // Route a WIDENED apply that would rewrite more than the parallel
      // threshold's worth of files to a background job (v1.42). The sampled-only
      // path (no inferred URLs) only ever touches a handful of files, so it
      // always stays inline; only the whole-pattern inference can span hundreds
      // of files, and rewriting those synchronously here would block the API
      // event loop / trip the request timeout — the failure mode that hit the
      // ZIP path (v1.27) and Cleaner (v1.38). The job re-derives everything
      // server-side and rewrites via the piscina pool.
      if (inferredUrls.length > 0) {
        const fileSpanResult = await pool.query<{ n: string }>(
          "SELECT COUNT(DISTINCT source_file)::bigint AS n FROM pattern_file_occurrences WHERE pattern_id = $1",
          [request.params.patternId]
        );
        const patternFileSpan = Number(fileSpanResult.rows[0]?.n ?? 0);

        if (patternFileSpan > FILE_REWRITE_PARALLEL_THRESHOLD) {
          await enqueueApplyRedirectsJob({
            session_id: request.params.id,
            pattern_id: request.params.patternId,
            url_ids: urlIds,
            inferred_urls: inferredUrls
          });

          return reply.send({
            queued: true,
            files_total: patternFileSpan
          });
        }
      }

      // Derive the rule BEFORE the UPDATE below flips the selected redirect rows
      // to 'success' (which would erase the evidence).
      let inferredRule: RedirectRule | null = null;

      if (inferredUrls.length > 0) {
        const ruleSamples = await pool.query<{ url: string; final_url: string }>(
          `
            SELECT url, final_url
            FROM sampled_urls
            WHERE pattern_id = $1
              AND http_status_category = 'redirect'
              AND final_url IS NOT NULL
              AND final_url <> url
          `,
          [request.params.patternId]
        );

        inferredRule = deriveRedirectRule(
          ruleSamples.rows.map((row) => ({
            source: row.url,
            dest: row.final_url
          }))
        );
      }

      const client = await pool.connect();
      // Old files are removed only after COMMIT; new files are removed on
      // failure — so a file-write error never destroys the original sitemap.
      let filesToDeleteAfterCommit: string[] = [];
      let filesToDeleteOnError: string[] = [];
      let committed = false;

      try {
        await client.query("BEGIN");
        // Adopt each redirect's destination as the URL, snapshotting the original
        // url / category / is_hit so "Undo last replace" can fully restore them.
        // The destination is treated as a live hit (success). RETURNING gives us
        // the old→new URL pairs needed to rewrite the source XML on disk.
        const updateResult = await client.query<{
          original_url: string;
          url: string;
          source_file: string | null;
        }>(
          `
            UPDATE sampled_urls
            SET original_url = COALESCE(original_url, url),
                original_http_status_category =
                  COALESCE(original_http_status_category, http_status_category),
                original_is_hit = COALESCE(original_is_hit, is_hit),
                url = final_url,
                http_status_category = 'success',
                is_hit = TRUE
            WHERE pattern_id = $1
              AND http_status_category = 'redirect'
              AND final_url IS NOT NULL
              AND final_url <> url
              AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
            RETURNING original_url, url, source_file
          `,
          [request.params.patternId, urlIds]
        );
        // Recompute redirect / confidence from samples using the SAME formula
        // as the sampling job (scoreWeight per category), so this is an exact
        // inverse of undo: success=1, soft_404=0.25, redirect=0.5, failure=0.
        await client.query(recomputePatternStatsSql, [request.params.patternId]);

        // Rewrite the source XML on disk so each redirected <loc> carries its
        // final URL — original_url is the value still present in the file (a
        // find/replace never touches files), url is the redirect destination.
        const replacements = new Map<string, string>();
        // Narrow the disk scan to the files the affected URLs came from.
        // sampled_urls.source_file holds a comma-separated list of contributing
        // display filenames.
        const candidateFiles = new Set<string>();
        for (const row of updateResult.rows) {
          if (row.original_url && row.original_url !== row.url) {
            replacements.set(row.original_url, row.url);
          }

          for (const name of (row.source_file ?? "").split(",")) {
            const trimmed = name.trim();

            if (trimmed.length > 0) {
              candidateFiles.add(trimmed);
            }
          }
        }

        // Widen to the unsampled URLs (v1.42): apply the derived rule to each
        // requested URL and add the source→inferred-destination pair to the same
        // replacement map. These do not touch sampled_urls (there is no row for
        // them); they change only the XML on disk, which undo reverts wholesale
        // via fixed_file_path.
        let inferredApplied = 0;

        if (inferredUrls.length > 0 && inferredRule) {
          for (const url of inferredUrls) {
            const dest = applyRedirectRule(url, inferredRule);

            if (dest && dest !== url && !replacements.has(url)) {
              replacements.set(url, dest);
              inferredApplied += 1;
            }
          }
        }

        // Unsampled URLs carry no per-URL source_file, so narrowing the disk
        // scan to the sampled files could miss files. When inferring, add the
        // pattern's actual file list from pattern_file_occurrences (the precise
        // set of files this pattern's URLs live in — more accurate than the
        // comma-joined patterns.source_file). If that is somehow empty we scan
        // every file of the role below. rewriteSpecificLocs no-ops on files
        // that contain none of the URLs, so a wider scan is correct, only
        // slower — and this inline path only runs for patterns at or below
        // FILE_REWRITE_PARALLEL_THRESHOLD files (larger ones route to the job).
        if (inferredApplied > 0) {
          const occurrenceResult = await client.query<{ source_file: string }>(
            "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
            [request.params.patternId]
          );

          for (const row of occurrenceResult.rows) {
            candidateFiles.add(row.source_file);
          }
        }

        // When inferring but the pattern has no recorded file list, scan all
        // files of this source role (empty selectedDisplayFiles = no filter).
        const selectedDisplayFiles =
          inferredApplied > 0 && candidateFiles.size === 0
            ? []
            : Array.from(candidateFiles);

        let rewrittenLocCount = 0;

        if (replacements.size > 0) {
          const rewrite = await rewriteRedirectSourceFilesOnDisk(client, {
            sessionId: request.params.id,
            sourceRole,
            replacements,
            selectedDisplayFiles
          });

          filesToDeleteOnError = rewrite.newFilePaths;
          filesToDeleteAfterCommit = rewrite.oldFilePaths;
          rewrittenLocCount = rewrite.rewrittenLocCount;
        }

        await client.query("COMMIT");
        committed = true;
        await unlinkQuietly(filesToDeleteAfterCommit, request.log);
        await invalidateSessionZipCache(request.params.id);

        return reply.send({
          updated: updateResult.rowCount ?? 0,
          inferred_applied: inferredApplied,
          rewritten_loc_count: rewrittenLocCount
        });
      } catch (error) {
        await client.query("ROLLBACK");

        if (!committed) {
          await unlinkQuietly(filesToDeleteOnError, request.log);
        }

        throw error;
      } finally {
        client.release();
      }
    }
  );

  // Delete the SOURCE URLs of redirect rows whose destination is itself a
  // not-found page (v1.42.1). Reuses the Delete Problem URLs pipeline verbatim —
  // collectProblemFileGroups (now URL-driven) → mark sampled_urls deleted →
  // rebuildSessionDeletions — via the same maintenance job, so there is no
  // second deletion / file-mutation path and undo (Restore Deleted URLs) works
  // unchanged. Only sampled (verified) URLs are removable; the modal only offers
  // Delete on those, and any unsampled URL passed here is skipped by the pipeline.
  app.post<{ Params: PatternParams; Body: { urls?: unknown[] } }>(
    "/api/sessions/:id/patterns/:patternId/delete-redirect-urls",
    async (request, reply) => {
      const patternResult = await pool.query<{ id: string }>(
        "SELECT id FROM patterns WHERE session_id = $1 AND id = $2",
        [request.params.id, request.params.patternId]
      );

      if (patternResult.rowCount === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "pattern not found" });
      }

      const urls = Array.isArray(request.body?.urls)
        ? request.body!.urls.filter(
            (url): url is string => typeof url === "string"
          )
        : [];

      if (urls.length === 0) {
        return reply.code(400).send(badRequest("urls is required"));
      }

      // Scope the deletion to the files this pattern's URLs live in.
      const occurrenceResult = await pool.query<{ source_file: string }>(
        "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
        [request.params.patternId]
      );
      const fileDisplays = occurrenceResult.rows.map((row) => row.source_file);

      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'delete-problem-urls') RETURNING id",
        [request.params.id]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueDeleteProblemUrlsJob({
        session_id: request.params.id,
        job_row_id: jobRowId,
        file_displays: fileDisplays,
        statuses: [],
        urls
      });

      return { job_row_id: jobRowId, status: "PENDING" };
    }
  );

  app.get<{ Params: SessionParams }>(
    "/api/sessions/:id/mismatched-urls",
    async (request, reply) => {
      const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
        request.params.id
      ]);

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const mismatchesResult = await pool.query(
        `
          SELECT
            mismatched_urls.id,
            mismatched_urls.sitemap_file_id,
            sitemap_files.session_id,
            sitemap_files.filename,
            mismatched_urls.url,
            mismatched_urls.detected_host,
            mismatched_urls.expected_host,
            mismatched_urls.created_at
          FROM mismatched_urls
          INNER JOIN sitemap_files
            ON sitemap_files.id = mismatched_urls.sitemap_file_id
          WHERE sitemap_files.session_id = $1
          ORDER BY mismatched_urls.created_at ASC, mismatched_urls.id ASC
        `,
        [request.params.id]
      );

      return {
        mismatched_urls: mismatchesResult.rows
      };
    }
  );

  app.get<{
    Params: SessionParams;
    Querystring: {
      find?: string;
      replace?: string;
      matchCase?: string;
      match_case?: string;
    };
  }>("/api/sessions/:id/find-replace/preview", async (request, reply) => {
    const find = request.query.find ?? "";
    const replace = request.query.replace ?? "";
    const matchCase =
      request.query.matchCase === "true" || request.query.match_case === "true";

    const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
      request.params.id
    ]);

    if (sessionResult.rowCount === 0) {
      return reply.code(404).send({
        error: "Not Found",
        message: "session not found"
      });
    }

    if (find.length === 0) {
      return reply.send({ affected_count: 0, preview: [] });
    }

    // Read-only: never modifies data.
    const rowsResult = await pool.query<{ url: string }>(
      `
        SELECT sampled_urls.url
        FROM sampled_urls
        INNER JOIN patterns ON patterns.id = sampled_urls.pattern_id
        WHERE patterns.session_id = $1
        ORDER BY sampled_urls.url ASC
      `,
      [request.params.id]
    );

    const matched = rowsResult.rows.filter((row) =>
      urlContainsFind(row.url, find, matchCase)
    );

    return reply.send({
      affected_count: matched.length,
      preview: matched.slice(0, 5).map((row) => ({
        before: row.url,
        after: applyFindReplace(row.url, find, replace, matchCase)
      }))
    });
  });

  app.post<{ Params: SessionParams; Body: FindReplaceBody }>(
    "/api/sessions/:id/find-replace",
    async (request, reply) => {
      const find = request.body?.find;
      const replace = request.body?.replace ?? "";
      const matchCase =
        request.body?.matchCase === true || request.body?.match_case === true;

      if (typeof find !== "string" || find.length === 0) {
        return reply.code(400).send(badRequest("find is required"));
      }

      if (typeof replace !== "string") {
        return reply.code(400).send(badRequest("replace must be a string"));
      }

      const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
        request.params.id
      ]);

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const rowsResult = await pool.query<{
        id: string;
        url: string;
        original_url: string | null;
      }>(
        `
          SELECT sampled_urls.id, sampled_urls.url, sampled_urls.original_url
          FROM sampled_urls
          INNER JOIN patterns ON patterns.id = sampled_urls.pattern_id
          WHERE patterns.session_id = $1
        `,
        [request.params.id]
      );

      const updates = rowsResult.rows
        .map((row) => ({
          id: row.id,
          newUrl: applyFindReplace(row.url, find, replace, matchCase),
          // Preserve the first-ever original so undo restores fully.
          original: row.original_url ?? row.url
        }))
        .filter((update, index) => update.newUrl !== rowsResult.rows[index].url);

      if (updates.length > 0) {
        const client = await pool.connect();

        try {
          await client.query("BEGIN");
          await client.query(
            `
              UPDATE sampled_urls AS s
              SET url = u.new_url, original_url = u.original_url
              FROM UNNEST($1::uuid[], $2::text[], $3::text[])
                AS u(id, new_url, original_url)
              WHERE s.id = u.id
            `,
            [
              updates.map((update) => update.id),
              updates.map((update) => update.newUrl),
              updates.map((update) => update.original)
            ]
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }

      return reply.send({
        affected: updates.length,
        find,
        replace,
        match_case: matchCase
      });
    }
  );

  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/find-replace/undo",
    async (request, reply) => {
      const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
        request.params.id
      ]);

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      // Patterns whose category/is_hit were changed by apply-redirects — their
      // redirect/confidence figures must be recomputed after we restore rows.
      const affected = await pool.query<{ pattern_id: string }>(
        `
          SELECT DISTINCT s.pattern_id
          FROM sampled_urls s
          INNER JOIN patterns p ON p.id = s.pattern_id
          WHERE p.session_id = $1
            AND s.original_url IS NOT NULL
            AND s.original_http_status_category IS NOT NULL
        `,
        [request.params.id]
      );

      const client = await pool.connect();
      let restored = 0;
      // Orphaned fixed files are removed only after COMMIT so a failure never
      // destroys the corrected sitemaps mid-revert.
      let filesToDeleteAfterCommit: string[] = [];

      try {
        await client.query("BEGIN");
        const result = await client.query(
          `
            UPDATE sampled_urls AS s
            SET url = s.original_url,
                original_url = NULL,
                http_status_category =
                  COALESCE(s.original_http_status_category, s.http_status_category),
                is_hit = COALESCE(s.original_is_hit, s.is_hit),
                original_http_status_category = NULL,
                original_is_hit = NULL
            FROM patterns
            WHERE patterns.id = s.pattern_id
              AND patterns.session_id = $1
              AND s.original_url IS NOT NULL
          `,
          [request.params.id]
        );

        restored = result.rowCount ?? 0;

        // Reverse the apply-redirects stat changes for affected patterns using
        // the identical formula, so redirect_pct / confidence_pct round-trip
        // back to their pre-apply values.
        for (const row of affected.rows) {
          await client.query(recomputePatternStatsSql, [row.pattern_id]);
        }

        // Revert the on-disk XML rewrites from apply-redirects, restoring each
        // file to its preserved pre-fix original.
        const revert = await revertRedirectSourceFilesOnDisk(
          client,
          request.params.id
        );
        filesToDeleteAfterCommit = revert.oldFilePaths;

        await client.query("COMMIT");
        await unlinkQuietly(filesToDeleteAfterCommit, request.log);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await invalidateSessionZipCache(request.params.id);

      return reply.send({ restored });
    }
  );

  // Bulk pattern-aware find & replace — PREVIEW (read-only: no DB or file
  // writes). Resolves the existing 'current' pattern named by from_pattern and
  // reports how many files / URLs the rewrite touches (from the precomputed
  // pattern_file_occurrences table) plus real before/after sample URLs.
  app.post<{
    Params: SessionParams;
    Body: { from_pattern?: string; to_pattern?: string };
  }>("/api/sessions/:id/bulk-replace/preview", async (request, reply) => {
    const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
      request.params.id
    ]);

    if (sessionResult.rowCount === 0) {
      return reply.code(404).send({
        error: "Not Found",
        message: "session not found"
      });
    }

    const validation = validateBulkReplacePatterns(request.body ?? {});

    if (!validation.ok) {
      return reply.code(400).send(badRequest(validation.message));
    }

    const { fromPattern, toPattern } = validation;

    const patternResult = await pool.query<{
      id: string;
      total_urls: string;
      source_file: string | null;
    }>(
      `
        SELECT id, total_urls, source_file
        FROM patterns
        WHERE session_id = $1 AND source_role = 'current' AND template = $2
      `,
      [request.params.id, fromPattern]
    );

    if (patternResult.rowCount === 0) {
      return reply
        .code(404)
        .send(badRequest(`no current pattern matches "${fromPattern}"`));
    }

    const pattern = patternResult.rows[0];
    const patternId = pattern.id;

    // Per-file breakdown (display filename + URL count) drives both the totals
    // and the selectable file list — straight from the precomputed occurrence
    // counts, no disk scan needed.
    const breakdown = await patternSourceFileBreakdown(
      patternId,
      Number(pattern.total_urls),
      pattern.source_file
    );
    const files = breakdown.map((entry) => ({
      filename: entry.source_file,
      url_count: entry.occurrences
    }));
    const filesAffected = files.length;
    const urlsAffected = files.reduce((sum, entry) => sum + entry.url_count, 0);

    // Real before/after samples: transform up to 3 stored URLs for this pattern.
    const rewrite = buildPatternTemplateRewriter(fromPattern, toPattern);
    const sampleResult = await pool.query<{ source_url: string }>(
      `
        SELECT source_url
        FROM pattern_urls
        WHERE pattern_id = $1
        ORDER BY source_url ASC
        LIMIT 3
      `,
      [patternId]
    );
    const sampleUrls = sampleResult.rows.map((row) => ({
      before: row.source_url,
      after: rewrite(row.source_url) ?? row.source_url
    }));

    return reply.send({
      files_affected: filesAffected,
      urls_affected: urlsAffected,
      // ~0.3s per file, matching the streaming-throughput estimate in the spec.
      estimated_seconds: Math.round(filesAffected * 0.3),
      sample_urls: sampleUrls,
      files
    });
  });

  // Bulk pattern-aware find & replace — APPLY. Enqueues a background job on the
  // dedicated single-concurrency bulk-replace queue and returns immediately.
  app.post<{
    Params: SessionParams;
    Body: {
      from_pattern?: string;
      to_pattern?: string;
      selected_files?: unknown[];
    };
  }>("/api/sessions/:id/bulk-replace/apply", async (request, reply) => {
    const sessionResult = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
      request.params.id
    ]);

    if (sessionResult.rowCount === 0) {
      return reply.code(404).send({
        error: "Not Found",
        message: "session not found"
      });
    }

    const validation = validateBulkReplacePatterns(request.body ?? {});

    if (!validation.ok) {
      return reply.code(400).send(badRequest(validation.message));
    }

    const { fromPattern, toPattern } = validation;

    const patternResult = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM patterns
        WHERE session_id = $1 AND source_role = 'current' AND template = $2
      `,
      [request.params.id, fromPattern]
    );

    if (patternResult.rowCount === 0) {
      return reply
        .code(404)
        .send(badRequest(`no current pattern matches "${fromPattern}"`));
    }

    const patternId = patternResult.rows[0].id;

    // Renaming the pattern to an existing template would violate the
    // UNIQUE(session_id, source_role, template) constraint after the files are
    // already rewritten — reject up front so we never leave disk/DB inconsistent.
    const conflictResult = await pool.query(
      `
        SELECT 1
        FROM patterns
        WHERE session_id = $1 AND source_role = 'current' AND template = $2
      `,
      [request.params.id, toPattern]
    );

    if (conflictResult.rowCount && conflictResult.rowCount > 0) {
      return reply
        .code(409)
        .send(
          badRequest(
            `a current pattern "${toPattern}" already exists — choose a different target`
          )
        );
    }

    // One bulk operation per session at a time.
    const activeResult = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM bulk_replace_jobs
        WHERE session_id = $1 AND status IN ('PENDING', 'RUNNING')
        ORDER BY started_at DESC
        LIMIT 1
      `,
      [request.params.id]
    );

    if (activeResult.rowCount && activeResult.rowCount > 0) {
      return reply.code(409).send({
        error: "Conflict",
        message: "a bulk replace is already running for this session",
        job_id: activeResult.rows[0].id
      });
    }

    // The display filenames contributing to this pattern — the valid universe
    // for an optional per-file selection.
    const occurrenceFilesResult = await pool.query<{ source_file: string }>(
      "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
      [patternId]
    );
    const availableFiles = new Set(
      occurrenceFilesResult.rows.map((row) => row.source_file)
    );

    // Optional per-file selection (display filenames). Omitted → all files.
    const requestedFiles = Array.isArray(request.body?.selected_files)
      ? request.body!.selected_files.filter(
          (value): value is string => typeof value === "string"
        )
      : null;
    const selectedFiles =
      requestedFiles === null
        ? null
        : requestedFiles.filter((file) => availableFiles.has(file));

    if (requestedFiles !== null && selectedFiles!.length === 0) {
      return reply
        .code(400)
        .send(badRequest("select at least one file to rewrite"));
    }

    const filesTotal = selectedFiles ? selectedFiles.length : availableFiles.size;

    const jobRow = await pool.query<{ id: string }>(
      `
        INSERT INTO bulk_replace_jobs
          (session_id, from_pattern, to_pattern, files_total, status)
        VALUES ($1, $2, $3, $4, 'PENDING')
        RETURNING id
      `,
      [request.params.id, fromPattern, toPattern, filesTotal]
    );
    const jobRowId = jobRow.rows[0].id;

    await enqueueBulkReplaceJob({
      session_id: request.params.id,
      job_row_id: jobRowId,
      from_pattern: fromPattern,
      to_pattern: toPattern,
      selected_files: selectedFiles
    });

    return reply.code(202).send({ job_id: jobRowId });
  });

  // Progress of the most recent bulk-replace operation for a session.
  app.get<{ Params: SessionParams }>(
    "/api/sessions/:id/bulk-replace-status",
    async (request, reply) => {
      const sessionResult = await pool.query(
        "SELECT 1 FROM sessions WHERE id = $1",
        [request.params.id]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const jobResult = await pool.query<{
        id: string;
        status: string;
        files_total: number;
        files_done: number;
        urls_rewritten: string;
        from_pattern: string;
        to_pattern: string;
        error: string | null;
      }>(
        `
          SELECT id, status, files_total, files_done, urls_rewritten,
                 from_pattern, to_pattern, error
          FROM bulk_replace_jobs
          WHERE session_id = $1
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [request.params.id]
      );

      if (jobResult.rowCount === 0) {
        return reply.send({ status: "NONE" });
      }

      const job = jobResult.rows[0];

      return reply.send({
        job_id: job.id,
        status: job.status,
        files_total: job.files_total,
        files_done: job.files_done,
        urls_rewritten: Number(job.urls_rewritten),
        from_pattern: job.from_pattern,
        to_pattern: job.to_pattern,
        error: job.error
      });
    }
  );

  // Undo the most recent completed bulk replace: restore rewritten files from
  // their preserved originals and revert the DB pattern/URLs. Runs as a
  // background job on the same single-concurrency queue (progress via the same
  // status endpoint, status UNDOING → UNDONE).
  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/bulk-replace/undo",
    async (request, reply) => {
      const sessionResult = await pool.query(
        "SELECT 1 FROM sessions WHERE id = $1",
        [request.params.id]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      // Never undo while an apply/undo is in flight.
      const activeResult = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM bulk_replace_jobs
          WHERE session_id = $1 AND status IN ('PENDING', 'RUNNING', 'UNDOING')
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [request.params.id]
      );

      if (activeResult.rowCount && activeResult.rowCount > 0) {
        return reply.code(409).send({
          error: "Conflict",
          message: "a bulk replace operation is already running for this session",
          job_id: activeResult.rows[0].id
        });
      }

      // Undo targets the most recent completed bulk replace.
      const completedResult = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM bulk_replace_jobs
          WHERE session_id = $1 AND status = 'COMPLETE'
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [request.params.id]
      );

      if (completedResult.rowCount === 0) {
        return reply
          .code(400)
          .send(badRequest("no completed bulk replace to undo"));
      }

      const jobRowId = completedResult.rows[0].id;

      await enqueueBulkReplaceUndoJob({
        session_id: request.params.id,
        job_row_id: jobRowId
      });

      return reply.code(202).send({ job_id: jobRowId });
    }
  );

  // List every sitemap file for a session with deletion + GSC state, for the
  // Files management view. Filename is the clean display label. Optional
  // ?status=active|deleted|empty|invalid filter.
  app.get<{ Params: SessionParams; Querystring: FilesListQuery }>(
    "/api/sessions/:id/files",
    async (request, reply) => {
      const sessionResult = await pool.query<{
        name: string;
        base_url: string;
        gsc_property_url: string | null;
        gsc_credentials_encrypted: string | null;
      }>(
        `
          SELECT name, base_url, gsc_property_url, gsc_credentials_encrypted
          FROM sessions
          WHERE id = $1
        `,
        [request.params.id]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const session = sessionResult.rows[0];

      const filesResult = await pool.query<{
        id: string;
        filename: string;
        source_role: SitemapSourceRole;
        total_urls: string;
        is_valid: boolean;
        is_empty: boolean;
        is_index: boolean;
        is_deleted: boolean;
        deleted_at: string | null;
        gsc_deletion_status: string | null;
        gsc_deletion_error: string | null;
        mismatched_url_count: string;
        mismatched_hosts: string | null;
      }>(
        `
          SELECT
            id,
            filename,
            source_role,
            total_urls,
            is_valid,
            is_empty,
            is_index,
            is_deleted,
            deleted_at,
            gsc_deletion_status,
            gsc_deletion_error,
            mismatched_url_count,
            (
              SELECT string_agg(DISTINCT mu.detected_host, ', '
                ORDER BY mu.detected_host)
              FROM mismatched_urls mu
              WHERE mu.sitemap_file_id = sitemap_files.id
            ) AS mismatched_hosts
          FROM sitemap_files
          WHERE session_id = $1
          ORDER BY is_index DESC, filename ASC, id ASC
        `,
        [request.params.id]
      );

      const requestedStatus = request.query.status?.toLowerCase();
      const statusFilter =
        requestedStatus === "active" ||
        requestedStatus === "deleted" ||
        requestedStatus === "empty" ||
        requestedStatus === "invalid"
          ? requestedStatus
          : null;

      const files = filesResult.rows
        .map((row) => {
          const status = sitemapFileStatus(row);

          return {
            id: row.id,
            filename: downloadDisplayName(request.params.id, row.filename),
            source_role: row.source_role,
            total_urls: Number(row.total_urls),
            is_index: row.is_index,
            is_deleted: row.is_deleted,
            deleted_at: row.deleted_at,
            gsc_deletion_status: row.gsc_deletion_status,
            gsc_deletion_error: row.gsc_deletion_error,
            mismatched_url_count: Number(row.mismatched_url_count),
            mismatched_hosts: row.mismatched_hosts,
            status
          };
        })
        .filter((file) => (statusFilter ? file.status === statusFilter : true));

      return {
        session: {
          name: session.name,
          base_url: session.base_url,
          gsc_property_url: session.gsc_property_url,
          gsc_configured: Boolean(session.gsc_credentials_encrypted)
        },
        files
      };
    }
  );

  // Soft-delete one or more sitemap files: mark them deleted (row + on-disk file
  // are kept for audit / undo) and submit a deletion request to Google Search
  // Console when credentials are available. Local deletion is applied first so a
  // GSC failure never blocks the local state change.
  app.post<{ Params: SessionParams; Body: DeleteFilesBody }>(
    "/api/sessions/:id/files/delete",
    async (request, reply) => {
      const sessionResult = await pool.query<{
        base_url: string;
        gsc_property_url: string | null;
        gsc_credentials_encrypted: string | null;
      }>(
        `
          SELECT base_url, gsc_property_url, gsc_credentials_encrypted
          FROM sessions
          WHERE id = $1
        `,
        [request.params.id]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const session = sessionResult.rows[0];

      const fileIds = parseFileIds(request.body.file_ids);

      if ("error" in fileIds) {
        return reply.code(400).send(badRequest(fileIds.error));
      }

      // Only operate on files that actually belong to this session.
      const filesResult = await pool.query<{
        id: string;
        filename: string;
      }>(
        `
          SELECT id, filename
          FROM sitemap_files
          WHERE session_id = $1 AND id = ANY($2::uuid[])
        `,
        [request.params.id, fileIds]
      );

      if (filesResult.rowCount === 0) {
        return reply
          .code(400)
          .send(badRequest("none of the file_ids belong to this session"));
      }

      // Resolve GSC credentials + property. New credentials in the body are
      // stored (encrypted) for reuse; otherwise fall back to what's on the
      // session. Property URL defaults to the session base URL.
      const propertyInput =
        typeof request.body.gsc_property_url === "string"
          ? request.body.gsc_property_url.trim()
          : "";
      const credentialsInput =
        typeof request.body.gsc_credentials === "string"
          ? request.body.gsc_credentials.trim()
          : "";

      const propertyUrl =
        propertyInput || session.gsc_property_url || session.base_url;

      let credentials: ServiceAccountCredentials | null = null;
      let credentialsToPersist: string | null = null;
      let credentialsError: string | null = null;

      if (credentialsInput) {
        try {
          const rawJson = decodeGscCredentialsInput(credentialsInput);
          credentials = parseServiceAccount(rawJson);
          credentialsToPersist = encryptSecret(rawJson);
        } catch (error) {
          credentialsError =
            error instanceof Error ? error.message : "invalid credentials";
        }
      } else if (session.gsc_credentials_encrypted) {
        try {
          credentials = parseServiceAccount(
            decryptSecret(session.gsc_credentials_encrypted)
          );
        } catch (error) {
          credentialsError =
            error instanceof Error
              ? error.message
              : "stored credentials could not be read";
        }
      }

      if (credentialsError) {
        return reply.code(400).send(badRequest(credentialsError));
      }

      // Persist credentials / property for reuse before processing files.
      if (credentialsToPersist || propertyInput) {
        await pool.query(
          `
            UPDATE sessions
            SET
              gsc_property_url = COALESCE($2, gsc_property_url),
              gsc_credentials_encrypted = COALESCE($3, gsc_credentials_encrypted)
            WHERE id = $1
          `,
          [
            request.params.id,
            propertyInput || null,
            credentialsToPersist
          ]
        );
      }

      const results: Array<{
        file_id: string;
        filename: string;
        deleted: boolean;
        gsc_status: "submitted" | "failed" | "skipped";
        gsc_error?: string;
      }> = [];

      for (const file of filesResult.rows) {
        const displayName = downloadDisplayName(
          request.params.id,
          file.filename
        );

        let gscStatus: "submitted" | "failed" | "skipped" = "skipped";
        let gscError: string | null = null;

        if (credentials) {
          const sitemapUrl = isHttpUrl(file.filename)
            ? file.filename
            : `${session.base_url.replace(/\/+$/, "")}/sitemaps/${displayName}`;

          request.log.info(
            { sitemapUrl, propertyUrl, fileId: file.id },
            "submitting GSC sitemap deletion"
          );

          const gscResult = await deleteFromGSC(
            propertyUrl,
            sitemapUrl,
            credentials
          );

          if (gscResult.success) {
            gscStatus = "submitted";
          } else {
            gscStatus = "failed";
            gscError = gscResult.error ?? "GSC deletion failed";
          }
        }

        await pool.query(
          `
            UPDATE sitemap_files
            SET
              is_deleted = true,
              deleted_at = NOW(),
              gsc_deletion_status = $3,
              gsc_deletion_error = $4
            WHERE session_id = $1 AND id = $2
          `,
          [request.params.id, file.id, gscStatus, gscError]
        );

        results.push({
          file_id: file.id,
          filename: displayName,
          deleted: true,
          gsc_status: gscStatus,
          ...(gscError ? { gsc_error: gscError } : {})
        });
      }

      await invalidateSessionZipCache(request.params.id);

      return reply.send({ results });
    }
  );

  // Undo a soft-delete: restore files locally and clear their GSC deletion
  // state. This does NOT re-add them to Google Search Console.
  app.post<{ Params: SessionParams; Body: RestoreFilesBody }>(
    "/api/sessions/:id/files/restore",
    async (request, reply) => {
      const sessionResult = await pool.query(
        "SELECT 1 FROM sessions WHERE id = $1",
        [request.params.id]
      );

      if (sessionResult.rowCount === 0) {
        return reply.code(404).send({
          error: "Not Found",
          message: "session not found"
        });
      }

      const fileIds = parseFileIds(request.body.file_ids);

      if ("error" in fileIds) {
        return reply.code(400).send(badRequest(fileIds.error));
      }

      const restoreResult = await pool.query<{ id: string }>(
        `
          UPDATE sitemap_files
          SET
            is_deleted = false,
            deleted_at = NULL,
            gsc_deletion_status = NULL,
            gsc_deletion_error = NULL
          WHERE session_id = $1 AND id = ANY($2::uuid[])
          RETURNING id
        `,
        [request.params.id, fileIds]
      );

      await invalidateSessionZipCache(request.params.id);

      return reply.send({ restored: restoreResult.rowCount ?? 0 });
    }
  );

  app.get<{ Params: FileParams }>(
    "/api/sessions/:id/files/:fileId",
    async (request, reply) => {
      const fileResult = await pool.query(
        `
          SELECT
            id,
            session_id,
          filename,
          source_role,
          total_urls,
            parsed_at,
            is_valid,
            parse_error,
            parse_error_offset,
            is_index,
            had_preamble_stripped,
            is_empty,
            mismatched_url_count
          FROM sitemap_files
          WHERE session_id = $1 AND id = $2
        `,
        [request.params.id, request.params.fileId]
      );
      const file = fileResult.rows[0];

      if (!file) {
        return reply.code(404).send({
          error: "Not Found",
          message: "sitemap file not found"
        });
      }

      return {
        sitemap_file: file
      };
    }
  );

  // ---- URL deletion (Fix 2) + trailing-slash fix (Fix 3) ------------------

  const PROBLEM_STATUSES = [301, 302, 307, 308, 404];

  type SampledUrlParams = { id: string; urlId: string };

  // Resolve a sampled URL that belongs to this session (via its pattern).
  async function loadSessionSampledUrl(sessionId: string, urlId: string) {
    const result = await pool.query<{
      id: string;
      url: string;
      pattern_id: string;
      deleted_from_files: string[] | null;
    }>(
      `
        SELECT s.id, s.url, s.pattern_id, s.deleted_from_files
        FROM sampled_urls s
        JOIN patterns p ON p.id = s.pattern_id
        WHERE p.session_id = $1 AND s.id = $2
      `,
      [sessionId, urlId]
    );

    return result.rows[0] ?? null;
  }

  // Current, local, non-deleted files for a session with their display labels.
  async function loadDisplayFileMap(sessionId: string) {
    const result = await pool.query<{ id: string; filename: string }>(
      `
        SELECT id, filename
        FROM sitemap_files
        WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
      `,
      [sessionId]
    );

    return result.rows
      .filter((row) => !isHttpUrl(row.filename))
      .map((row) => ({
        id: row.id,
        stored: row.filename,
        display: displaySourceFilename(sessionId, row.filename)
      }));
  }

  // Count exact <loc> occurrences of `url` in a stored file (streaming).
  async function countUrlOccurrences(storedFilename: string, url: string) {
    let count = 0;

    await streamSitemapUrlLocs(storedFilename, (loc) => {
      if (loc === url) {
        count += 1;
      }
    });

    return count;
  }

  // Which files a sampled URL appears in (+ occurrence counts) — powers the
  // drawer "This URL appears in:" list.
  app.get<{ Params: SampledUrlParams }>(
    "/api/sessions/:id/sampled-urls/:urlId/files",
    async (request, reply) => {
      const sampled = await loadSessionSampledUrl(
        request.params.id,
        request.params.urlId
      );

      if (!sampled) {
        return reply.code(404).send(badRequest("sampled url not found"));
      }

      // Narrow the scan to the files that contributed to this URL's pattern.
      const occResult = await pool.query<{ source_file: string }>(
        "SELECT DISTINCT source_file FROM pattern_file_occurrences WHERE pattern_id = $1",
        [sampled.pattern_id]
      );
      const occ = new Set(occResult.rows.map((row) => row.source_file));
      const files = await loadDisplayFileMap(request.params.id);
      const candidates = occ.size > 0
        ? files.filter((file) => occ.has(file.display))
        : files;

      const matches: Array<{
        sitemap_file_id: string;
        filename: string;
        occurrence_count: number;
      }> = [];

      for (const file of candidates) {
        try {
          await access(path.join(config.uploadDir, file.stored));
        } catch {
          continue;
        }

        const count = await countUrlOccurrences(file.stored, sampled.url);

        if (count > 0) {
          matches.push({
            sitemap_file_id: file.id,
            filename: file.display,
            occurrence_count: count
          });
        }
      }

      return { url: sampled.url, files: matches };
    }
  );

  // Delete one sampled URL from selected files (synchronous — drawer flow).
  app.post<{ Params: SampledUrlParams; Body: { file_ids?: unknown } }>(
    "/api/sessions/:id/sampled-urls/:urlId/delete-from-files",
    async (request, reply) => {
      const sampled = await loadSessionSampledUrl(
        request.params.id,
        request.params.urlId
      );

      if (!sampled) {
        return reply.code(404).send(badRequest("sampled url not found"));
      }

      const fileIds = Array.isArray(request.body?.file_ids)
        ? (request.body.file_ids as unknown[]).filter(
            (value): value is string => typeof value === "string"
          )
        : [];

      if (fileIds.length === 0) {
        return reply.code(400).send(badRequest("file_ids is required"));
      }

      const files = await loadDisplayFileMap(request.params.id);
      const selectedDisplays = files
        .filter((file) => fileIds.includes(file.id))
        .map((file) => file.display);

      if (selectedDisplays.length === 0) {
        return reply.code(400).send(badRequest("no matching files"));
      }

      const merged = Array.from(
        new Set([...(sampled.deleted_from_files ?? []), ...selectedDisplays])
      );

      await pool.query(
        "UPDATE sampled_urls SET is_deleted_from_sitemap = true, deleted_from_files = $2 WHERE id = $1",
        [sampled.id, merged]
      );

      const { urlsRemoved } = await rebuildSessionDeletions({
        sessionId: request.params.id,
        scope: selectedDisplays
      });

      await invalidateSessionZipCache(request.params.id);

      return {
        deleted_from_files: selectedDisplays.length,
        urls_removed: urlsRemoved
      };
    }
  );

  // Restore one previously-deleted sampled URL back into its files.
  app.post<{ Params: SampledUrlParams }>(
    "/api/sessions/:id/sampled-urls/:urlId/restore-to-files",
    async (request, reply) => {
      const sampled = await loadSessionSampledUrl(
        request.params.id,
        request.params.urlId
      );

      if (!sampled) {
        return reply.code(404).send(badRequest("sampled url not found"));
      }

      const affected = sampled.deleted_from_files ?? null;

      await pool.query(
        "UPDATE sampled_urls SET is_deleted_from_sitemap = false, deleted_from_files = NULL WHERE id = $1",
        [sampled.id]
      );

      await rebuildSessionDeletions({
        sessionId: request.params.id,
        scope: affected ?? "all"
      });

      await invalidateSessionZipCache(request.params.id);

      return { restored: true };
    }
  );

  function parseStatusQuery(raw: string | undefined) {
    const requested = (raw ?? "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => PROBLEM_STATUSES.includes(value));

    return requested.length > 0 ? requested : PROBLEM_STATUSES;
  }

  // Lightweight count of still-present confirmed problem URLs (redirects / 404s)
  // for the results-page "Delete URLs (N)" badge. Cheap query — no file scan —
  // so it is safe to call on every page load.
  app.get<{ Params: SessionParams; Querystring: { status?: string } }>(
    "/api/sessions/:id/problem-urls/count",
    async (request) => {
      const statuses = parseStatusQuery(request.query.status);

      const result = await pool.query<{ count: string }>(
        `
          SELECT COUNT(*)::text AS count
          FROM sampled_urls s
          JOIN patterns p ON p.id = s.pattern_id
          WHERE p.session_id = $1
            AND s.is_deleted_from_sitemap = false
            AND s.http_status = ANY($2::int[])
        `,
        [request.params.id, statuses]
      );

      return { count: Number(result.rows[0]?.count ?? 0) };
    }
  );

  // Still-present problem URLs (redirects / 404s) grouped by the file their
  // <loc> physically appears in, for the file-first "Delete Problem URLs" modal.
  // Only confirmed (sampled) problem URLs are counted — those are the ones
  // deletion can act on. Each file also carries the distinct pattern(s) its
  // problem URLs came from (info-only) and up to 5 sample URLs for the
  // expandable preview. Scans candidate files, so open behind a spinner.
  app.get<{ Params: SessionParams; Querystring: { status?: string } }>(
    "/api/sessions/:id/problem-files",
    async (request) => {
      const statuses = parseStatusQuery(request.query.status);

      const groups = await collectProblemFileGroups({
        sessionId: request.params.id,
        statuses
      });

      const files = groups.map((group) => ({
        file_id: group.file_id,
        filename: group.filename,
        problem_url_count: group.problem_url_count,
        sample_urls: group.sample_urls,
        statuses: group.statuses,
        patterns: group.patterns
      }));

      return {
        files,
        total_files: files.length,
        total_problem_urls: files.reduce(
          (sum, file) => sum + file.problem_url_count,
          0
        )
      };
    }
  );

  // Enqueue file-first deletion: remove every confirmed problem URL (matching
  // the selected statuses) from the selected files (background job).
  app.post<{
    Params: SessionParams;
    Body: { file_ids?: unknown; statuses?: unknown };
  }>(
    "/api/sessions/:id/delete-problem-urls",
    async (request, reply) => {
      const fileIds = Array.isArray(request.body?.file_ids)
        ? (request.body.file_ids as unknown[]).filter(
            (value): value is string => typeof value === "string"
          )
        : [];

      if (fileIds.length === 0) {
        return reply.code(400).send(badRequest("file_ids is required"));
      }

      const requestedStatuses = Array.isArray(request.body?.statuses)
        ? (request.body.statuses as unknown[])
            .map((value) => Number(value))
            .filter((value) => PROBLEM_STATUSES.includes(value))
        : [];
      const statuses =
        requestedStatuses.length > 0 ? requestedStatuses : PROBLEM_STATUSES;

      // Resolve selected file ids to the display filenames sampled URLs are
      // keyed under.
      const files = await loadDisplayFileMap(request.params.id);
      const fileDisplays = files
        .filter((file) => fileIds.includes(file.id))
        .map((file) => file.display);

      if (fileDisplays.length === 0) {
        return reply.code(400).send(badRequest("no matching files"));
      }

      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'delete-problem-urls') RETURNING id",
        [request.params.id]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueDeleteProblemUrlsJob({
        session_id: request.params.id,
        job_row_id: jobRowId,
        file_displays: fileDisplays,
        statuses
      });

      return { job_row_id: jobRowId, status: "PENDING" };
    }
  );

  // Poll the latest bulk-deletion / restore job.
  app.get<{ Params: SessionParams }>(
    "/api/sessions/:id/delete-problem-urls/status",
    async (request) => {
      const result = await pool.query<{
        id: string;
        kind: string;
        status: string;
        files_total: number;
        files_done: number;
        items_changed: string;
        error: string | null;
      }>(
        `
          SELECT id, kind, status, files_total, files_done, items_changed, error
          FROM maintenance_jobs
          WHERE session_id = $1 AND kind IN ('delete-problem-urls', 'restore-deleted-urls')
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [request.params.id]
      );

      return { job: result.rows[0] ?? null };
    }
  );

  // Restore ALL deleted URLs for the session (background job).
  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/restore-deleted-urls",
    async (request) => {
      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'restore-deleted-urls') RETURNING id",
        [request.params.id]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueRestoreDeletedUrlsJob({
        session_id: request.params.id,
        job_row_id: jobRowId
      });

      return { job_row_id: jobRowId, status: "PENDING" };
    }
  );

  // Preview the trailing-slash fix (synchronous scan).
  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/fix-trailing-slashes/preview",
    async (request) => {
      return previewTrailingSlash(request.params.id);
    }
  );

  // Enqueue the trailing-slash fix (background job).
  app.post<{ Params: SessionParams; Body: { selected_files?: unknown } }>(
    "/api/sessions/:id/fix-trailing-slashes/apply",
    async (request) => {
      const selectedFiles = Array.isArray(request.body?.selected_files)
        ? (request.body.selected_files as unknown[]).filter(
            (value): value is string => typeof value === "string"
          )
        : null;

      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'fix-trailing-slashes') RETURNING id",
        [request.params.id]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueFixTrailingSlashesJob({
        session_id: request.params.id,
        job_row_id: jobRowId,
        selected_files: selectedFiles
      });

      return { job_row_id: jobRowId, status: "PENDING" };
    }
  );

  // Poll the latest trailing-slash apply / undo job.
  app.get<{ Params: SessionParams }>(
    "/api/sessions/:id/fix-trailing-slashes/status",
    async (request) => {
      const result = await pool.query<{
        id: string;
        kind: string;
        status: string;
        files_total: number;
        files_done: number;
        items_changed: string;
        error: string | null;
      }>(
        `
          SELECT id, kind, status, files_total, files_done, items_changed, error
          FROM maintenance_jobs
          WHERE session_id = $1 AND kind IN ('fix-trailing-slashes', 'fix-trailing-slashes-undo')
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [request.params.id]
      );

      return { job: result.rows[0] ?? null };
    }
  );

  // Undo the most recent trailing-slash fix (background job).
  app.post<{ Params: SessionParams }>(
    "/api/sessions/:id/fix-trailing-slashes/undo",
    async (request) => {
      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'fix-trailing-slashes-undo') RETURNING id",
        [request.params.id]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueFixTrailingSlashesUndoJob({
        session_id: request.params.id,
        job_row_id: jobRowId
      });

      return { job_row_id: jobRowId, status: "PENDING" };
    }
  );
};
