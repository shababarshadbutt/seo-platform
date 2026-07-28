export type SessionStatus =
  | "PENDING"
  | "PROCESSING"
  | "EXTRACTING"
  | "EXTRACTED"
  | "SAMPLING"
  | "COMPLETE"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type NumberLike = number | string | null | undefined;

export type ExportFormat = "csv" | "xlsx" | "pdf";

export type Session = {
  id: string;
  name: string;
  base_url: string;
  sample_size: number;
  concurrency: number;
  user_agent?: string;
  status: SessionStatus;
  upload_complete: boolean;
  created_at: string;
  completed_at?: string | null;
  mismatched_url_count?: NumberLike;
  // Pre-generated download ZIP status (Fix 3, v1.26; zip_generating added v1.27).
  // zip_ready → cached ZIP on disk (instant download); zip_generating → the
  // background job is still building it (recently completed). When both are
  // false the download falls back to on-demand streaming — the button is never
  // blocked on ZIP readiness.
  zip_ready?: boolean;
  zip_generating?: boolean;
  zip_generated_at?: string | null;
  // On-demand download ZIP build progress (v1.31 Fix 2). zip_progress is 0-100;
  // zip_progress_file is the number of files zipped so far. Both are updated by
  // whichever builder (on-demand endpoint or background piscina job) is running.
  zip_progress?: NumberLike;
  zip_progress_file?: NumberLike;
  // When trailing slashes were last applied to this session (v1.31 Fix 4) — null
  // if never applied (or undone). Drives the "already applied" re-run warning.
  trailing_slash_fixed_at?: string | null;
  // Resumable-processing state (v1.36 Fix 2). resume_count is how many times the
  // session was resumed after a failure (shown on the results page); the
  // Resume button is offered whenever status is FAILED.
  resume_count?: NumberLike;
  last_failed_at?: string | null;
  // True when 90%+ of sampled URLs returned no HTTP status (>10 sampled) — a
  // strong signal the results are a network/SSL-proxy artifact, not a broken
  // site. Drives the connectivity warning banner. (v1.39 Fix 2)
  connectivity_warning?: boolean;
};

export type SitemapFile = {
  id: string;
  session_id: string;
  filename: string;
  source_role: SitemapSourceRole;
  total_urls: NumberLike;
  parsed_at: string | null;
  is_valid: boolean;
  parse_error: string | null;
  parse_error_offset: NumberLike;
  is_index: boolean;
  had_preamble_stripped: boolean;
  is_empty: boolean;
  is_deleted?: boolean;
  deleted_at?: string | null;
  gsc_deletion_status?: GscDeletionStatus | null;
  gsc_deletion_error?: string | null;
  mismatched_url_count?: NumberLike;
  is_edited?: boolean;
  // Per-file resume checkpoints (v1.36 Fix 2): 'pending' | 'done' through the
  // extract and sample phases. Parse's checkpoint is parsed_at (not null = done).
  extract_status?: string;
  sample_status?: string;
};

export type SitemapFileStatus = "active" | "deleted" | "empty" | "invalid";

export type GscDeletionStatus = "submitted" | "failed" | "skipped";

export type SitemapSourceRole = "current" | "legacy";

export type SitemapUrlPreview = {
  filename: string;
  total_urls: NumberLike;
  is_index: boolean;
  is_valid: boolean;
  preview_patterns: string[];
  parse_error: string | null;
  had_preamble_stripped: boolean;
};

export type UploadRejectedFile = {
  filename: string;
  message: string;
  detected_host?: string;
  expected_host?: string;
};

export type UploadSitemapResponse = {
  session_id?: string;
  status?: SessionStatus;
  sitemap_file_id?: string;
  sitemap_files?: Array<{
    sitemap_file_id: string;
    filename: string;
    is_index: boolean;
    root_element: string | null;
    source_role: SitemapSourceRole;
    parse_job_id?: string;
  }>;
  rejected_files?: UploadRejectedFile[];
  is_index?: boolean;
  root_element?: string | null;
};

type UploadCompleteResponse = {
  session_id: string;
  upload_complete: boolean;
};

export type UploadProgress = {
  loadedBytes: number;
  totalBytes: number;
  transferredFiles: number;
  totalFiles: number;
  percent: number;
};

export type SessionResponse = {
  session: Session;
  sitemap_files: SitemapFile[];
};

export type Pattern = {
  id: string;
  session_id: string;
  source_role: SitemapSourceRole;
  template: string;
  total_urls: NumberLike;
  coverage_pct: NumberLike;
  confidence_pct: NumberLike;
  status: string | null;
  has_suspicious_segment: boolean;
  suspicious_segment_value: string | null;
  redirect_pct: NumberLike;
  missing_in_current: boolean;
  source_file: string | null;
  original_template?: string | null;
  transform_original_template?: string | null;
};

export type SampledUrl = {
  id: string;
  pattern_id: string;
  url: string;
  original_url?: string | null;
  http_status: NumberLike;
  response_ms: NumberLike;
  is_hit: boolean;
  checked_at: string | null;
  final_url: string | null;
  redirect_count: NumberLike;
  http_status_category:
    | "success"
    | "redirect"
    | "failure"
    | "soft_404"
    | null;
  is_soft_404: boolean;
  source_file: string | null;
  // Why a sample got no HTTP status (v1.39 Fix 2) — powers the friendly drawer
  // message. null when the URL returned a status.
  error_reason?: "ssl_cert" | "timeout" | "no_response" | null;
  is_deleted_from_sitemap?: boolean;
  deleted_from_files?: string[] | null;
};

export type MismatchedUrl = {
  id: string;
  sitemap_file_id: string;
  session_id: string;
  filename: string;
  url: string;
  detected_host: string;
  expected_host: string;
  created_at: string;
};

export type SessionHistoryItem = {
  id: string;
  name: string;
  base_url: string;
  status: SessionStatus;
  created_at: string;
  mismatched_url_count: NumberLike;
  total_urls: NumberLike;
  pattern_count: NumberLike;
  healthy_count: NumberLike;
  warning_count: NumberLike;
  broken_count: NumberLike;
  health_score: NumberLike;
  empty_sitemap_count: NumberLike;
};

export type SystemDiskUsage = {
  upload_storage_bytes: number;
  upload_storage_mb: number;
};

type CreateSessionInput = {
  name: string;
  baseUrl: string;
  sampleSize: number;
  concurrency: number;
};

type CreateSessionResponse = {
  session_id: string;
};

type PatternsResponse = {
  patterns: Pattern[];
};

type SamplesResponse = {
  sampled_urls: SampledUrl[];
};

type MismatchedUrlsResponse = {
  mismatched_urls: MismatchedUrl[];
};

type SessionsResponse = {
  sessions: SessionHistoryItem[];
};

const DEFAULT_API_TIMEOUT_MS = 10000;
const EXPORT_API_TIMEOUT_MS = 180000;
const UPLOAD_API_TIMEOUT_MS = 30 * 60 * 1000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Every backend call goes to a RELATIVE path on the frontend's own origin,
// which Next reverse-proxies to BACKEND_URL server-side (see next.config.mjs's
// /api/backend/:path* rewrite).
//
// This replaces an absolute process.env.NEXT_PUBLIC_BACKEND_URL origin, which
// could only ever work when the backend ran on the same machine as the browser.
// On the shared VM every browser is remote: "localhost:3001" would hit the
// user's own laptop and "http://backend:3001" isn't resolvable outside Docker.
// Relative + proxy means one public port, no CORS, and no environment-specific
// host baked into the client bundle at build time.
const BACKEND_PROXY_PREFIX = "/api/backend";

function backendUrl(path: string) {
  return `${BACKEND_PROXY_PREFIX}${path}`;
}

export type RuntimeConfig = {
  seoDeskUrl: string;
  appVersion: string;
  // Gates the SFTP source tab and the Publish-to-S3 button. Both are absent
  // from the DOM when false, not merely disabled.
  awsPublishEnabled: boolean;
};

// Per-deployment values the client needs but that must NOT be inlined at build
// time. Fetched once from this app's own /api/config and cached for the page's
// lifetime — the promise itself is cached so concurrent callers share one
// request rather than racing.
let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

export function getRuntimeConfig(): Promise<RuntimeConfig> {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = fetch("/api/config", { cache: "no-store" })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<RuntimeConfig>)
          : Promise.reject(new Error(`config ${response.status}`))
      )
      .catch(() => {
        // Never let a config blip wedge the cache — the next caller retries.
        runtimeConfigPromise = null;

        // Fails CLOSED on awsPublishEnabled: a config fetch that errors must
        // not be the thing that reveals an unverified publish path.
        return { seoDeskUrl: "", appVersion: "", awsPublishEnabled: false };
      });
  }

  return runtimeConfigPromise;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_API_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  if (init.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener("abort", () => controller.abort(), {
        once: true
      });
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: any = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : `Request failed with status ${response.status}`;

    throw new ApiError(message, response.status, payload);
  }

  return payload as T;
}

export function apiErrorPayload(error: unknown) {
  return error instanceof ApiError ? error.payload : null;
}

export function friendlyApiErrorMessage(
  error: unknown,
  fallback = "Something went wrong."
) {
  // Backend responded with an error status — surface its actual message so the
  // user sees what went wrong rather than a generic connectivity complaint.
  if (error instanceof ApiError) {
    // Out of disk space: the backend maps ENOSPC to HTTP 507, but also catch any
    // disk-related message in case an error slips through with a different code.
    if (
      error.status === 507 ||
      (error.message && error.message.toLowerCase().includes("disk"))
    ) {
      return "Server storage is full — free up disk space and try again";
    }

    if (error.status === 413) {
      return "Too many files selected — try selecting fewer files at once";
    }

    if (error.status >= 500) {
      return `Server error — ${error.message || "please try again"}`;
    }

    if (error.status >= 400) {
      return error.message || "Invalid request — please check your input";
    }

    return error.message || fallback;
  }

  // A timeout aborts the in-flight request client-side; the backend may still be
  // finishing the work, so don't blame connectivity.
  if (error instanceof Error && error.name === "AbortError") {
    return "Request timed out — the operation may still be running in the background";
  }

  if (error instanceof TypeError) {
    return "Cannot connect to backend — make sure Docker is running";
  }

  if (error instanceof Error) {
    if (
      error.message.includes("Failed to fetch") ||
      error.message.includes("fetch failed") ||
      error.message.includes("NetworkError")
    ) {
      return "Cannot connect to backend — make sure Docker is running";
    }

    return error.message || fallback;
  }

  return fallback;
}

export async function createSession(input: CreateSessionInput) {
  const response = await fetchWithTimeout(backendUrl("/api/sessions"), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      base_url: input.baseUrl,
      sample_size: input.sampleSize,
      concurrency: input.concurrency
    })
  });

  return readJsonResponse<CreateSessionResponse>(response);
}

export async function uploadSitemap(
  sessionId: string,
  files: File[],
  legacyFiles: File[] = [],
  options: {
    onProgress?: (progress: UploadProgress) => void;
  } = {}
): Promise<UploadSitemapResponse> {
  const formData = new FormData();
  const totalFiles = files.length + legacyFiles.length;

  for (const file of files) {
    formData.append("files", file, file.name);
  }

  for (const file of legacyFiles) {
    formData.append("legacy_files", file, file.name);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.open("POST", backendUrl(`/api/sessions/${sessionId}/upload`));
    xhr.timeout = UPLOAD_API_TIMEOUT_MS;

    xhr.upload.onprogress = (event) => {
      const totalBytes = event.lengthComputable ? event.total : 0;
      const percent =
        totalBytes > 0 ? Math.min(100, (event.loaded / totalBytes) * 100) : 0;
      const transferredFiles =
        totalBytes > 0
          ? Math.min(
              totalFiles,
              Math.floor((event.loaded / totalBytes) * totalFiles)
            )
          : 0;

      options.onProgress?.({
        loadedBytes: event.loaded,
        totalBytes,
        transferredFiles,
        totalFiles,
        percent
      });
    };

    xhr.onload = () => {
      let payload: any = null;

      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        const message =
          typeof payload?.message === "string"
            ? payload.message
            : `Request failed with status ${xhr.status}`;

        reject(new ApiError(message, xhr.status, payload));
        return;
      }

      options.onProgress?.({
        loadedBytes: 0,
        totalBytes: 0,
        transferredFiles: totalFiles,
        totalFiles,
        percent: 100
      });
      resolve(payload as UploadSitemapResponse);
    };

    xhr.onerror = () => {
      reject(new TypeError("Failed to upload sitemap files"));
    };

    xhr.ontimeout = () => {
      const error = new Error("Upload timed out");

      error.name = "AbortError";
      reject(error);
    };

    xhr.send(formData);
  });
}

export async function completeSitemapUpload(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/upload-complete`),
    {
      method: "POST"
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<UploadCompleteResponse>(response);
}

export async function previewSitemapUrl(sitemapUrl: string) {
  const response = await fetchWithTimeout(
    backendUrl("/api/fetch-sitemap"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sitemap_url: sitemapUrl
      })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<SitemapUrlPreview>(response);
}

export async function submitSitemapUrl(
  sessionId: string,
  sitemapUrl: string,
  filename: string
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/url`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sitemap_url: sitemapUrl,
        filename
      })
    }
  );

  return readJsonResponse(response);
}

export async function submitSitemapUrls(
  sessionId: string,
  sitemaps: Array<{
    sitemapUrl: string;
    filename: string;
    sourceRole?: SitemapSourceRole;
  }>
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/urls`),
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sitemaps: sitemaps.map((sitemap) => ({
          sitemap_url: sitemap.sitemapUrl,
          filename: sitemap.filename,
          source_role: sitemap.sourceRole ?? "current"
        }))
      })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<UploadSitemapResponse>(response);
}

export async function getSession(sessionId: string) {
  const response = await fetchWithTimeout(backendUrl(`/api/sessions/${sessionId}`), {
    cache: "no-store"
  });

  return readJsonResponse<SessionResponse>(response);
}

export async function getSessions() {
  const response = await fetchWithTimeout(backendUrl("/api/sessions"), {
    cache: "no-store"
  });
  const data = await readJsonResponse<SessionsResponse>(response);

  return data.sessions;
}

export async function getSystemDiskUsage() {
  const response = await fetchWithTimeout(backendUrl("/api/system/disk"), {
    cache: "no-store"
  });

  return readJsonResponse<SystemDiskUsage>(response);
}

export async function deleteSession(sessionId: string) {
  const response = await fetchWithTimeout(backendUrl(`/api/sessions/${sessionId}`), {
    method: "DELETE"
  });

  if (!response.ok) {
    await readJsonResponse(response);
  }
}

export type CancelSessionResult = {
  cancelled: boolean;
  session_id: string;
};

export async function cancelSession(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/cancel`),
    {
      method: "POST"
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<CancelSessionResult>(response);
}

export type ResumeSessionResult = {
  resumed: boolean;
  session_id: string;
  phase: "parse" | "extract" | "sample" | "complete";
  requeued_count: number;
};

export async function resumeSession(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/resume`),
    {
      method: "POST"
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<ResumeSessionResult>(response);
}

// Timeout (ms) for the pattern-drawer sample fetch. Kept longer than the default
// API timeout so a large pattern gets a fair chance to load, but bounded so the
// drawer never spins forever — on timeout it shows an error + Retry. (v1.36 Fix 1)
export const DRAWER_SAMPLES_TIMEOUT_MS = 15000;

export async function getPatterns(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns`),
    {
      cache: "no-store"
    }
  );
  const data = await readJsonResponse<PatternsResponse>(response);

  return data.patterns;
}

export async function getPatternSamples(
  sessionId: string,
  patternId: string,
  timeoutMs = DEFAULT_API_TIMEOUT_MS
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/samples`),
    {
      cache: "no-store"
    },
    timeoutMs
  );
  const data = await readJsonResponse<SamplesResponse>(response);

  return data.sampled_urls;
}

export async function getMismatchedUrls(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/mismatched-urls`),
    {
      cache: "no-store"
    }
  );
  const data = await readJsonResponse<MismatchedUrlsResponse>(response);

  return data.mismatched_urls;
}

export type FindReplaceResult = {
  affected: number;
  find: string;
  replace: string;
  match_case: boolean;
};

export type FindReplaceUndoResult = {
  restored: number;
};

export type FindReplacePreview = {
  affected_count: number;
  preview: Array<{ before: string; after: string }>;
};

// NOTE: the /find-replace and /find-replace/preview endpoints still exist on
// the backend and back the shared redirect-fix undo (undoFindReplace below).
// The standalone Find & Replace UI was removed in v1.13, so the preview/apply
// client helpers are gone; only undo remains wired to the UI.
export async function undoFindReplace(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/find-replace/undo`),
    {
      method: "POST"
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<FindReplaceUndoResult>(response);
}

export type PatternSourceFile = {
  source_file: string;
  occurrences: number;
};

export type RenamePatternResult = {
  old_template: string;
  new_template: string;
  occurrence_count: number;
  source_files_count: number;
  undo?: boolean;
};

export async function getPatternSourceFiles(
  sessionId: string,
  patternId: string
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/source-files`),
    { cache: "no-store" }
  );
  const data = await readJsonResponse<{ source_files: PatternSourceFile[] }>(
    response
  );

  return data.source_files;
}

export async function renamePatternTemplate(
  sessionId: string,
  patternId: string,
  input: { newTemplate: string; sourceFiles: string[] }
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/rename`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        new_template: input.newTemplate,
        source_files: input.sourceFiles
      })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<RenamePatternResult>(response);
}

export type TransformPatternResult = {
  urls_transformed: number;
  files_rewritten: number;
  old_template: string;
  new_template: string;
  sample_before_after: Array<{ before: string; after: string }>;
};

// Apply a pattern-scoped URL structure transformation (+ optional label rename).
// Heavy like rename, so it uses the long timeout.
export async function transformPatternStructure(
  sessionId: string,
  patternId: string,
  input: {
    newTemplate: string;
    currentStructure: string;
    newStructure: string;
    sourceFiles: string[];
  }
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/transform`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        new_template: input.newTemplate,
        current_structure: input.currentStructure,
        new_structure: input.newStructure,
        source_files: input.sourceFiles
      })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<TransformPatternResult>(response);
}

export async function undoPatternTransform(
  sessionId: string,
  patternId: string
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/transform-undo`
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Fastify rejects an empty body when content-type is JSON — send "{}".
      body: JSON.stringify({})
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{
    undo: boolean;
    files_restored: number;
    template: string;
  }>(response);
}

// A single row in the Fix Redirect URLs modal (v1.42): every URL in the
// pattern, not just the sampled subset. `is_sampled` rows were HTTP-verified
// (their final_url is the observed destination); the rest are inferred by
// applying the confirmed rule, so they carry no http_status.
export type RedirectCandidate = {
  key: string;
  url: string;
  final_url: string;
  is_sampled: boolean;
  sampled_url_id: string | null;
  http_status: NumberLike;
  // The destination itself looks like a not-found / soft-404 page (v1.42.1), so
  // the source URL is a delete candidate rather than a rewrite one.
  destination_not_found: boolean;
};

export type RedirectCandidatesResponse = {
  rule:
    | { kind: "replace"; find: string; replace: string }
    | { kind: "insert"; prefix: string; insert: string }
    | null;
  // The pattern's REAL total occurrence count (the true rewrite scope on
  // accept). Distinct from the bounded review preview below.
  pattern_total_urls: number;
  // How many rows the review preview holds (capped by the pattern_urls sample
  // pool) — for messaging that separates "shown for review" from "will rewrite".
  preview_count?: number;
  sampled_redirect_count: number;
  inferred_count: number;
  candidates: RedirectCandidate[];
};

export async function getRedirectCandidates(
  sessionId: string,
  patternId: string
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/redirect-candidates`
    ),
    { method: "GET" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<RedirectCandidatesResponse>(response);
}

// Delete the given source URLs from the sitemap (Fix Redirect URLs modal's
// Delete action, v1.42.1). Reuses the Delete Problem URLs job/pipeline; returns
// its maintenance job id. Only sampled/verified URLs are removable server-side.
export async function deleteRedirectUrls(
  sessionId: string,
  patternId: string,
  urls: string[]
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/delete-redirect-urls`
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{ job_row_id: string; status: string }>(response);
}

export async function applyPatternRedirects(
  sessionId: string,
  patternId: string,
  urlIds?: string[],
  inferredUrls?: string[]
) {
  const body: { url_ids?: string[]; inferred_urls?: string[] } = {};

  if (urlIds) {
    body.url_ids = urlIds;
  }

  if (inferredUrls && inferredUrls.length > 0) {
    body.inferred_urls = inferredUrls;
  }

  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/apply-redirects`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{
    updated?: number;
    inferred_applied?: number;
    rewritten_loc_count?: number;
    // Set when a widened whole-pattern fix was too large to run inline and was
    // routed to a background job instead. (v1.42)
    queued?: boolean;
    files_total?: number;
  }>(response);
}

export type BulkReplaceFile = {
  filename: string;
  url_count: number;
};

export type BulkReplacePreview = {
  files_affected: number;
  urls_affected: number;
  estimated_seconds: number;
  sample_urls: { before: string; after: string }[];
  files: BulkReplaceFile[];
};

export type BulkReplaceJobStatus =
  | "NONE"
  | "PENDING"
  | "RUNNING"
  | "COMPLETE"
  | "FAILED"
  | "UNDOING"
  | "UNDONE";

export type BulkReplaceStatus = {
  status: BulkReplaceJobStatus;
  job_id?: string;
  files_total?: number;
  files_done?: number;
  urls_rewritten?: number;
  from_pattern?: string;
  to_pattern?: string;
  error?: string | null;
};

export async function previewBulkReplace(
  sessionId: string,
  input: { fromPattern: string; toPattern: string }
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/bulk-replace/preview`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from_pattern: input.fromPattern,
        to_pattern: input.toPattern
      })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<BulkReplacePreview>(response);
}

export async function applyBulkReplace(
  sessionId: string,
  input: { fromPattern: string; toPattern: string; selectedFiles?: string[] }
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/bulk-replace/apply`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from_pattern: input.fromPattern,
        to_pattern: input.toPattern,
        ...(input.selectedFiles ? { selected_files: input.selectedFiles } : {})
      })
    }
  );

  return readJsonResponse<{ job_id: string }>(response);
}

export async function undoBulkReplace(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/bulk-replace/undo`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );

  return readJsonResponse<{ job_id: string }>(response);
}

export type SampledUrlFile = {
  sitemap_file_id: string;
  filename: string;
  occurrence_count: number;
};

export type ProblemFilePattern = {
  id: string;
  template: string;
};

export type ProblemFileSampleUrl = {
  url: string;
  http_status: number;
};

export type ProblemFile = {
  file_id: string;
  filename: string;
  problem_url_count: number;
  sample_urls: ProblemFileSampleUrl[];
  statuses: number[];
  patterns: ProblemFilePattern[];
};

export type ProblemFilesResponse = {
  files: ProblemFile[];
  total_files: number;
  total_problem_urls: number;
};

export type MaintenanceJob = {
  id: string;
  kind: string;
  status: string;
  files_total: number;
  files_done: number;
  items_changed: NumberLike;
  error: string | null;
};

export type TrailingSlashPreview = {
  files_affected: number;
  urls_to_fix: number;
  per_file: Array<{ filename: string; url_count: number }>;
  sample_before_after: Array<{ before: string; after: string }>;
};

export async function getSampledUrlFiles(sessionId: string, urlId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/sampled-urls/${urlId}/files`),
    { cache: "no-store" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{ url: string; files: SampledUrlFile[] }>(response);
}

export async function deleteSampledUrlFromFiles(
  sessionId: string,
  urlId: string,
  fileIds: string[]
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/sampled-urls/${urlId}/delete-from-files`
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_ids: fileIds })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{ deleted_from_files: number; urls_removed: number }>(
    response
  );
}

export async function restoreSampledUrlToFiles(
  sessionId: string,
  urlId: string
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/sampled-urls/${urlId}/restore-to-files`
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{ restored: boolean }>(response);
}

export async function getProblemUrlCount(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/problem-urls/count`),
    { cache: "no-store" }
  );

  return readJsonResponse<{ count: number }>(response);
}

export async function getProblemFiles(sessionId: string, statuses?: number[]) {
  const query =
    statuses && statuses.length > 0 ? `?status=${statuses.join(",")}` : "";
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/problem-files${query}`),
    { cache: "no-store" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<ProblemFilesResponse>(response);
}

export async function deleteProblemUrls(
  sessionId: string,
  fileIds: string[],
  statuses: number[]
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/delete-problem-urls`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_ids: fileIds, statuses })
    }
  );

  return readJsonResponse<{ job_row_id: string; status: string }>(response);
}

export async function getDeleteProblemUrlsStatus(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/delete-problem-urls/status`),
    { cache: "no-store" }
  );

  return readJsonResponse<{ job: MaintenanceJob | null }>(response);
}

export async function restoreDeletedUrls(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/restore-deleted-urls`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );

  return readJsonResponse<{ job_row_id: string; status: string }>(response);
}

export async function previewTrailingSlashes(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/fix-trailing-slashes/preview`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<TrailingSlashPreview>(response);
}

export async function applyTrailingSlashes(
  sessionId: string,
  selectedFiles?: string[]
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/fix-trailing-slashes/apply`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        selectedFiles ? { selected_files: selectedFiles } : {}
      )
    }
  );

  return readJsonResponse<{ job_row_id: string; status: string }>(response);
}

export async function getTrailingSlashStatus(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/fix-trailing-slashes/status`),
    { cache: "no-store" }
  );

  return readJsonResponse<{ job: MaintenanceJob | null }>(response);
}

export async function undoTrailingSlashes(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/fix-trailing-slashes/undo`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );

  return readJsonResponse<{ job_row_id: string; status: string }>(response);
}

export async function getBulkReplaceStatus(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/bulk-replace-status`),
    {
      cache: "no-store"
    }
  );

  return readJsonResponse<BulkReplaceStatus>(response);
}

export type SessionFile = {
  id: string;
  filename: string;
  source_role: SitemapSourceRole;
  total_urls: number;
  is_index: boolean;
  is_deleted: boolean;
  deleted_at: string | null;
  gsc_deletion_status: GscDeletionStatus | null;
  gsc_deletion_error: string | null;
  mismatched_url_count: number;
  mismatched_hosts: string | null;
  status: SitemapFileStatus;
};

export type SessionFilesResponse = {
  session: {
    name: string;
    base_url: string;
    gsc_property_url: string | null;
    gsc_configured: boolean;
  };
  files: SessionFile[];
};

export type FileDeletionResult = {
  file_id: string;
  filename: string;
  deleted: boolean;
  gsc_status: GscDeletionStatus;
  gsc_error?: string;
};

export async function getSessionFiles(
  sessionId: string,
  status?: SitemapFileStatus
) {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/files${query}`),
    { cache: "no-store" }
  );

  return readJsonResponse<SessionFilesResponse>(response);
}

export async function deleteSessionFiles(
  sessionId: string,
  input: {
    fileIds: string[];
    gscPropertyUrl?: string;
    gscCredentials?: string;
  }
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/files/delete`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file_ids: input.fileIds,
        ...(input.gscPropertyUrl
          ? { gsc_property_url: input.gscPropertyUrl }
          : {}),
        ...(input.gscCredentials
          ? { gsc_credentials: input.gscCredentials }
          : {})
      })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{ results: FileDeletionResult[] }>(response);
}

export async function restoreSessionFiles(
  sessionId: string,
  fileIds: string[]
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/files/restore`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_ids: fileIds })
    }
  );

  return readJsonResponse<{ restored: number }>(response);
}

export function getSessionExportUrl(sessionId: string, format: ExportFormat) {
  return backendUrl(
    `/api/sessions/${sessionId}/export?format=${encodeURIComponent(format)}`
  );
}

export async function downloadCorrectedSitemap(
  sessionId: string,
  patternId: string
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/download-sitemap`
    ),
    { cache: "no-store" },
    EXPORT_API_TIMEOUT_MS
  );

  if (!response.ok) {
    const text = await response.text();
    let message = `Download failed with status ${response.status}`;
    let payload: unknown = null;

    try {
      payload = text ? JSON.parse(text) : null;

      if (typeof (payload as { message?: unknown })?.message === "string") {
        message = (payload as { message: string }).message;
      }
    } catch {
      if (text) {
        message = text;
      }
    }

    throw new ApiError(message, response.status, payload);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = downloadFilename(response, "corrected-sitemap.xml");
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

// One file whose <loc>s point at a domain other than the session's base URL;
// the filtered download strips those URLs. `foreign_url_count` is a sampled
// LOWER BOUND (see the backend preview endpoint) — `foreign_url_count_is_minimum`
// marks when the true number is higher; `will_be_empty` is only set when the
// file is provably all-foreign.
export type DownloadForeignFile = {
  // sitemap_files.id — passed back as an exclusion when the user chooses
  // "Exclude X files & download" (v1.31 Fix 5).
  file_id: string;
  filename: string;
  total_urls: number;
  foreign_url_count: number;
  foreign_url_count_is_minimum: boolean;
  will_be_empty: boolean;
};

export type DownloadPreview = {
  has_foreign_urls: boolean;
  session_base_url: string;
  total_affected_files: number;
  total_foreign_urls_min: number;
  counts_are_sampled: boolean;
  affected_files: DownloadForeignFile[];
};

export async function getDownloadPreview(
  sessionId: string,
  type: "edited" | "all"
): Promise<DownloadPreview> {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/download-sitemaps/preview?type=${type}`
    ),
    { cache: "no-store" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<DownloadPreview>(response);
}

// Minimal shape of the File System Access API directory handle we rely on. The
// DOM lib's FileSystemDirectoryHandle type isn't guaranteed in every TS lib
// target, so we describe just what we use.
type DirectoryHandle = {
  name: string;
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
  queryPermission?: (options: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
};

// Persistent (per browser session) download folder, chosen once via "Change
// download folder…" (v1.31 Fix 3). Module-level so it survives re-renders and
// route changes without React state. Chrome/Edge only (File System Access API).
let savedDirectoryHandle: DirectoryHandle | null = null;

export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { showDirectoryPicker?: unknown })
      .showDirectoryPicker === "function"
  );
}

export function getDownloadFolderName(): string | null {
  return savedDirectoryHandle?.name ?? null;
}

// Open the directory picker and remember the chosen folder. Returns the folder
// name, or null if the user dismissed the dialog. Throws if the browser has no
// File System Access API (caller shows the unsupported message).
export async function chooseDownloadFolder(): Promise<string | null> {
  const showDirectoryPicker = (
    window as unknown as {
      showDirectoryPicker?: (options?: {
        mode?: "read" | "readwrite";
      }) => Promise<DirectoryHandle>;
    }
  ).showDirectoryPicker;

  if (typeof showDirectoryPicker !== "function") {
    throw new Error("Folder saving not supported in this browser");
  }

  try {
    const handle = await showDirectoryPicker({ mode: "readwrite" });
    savedDirectoryHandle = handle;
    return handle.name;
  } catch (pickerError) {
    if ((pickerError as { name?: string })?.name === "AbortError") {
      return getDownloadFolderName();
    }
    throw pickerError;
  }
}

// Save a downloaded ZIP. If a download folder has been set, write straight into
// it and return its name (for a success toast). Otherwise fall back to the Save
// As dialog / anchor download (v1.24 behaviour) and return null. A stale or
// permission-revoked folder handle is dropped and also falls back.
export async function saveDownloadZip(
  blob: Blob,
  filename: string
): Promise<string | null> {
  if (savedDirectoryHandle) {
    try {
      if (savedDirectoryHandle.queryPermission) {
        let permission = await savedDirectoryHandle.queryPermission({
          mode: "readwrite"
        });

        if (permission !== "granted" && savedDirectoryHandle.requestPermission) {
          permission = await savedDirectoryHandle.requestPermission({
            mode: "readwrite"
          });
        }

        if (permission !== "granted") {
          throw new Error("permission not granted");
        }
      }

      const fileHandle = await savedDirectoryHandle.getFileHandle(filename, {
        create: true
      });
      const writable = await fileHandle.createWritable();

      await writable.write(blob);
      await writable.close();

      return savedDirectoryHandle.name;
    } catch {
      // Folder handle expired or permission revoked — forget it and fall back.
      savedDirectoryHandle = null;
    }
  }

  await saveBlobWithPicker(blob, filename, { "application/zip": [".zip"] });

  return null;
}

// Fetch a session's sitemap ZIP as a blob (no saving). Kept separate from saving
// so the results page can drive a progress overlay + cancel around the fetch.
// filter=false → raw originals (cross-domain URLs kept). excludeFileIds → files
// skipped entirely (v1.31 Fix 5). Pass a signal to support cancel.
export async function fetchSitemapsZipBlob(
  sessionId: string,
  type: "edited" | "all",
  options: {
    filter?: boolean;
    excludeFileIds?: string[];
    signal?: AbortSignal;
  } = {}
): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams({ type });

  if (options.filter === false) {
    query.set("filter", "false");
  }

  if (options.excludeFileIds && options.excludeFileIds.length > 0) {
    query.set("exclude", options.excludeFileIds.join(","));
  }

  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/download-sitemaps?${query.toString()}`
    ),
    { cache: "no-store", signal: options.signal },
    EXPORT_API_TIMEOUT_MS
  );

  if (!response.ok) {
    const text = await response.text();
    let message = `Download failed with status ${response.status}`;
    let payload: unknown = null;

    try {
      payload = text ? JSON.parse(text) : null;

      if (typeof (payload as { message?: unknown })?.message === "string") {
        message = (payload as { message: string }).message;
      }
    } catch {
      if (text) {
        message = text;
      }
    }

    throw new ApiError(message, response.status, payload);
  }

  const blob = await response.blob();
  const filename = downloadFilename(response, `${type}-sitemaps.zip`);

  return { blob, filename };
}

// Convenience: fetch + save in one call (used for the instant, no-overlay path).
export async function downloadSitemapsZip(
  sessionId: string,
  type: "edited" | "all",
  options: { filter?: boolean; excludeFileIds?: string[] } = {}
): Promise<string | null> {
  const { blob, filename } = await fetchSitemapsZipBlob(sessionId, type, options);

  return saveDownloadZip(blob, filename);
}

function downloadFilename(response: Response, fallback: string) {
  const disposition = response.headers.get("content-disposition");
  const match = disposition?.match(/filename="?([^"]+)"?/i);

  return match?.[1] ?? fallback;
}

export async function downloadSessionExport(
  sessionId: string,
  format: ExportFormat
) {
  const response = await fetchWithTimeout(
    getSessionExportUrl(sessionId, format),
    {},
    EXPORT_API_TIMEOUT_MS
  );

  if (!response.ok) {
    const text = await response.text();
    let message = `Export failed with status ${response.status}`;
    let payload: unknown = null;

    try {
      payload = text ? JSON.parse(text) : null;

      if (typeof (payload as { message?: unknown })?.message === "string") {
        message = (payload as { message: string }).message;
      }
    } catch {
      if (text) {
        message = text;
      }
    }

    throw new ApiError(message, response.status, payload);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = downloadFilename(response, `sitemap-report.${format}`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export function numberValue(value: NumberLike) {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = typeof value === "number" ? value : Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

// ---- Sitemap Cleaner (stateless) ---------------------------------------

export type CleanerDropReason = "empty" | "wrong_domain" | "unparsable";

export type CleanerSummary = {
  files_processed: number;
  files_kept: number;
  files_dropped: number;
  dropped_files: { filename: string; reason: CleanerDropReason }[];
  duplicates_removed: number;
  duplicate_urls: { url: string; kept_in: string; also_in: string[] }[];
  output_files: { filename: string; url_count: number }[];
  index_files_detected: number;
  total_urls_kept_files: number;
  clean_urls_remaining: number;
  reduction_pct: number;
};

export type CleanerProgressEvent =
  | {
      type: "progress";
      stage: string;
      message: string;
      current?: number;
      total?: number;
    }
  | {
      type: "done";
      summary: CleanerSummary;
      download_token: string;
      zip_filename: string;
    }
  | { type: "error"; message: string };

export type CleanerDone = {
  summary: CleanerSummary;
  download_token: string;
  zip_filename: string;
};

// POST the upload to the cleaner and consume the Server-Sent Events stream,
// invoking onEvent for each progress/done/error event. Resolves with the final
// done payload (summary + download token).
export async function processCleaner(
  formData: FormData,
  onEvent: (event: CleanerProgressEvent) => void,
  signal?: AbortSignal
): Promise<CleanerDone> {
  const response = await fetch(backendUrl("/api/cleaner/process"), {
    method: "POST",
    body: formData,
    signal
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let message = `Cleaning failed with status ${response.status}`;

    try {
      const payload = text ? JSON.parse(text) : null;

      if (typeof payload?.message === "string") {
        message = payload.message;
      }
    } catch {
      if (text) {
        message = text;
      }
    }

    throw new ApiError(message, response.status, null);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: CleanerDone | null = null;
  let errorMessage: string | null = null;

  const handleEvent = (raw: string) => {
    const dataLine = raw
      .split("\n")
      .find((line) => line.startsWith("data:"));

    if (!dataLine) {
      return;
    }

    const json = dataLine.slice(5).trim();

    if (!json) {
      return;
    }

    let event: CleanerProgressEvent;

    try {
      event = JSON.parse(json) as CleanerProgressEvent;
    } catch {
      return;
    }

    onEvent(event);

    if (event.type === "done") {
      done = {
        summary: event.summary,
        download_token: event.download_token,
        zip_filename: event.zip_filename
      };
    } else if (event.type === "error") {
      errorMessage = event.message;
    }
  };

  try {
    for (;;) {
      const { value, done: streamDone } = await reader.read();

      if (streamDone) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");

      while (boundary !== -1) {
        handleEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (readError) {
    // The socket dropped mid-stream (timeout, proxy close, network blip). Only
    // treat it as a genuine interruption if we never received the final `done`
    // event — otherwise the clean actually finished. Flagged so the caller can
    // show a "stream closed" message instead of the misleading "Cannot connect
    // to backend". (v1.37 Fix 1)
    if (!done && !errorMessage) {
      throw new ApiError(
        "The processing stream closed before finishing.",
        0,
        { code: "stream_closed", cause: readError }
      );
    }
  }

  if (buffer.trim()) {
    handleEvent(buffer);
  }

  if (errorMessage) {
    throw new ApiError(errorMessage, 500, null);
  }

  if (!done) {
    // Stream ended cleanly but no `done` event arrived — the server closed the
    // connection early (e.g. its request timeout fired). Distinct from a
    // connectivity failure. (v1.37 Fix 1)
    throw new ApiError("The processing stream closed before finishing.", 0, {
      code: "stream_closed"
    });
  }

  return done;
}

export type CleanerHandoffFile = {
  index: number;
  filename: string;
  size: number;
};

export type CleanerHandoff = {
  domain: string;
  files: CleanerHandoffFile[];
};

// Fetch the metadata (domain + cleaned file list) for a cleaner run token so the
// Migration New Analysis page can pre-fill from it. Throws ApiError(404) if the
// token has expired. (v1.37 Fix 2)
export async function getCleanerHandoff(token: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/cleaner/handoff/${token}`),
    { cache: "no-store" }
  );

  return readJsonResponse<CleanerHandoff>(response);
}

// Download one cleaned file (by index) from a cleaner run token and return it as
// a File so it can be dropped straight into the normal upload flow. (v1.37 Fix 2)
export async function fetchCleanerHandoffFile(
  token: string,
  file: CleanerHandoffFile
): Promise<File> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/cleaner/handoff/${token}/file/${file.index}`),
    { cache: "no-store" },
    EXPORT_API_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new ApiError(
      `Could not load cleaned file ${file.filename}`,
      response.status,
      null
    );
  }

  const blob = await response.blob();

  return new File([blob], file.filename, { type: "application/xml" });
}

// Save a blob via the native Save As dialog on Chrome/Edge (File System Access
// API), falling back to a standard anchor download elsewhere. Mirrors the
// Download Sitemaps behaviour shipped in v1.24.
export async function saveBlobWithPicker(
  blob: Blob,
  filename: string,
  accept: Record<string, string[]>
) {
  const showSaveFilePicker = (
    window as unknown as {
      showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: Array<{
          description?: string;
          accept: Record<string, string[]>;
        }>;
      }) => Promise<{
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;

  if (typeof showSaveFilePicker === "function") {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "File", accept }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (pickerError) {
      if ((pickerError as { name?: string })?.name === "AbortError") {
        return;
      }
      // Otherwise fall through to the anchor download.
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadCleanerZip(token: string, filename: string) {
  const response = await fetch(backendUrl(`/api/cleaner/download/${token}`), {
    cache: "no-store"
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    throw new ApiError(
      text || `Download failed with status ${response.status}`,
      response.status,
      null
    );
  }

  const blob = await response.blob();

  await saveBlobWithPicker(blob, filename, { "application/zip": [".zip"] });
}

function csvField(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Build the duplicates CSV client-side from the summary (same columns the
// backend writes into the ZIP), so the standalone CSV download needs no extra
// round-trip or server state.
export function buildDuplicatesCsv(
  rows: { url: string; kept_in: string; also_in: string[] }[]
) {
  const header = "url,kept_in_file,duplicate_in_files";
  const lines = rows.map(
    (row) =>
      `${csvField(row.url)},${csvField(row.kept_in)},${csvField(
        row.also_in.join("; ")
      )}`
  );

  return `${[header, ...lines].join("\r\n")}\r\n`;
}

export async function downloadDuplicatesCsv(
  rows: { url: string; kept_in: string; also_in: string[] }[],
  filename: string
) {
  const blob = new Blob([buildDuplicatesCsv(rows)], {
    type: "text/csv;charset=utf-8"
  });

  await saveBlobWithPicker(blob, filename, { "text/csv": [".csv"] });
}

// ---- Phase 1: publish to S3 -----------------------------------------------

export type PublishPreview = {
  domain: string;
  bucket: string;
  prefix: string;
  index_filename: string;
  file_count: number;
  total_bytes: number;
  // First 50 production filenames, for a spot-check in the confirm dialog.
  files: string[];
  // Files deleted in-session: dropped from the regenerated index. NOT deleted
  // from the bucket — publish issues no DeleteObject at all.
  omitted_deleted: string[];
  deletes_objects: boolean;
  // Another publish of this same domain is already running.
  locked: boolean;
};

export async function getPublishPreview(sessionId: string, domain: string) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/publish/preview?domain=${encodeURIComponent(domain)}`
    ),
    { method: "GET" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<PublishPreview>(response);
}

export type PublishStartResult = {
  queued?: boolean;
  job_id?: string;
  domain?: string;
};

// Throws ApiError with status 409 when another publish holds this domain's
// lock; the caller surfaces payload.message as plain text rather than a dump.
export async function publishSession(sessionId: string, domain: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/publish`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<PublishStartResult>(response);
}

// ---- Phase 1: SFTP source ------------------------------------------------

export type SftpDomainsResult = {
  domains: string[];
  pool?: { limit: number; available: number; queued: number };
};

export async function getSftpDomains() {
  const response = await fetchWithTimeout(
    backendUrl("/api/sftp/domains"),
    { method: "GET" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<SftpDomainsResult>(response);
}

// Queue a pull of every sitemap file for `domain` into this session. The files
// land through the same ingestion path a manual upload uses.
export async function startSftpPull(sessionId: string, domain: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/sources/sftp`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain })
    },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<{ queued?: boolean; job_id?: string; domain?: string }>(
    response
  );
}

export type PublishProgressEvent = {
  type: "progress" | "done" | "error";
  stage?: string;
  current?: number;
  total?: number;
  message?: string;
  result?: {
    uploaded?: number;
    bytes?: number;
    index_key?: string;
    omitted_deleted?: string[];
    invalidation_id?: string | null;
  };
};

// Follow a running publish. Same SSE shape the Cleaner already streams, so the
// consumer logic is the familiar one. Returns the EventSource so the caller can
// close it on unmount.
export function followPublishProgress(
  sessionId: string,
  onEvent: (event: PublishProgressEvent) => void
): EventSource {
  const source = new EventSource(
    backendUrl(`/api/sessions/${sessionId}/publish/progress`)
  );

  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as PublishProgressEvent);
    } catch {
      // Ignore malformed frames rather than tearing the stream down.
    }
  };
  source.onerror = () => {
    source.close();
  };

  return source;
}
