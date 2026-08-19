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
  // When this pattern's redirect fixes were applied. Drives the grey "Fixed"
  // chip; null means never fixed (see fix-visibility.ts).
  redirects_applied_at?: string | null;
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
    // The site's security answered instead of the page (a WAF header, or a
    // 405/501 that survived the GET re-probe). Migration 042 added it to the
    // enum and the checker has been writing it since v1.59 — this union did not
    // list it, so every branch here keyed on the category was type-checked
    // against a value it provably receives and TypeScript called those
    // comparisons impossible. NOT a failure: it means we could not measure the
    // URL, not that the URL is broken.
    | "blocked"
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

// A host whose edge refused EVERY request profile the checker knows.
//
// Its patterns were skipped without a single request rather than probed one by one to
// learn the same refusal thousands of times, so the table shows them unscored. This is
// how the page says that ONCE, with the piece of information that makes it actionable:
// edge_server tells whoever reads it whether a load balancer is refusing our egress IP
// (an allowlist request) or the origin itself is (a different conversation).
export type RefusedHost = {
  host: string;
  verdict: "OK" | "REFUSED";
  winning_rung: string | null;
  edge_server: string | null;
  last_status: number | null;
  decided_at: string;
};

type PatternsResponse = {
  patterns: Pattern[];
  refused_hosts?: RefusedHost[];
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

// GET /api/sessions/:id is the heaviest read in the app — it aggregates over
// every sitemap_file in the session and lists them all — and it was inheriting
// the 10s default, which is what produced "Unable to load this analysis —
// Request timed out" on large sessions. The real fix is server-side (the
// connectivity count is now bounded and indexed; see migration 035), because a
// bigger timeout on an unbounded query only moves the failure. This is the
// belt-and-braces half: enough headroom that a session which is merely large,
// rather than pathological, loads instead of aborting.
const SESSION_API_TIMEOUT_MS = 60000;

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

// ---- Streaming downloads -------------------------------------------------
//
// Every download in this file used to be `await response.blob()`, which has two
// consequences that together produced "the button does nothing for 15 minutes":
//
//   1. NO FEEDBACK. blob() resolves only when the LAST byte has arrived, so a
//      multi-GB ZIP shows nothing at all until it is completely downloaded, then
//      the save dialog appears. There is no point at which the UI can say how far
//      along it is, because it is never told.
//   2. NO TIMEOUT ON THE BODY. fetchWithTimeout clears its timer in a `finally`
//      that runs when fetch() RESOLVES — which is when the response HEADERS
//      arrive, not when the body finishes. So EXPORT_API_TIMEOUT_MS only ever
//      bounded time-to-headers, and the blob() read afterwards was unbounded.
//      (downloadCleanerZip and downloadDuplicatesCsv had no timeout at all.)
//
// (2) is also why a failed download appeared to show nothing. The UI callers DO
// catch and route to setError/friendlyApiErrorMessage — that part was never
// broken. On a stalled body the promise simply never settles, so neither the
// resolve nor the reject path is ever reached and there is nothing to display.
// Nothing was swallowed; the catch was never entered.
//
// This helper fixes both: it streams via getReader() so progress is observable,
// and it bounds the whole transfer with a STALL timer rather than a total-time
// cap — see DOWNLOAD_STALL_TIMEOUT_MS.
//
// Abort on INACTIVITY, not on total elapsed time. A legitimate multi-GB export
// over a slow link can take an hour and must be allowed to finish, so any total
// ceiling would be a guess that eventually kills real work. Sixty seconds with
// zero bytes received, by contrast, is not slow — it is broken.
export const DOWNLOAD_STALL_TIMEOUT_MS = 60000;

export type DownloadProgress = {
  receivedBytes: number;
  // null when the server sent no Content-Length; the UI then shows bytes rather
  // than a percentage instead of inventing one.
  totalBytes: number | null;
  percent: number | null;
};

export type DownloadOptions = {
  onProgress?: (progress: DownloadProgress) => void;
  // Caller-owned cancellation (e.g. a Cancel button), kept distinct from a stall.
  signal?: AbortSignal;
  stallTimeoutMs?: number;
};

// A stall is NOT the same as a request timeout, and must not reuse that message:
// friendlyApiErrorMessage renders AbortError as "the operation may still be
// running in the background", which is true of a slow server-side export and
// false of a dead socket. Its own type keeps the two messages honest.
export class DownloadStalledError extends Error {
  readonly receivedBytes: number;
  readonly stallMs: number;

  constructor(receivedBytes: number, stallMs: number) {
    super(
      `Download stalled — no data received for ${Math.round(
        stallMs / 1000
      )}s after ${formatBytes(receivedBytes)}`
    );
    this.name = "DownloadStalledError";
    this.receivedBytes = receivedBytes;
    this.stallMs = stallMs;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Human-readable "X of Y MB" / "X MB" for a progress event.
export function formatDownloadProgress(progress: DownloadProgress): string {
  if (progress.totalBytes === null) {
    return `${formatBytes(progress.receivedBytes)} downloaded`;
  }

  return `${formatBytes(progress.receivedBytes)} of ${formatBytes(
    progress.totalBytes
  )}`;
}

// Shared !response.ok handling, identical to what each download helper used to
// inline: prefer the backend's own JSON `message`, fall back to raw text.
async function downloadResponseError(
  response: Response,
  fallback: string
): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  let message = fallback;
  let payload: unknown = null;

  try {
    payload = text ? JSON.parse(text) : null;

    if (typeof (payload as { message?: unknown })?.message === "string") {
      message = (payload as { message: string }).message;
    } else if (text) {
      message = text;
    }
  } catch {
    if (text) {
      message = text;
    }
  }

  return new ApiError(message, response.status, payload);
}

// Fetch a URL into a Blob, streaming, with progress and stall detection. THE one
// place this file downloads bytes — the blob() anti-pattern was duplicated across
// six helpers, so a fix applied to one of them (or a timeout added to one of
// them) silently left the other five behind.
export async function downloadToBlob(
  url: string,
  init: RequestInit = {},
  options: DownloadOptions = {},
  notOkFallback = "Download failed"
): Promise<{ blob: Blob; response: Response }> {
  const stallMs = options.stallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS;
  const controller = new AbortController();
  let stalled = false;
  let received = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  // Re-armed on every chunk, so the timer measures INACTIVITY rather than total
  // duration. Armed before fetch() too, so a server that accepts the connection
  // and never sends headers also fails instead of hanging.
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", () => controller.abort(), {
        once: true
      });
    }
  }

  arm();

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });

    if (!response.ok) {
      disarm();

      throw await downloadResponseError(
        response,
        `${notOkFallback} with status ${response.status}`
      );
    }

    const header = response.headers.get("content-length");
    const parsed = header === null ? Number.NaN : Number(header);
    const totalBytes =
      Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";

    // Headers are in: the caller can stop saying "Preparing…" and show a bar.
    options.onProgress?.({
      receivedBytes: 0,
      totalBytes,
      percent: totalBytes === null ? null : 0
    });

    if (!response.body) {
      // No streaming support in this browser. Fall back to blob(), and disarm
      // rather than leave a timer that no chunk can reset armed over a
      // legitimately long download — a false abort is worse than no stall
      // detection on a path modern browsers never take.
      disarm();
      const blob = await response.blob();

      options.onProgress?.({
        receivedBytes: blob.size,
        totalBytes: totalBytes ?? blob.size,
        percent: 100
      });

      return { blob, response };
    }

    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let lastReportAt = 0;

    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      arm();
      chunks.push(value);
      received += value.byteLength;

      // Throttled: a multi-GB body arrives in tens of thousands of chunks and a
      // setState per chunk would cost more than the download. ~10 updates/sec is
      // past the point a human can read anyway.
      const now = Date.now();

      if (now - lastReportAt >= 100) {
        lastReportAt = now;
        options.onProgress?.({
          receivedBytes: received,
          totalBytes,
          percent:
            totalBytes === null
              ? null
              : Math.min(100, Math.round((received / totalBytes) * 100))
        });
      }
    }

    options.onProgress?.({
      receivedBytes: received,
      totalBytes: totalBytes ?? received,
      percent: 100
    });

    return { blob: new Blob(chunks, { type: contentType }), response };
  } catch (error) {
    // Our own stall abort, not the caller's cancellation — report it as what it
    // is. A caller-initiated abort keeps its AbortError so existing cancel
    // handling behaves as before.
    if (stalled) {
      throw new DownloadStalledError(received, stallMs);
    }

    throw error;
  } finally {
    disarm();
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

    // 413 is about BYTES, not file count, and nothing in this app emits it: the
    // upload route allows a 10GB body and 5,000 files. When it appears it comes
    // from something in front of the app — a reverse proxy or load balancer with a
    // request-size cap (nginx's client_max_body_size defaults to 1MB). Saying
    // "select fewer files" sent a real investigation down the wrong path, looking
    // for a client-side count limit that does not exist.
    if (error.status === 413) {
      return "Upload rejected as too large by a proxy in front of the app (HTTP 413) — this is a server/proxy request-size limit, not a file-count limit";
    }

    if (error.status >= 500) {
      return `Server error — ${error.message || "please try again"}`;
    }

    if (error.status >= 400) {
      return error.message || "Invalid request — please check your input";
    }

    return error.message || fallback;
  }

  // A stalled download is not a timed-out request: nothing is still running, the
  // transfer died. Checked BEFORE the AbortError branch below, which it would
  // otherwise fall into (a stall is implemented as an abort) and be reported as
  // "may still be running in the background" — the opposite of what happened.
  if (error instanceof DownloadStalledError) {
    return error.message;
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
      // A connection-level failure: the request never produced a response. That is
      // NOT necessarily the backend being down — a proxy closing the connection
      // mid-upload looks identical from here. Deliberately not a TypeError any
      // more, because friendlyApiErrorMessage renders every TypeError as
      // "Cannot connect to backend — make sure Docker is running", which sent a
      // real investigation looking for a crash that never happened.
      reject(
        new ApiError(
          "The upload connection dropped before the server responded — if a proxy sits in front of the app, check its request-size and timeout limits",
          0,
          { code: "upload_connection_dropped" }
        )
      );
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
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}`),
    { cache: "no-store" },
    SESSION_API_TIMEOUT_MS
  );

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

// ---- Upload storage reclamation -------------------------------------------
//
// Sessions for large client sites reach ~10 GB on a 500 GB volume shared by 10+
// users. Reclamation is explicit and human-confirmed: the post-publish prompt and
// the History storage view both call cleanupSessionUploads below. Only the file
// blobs go — the session row, its patterns and its reports stay.

export type SessionStorage = {
  session_id: string;
  disk_bytes: number;
  disk_file_count: number;
  uploads_cleaned_at: string | null;
};

export async function getSessionStorage(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/storage`),
    { cache: "no-store" }
  );

  return readJsonResponse<SessionStorage>(response);
}

export type StorageSession = {
  id: string;
  name: string;
  base_url: string;
  sftp_domain: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  uploads_cleaned_at: string | null;
  sitemap_file_count: number;
  disk_bytes: number;
  disk_file_count: number;
};

export type StorageOverview = {
  upload_dir: string;
  total_disk_bytes: number;
  safety_net_hours: number;
  sessions: StorageSession[];
};

export async function getStorageOverview() {
  const response = await fetchWithTimeout(
    backendUrl("/api/storage/sessions"),
    { cache: "no-store" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<StorageOverview>(response);
}

export type CleanupUploadsResult = {
  session_id: string;
  freed_bytes: number;
  freed_file_count: number;
};

// Deletes only the upload blobs. Keeps the session row, patterns and history —
// distinct from deleteSession below, which removes the record itself.
export async function cleanupSessionUploads(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/uploads/cleanup`),
    { method: "POST" },
    EXPORT_API_TIMEOUT_MS
  );

  return readJsonResponse<CleanupUploadsResult>(response);
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

// The full payload: patterns plus any host whose edge refused every profile. One
// request, so the "this site refused us" banner can never disagree with the rows it
// sits above.
export async function getPatternsResponse(
  sessionId: string
): Promise<{ patterns: Pattern[]; refusedHosts: RefusedHost[] }> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns`),
    {
      cache: "no-store"
    }
  );
  const data = await readJsonResponse<PatternsResponse>(response);

  return { patterns: data.patterns, refusedHosts: data.refused_hosts ?? [] };
}

export async function getPatterns(sessionId: string) {
  return (await getPatternsResponse(sessionId)).patterns;
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

// ---- Distinct URL structures inside one pattern (v1.49) --------------------

// Mirrors backend/src/sitemaps/structureClusters.ts.
export type StructureFilter = {
  // 0-based ordinal among the template's {param} slots.
  param_index: number;
  anchor: "prefix" | "suffix";
  // Hyphen-joined literal tokens, e.g. "niin-parts".
  value: string;
};

export type StructureCluster = {
  label: string;
  anchor: { direction: "prefix" | "suffix"; value: string } | null;
  urlCount: number;
  examples: string[];
};

export type PatternStructuresResponse = {
  template: string;
  url_pool_size: number;
  positions: Array<{
    segmentIndex: number;
    paramIndex: number;
    clusters: StructureCluster[];
  }>;
  // The SAME real-URL pool the clusters above were detected from (v1.51). The
  // Update Pattern modal filters it client-side to show a real sample URL and a
  // real match count for the combination of structures the user picked, one per
  // {param} position. Bounded at ~1,000 rows server-side.
  urls: string[];
};

export async function getPatternStructures(
  sessionId: string,
  patternId: string
): Promise<PatternStructuresResponse> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/structures`),
    {
      cache: "no-store"
    }
  );

  return readJsonResponse<PatternStructuresResponse>(response);
}

// ---- Full-population URL verification (verify-then-act, v1.49) -------------

export type VerificationJob = {
  id: string;
  status: string;
  urls_total: number;
  urls_done: number;
  items_changed: number | null;
  error: string | null;
  // Which patterns this run covers; null = the whole session. Lets the UI state
  // its scope instead of assuming one.
  pattern_ids: string[] | null;
  // Enumeration-phase progress, in FILES (v1.53). Non-null only while the job is
  // scanning sitemap files to discover the URL population — the phase that used
  // to be an indeterminate spinner because urls_total is 0 throughout it and
  // there was no other signal. Both null = not enumerating.
  //
  // Deliberately NOT folded into urls_total/urls_done: those carry URL counts
  // for this job kind, and a file count against a URL denominator is how the
  // "Verifying 0 of 0" confusion gets rebuilt. See migration 041.
  enum_files_total: number | null;
  enum_files_done: number | null;
  // URLs this run reused from a previous verification instead of re-probing —
  // same files, inside the freshness window. null for runs that predate reuse,
  // which is different from 0 ("reuse was available and nothing qualified").
  //
  // Needed because urls_done STARTS at the reused count, so a mostly-reused run
  // opens near 100%. Without saying why, that reads as skipped work.
  urls_reused: number | null;
};

export type VerificationStatus = {
  job: VerificationJob | null;
  // "pattern" when the caller scoped the request to one pattern, else
  // "session". Everything below is scoped to match.
  scope: "pattern" | "session";
  // Newest checked_at within the scope; null = never verified.
  verified_at: string | null;
  // Files were edited after the last verification — counts may be outdated.
  stale: boolean;
  counts_by_status: Array<{ http_status: number; count: number }>;
};

// Start (or attach to) a verification.
//
// patternIds SCOPES THE RUN, and getting it wrong is expensive: omitting it
// from the Fix modal is what turned a 25,744-URL pattern check into a
// 1,324,310-URL session sweep that ran for 75-90 minutes. Pass the pattern
// being worked on whenever there is one; omit it only for a deliberately
// session-wide check (the Delete Problem URLs dialog).
export async function startUrlVerification(
  sessionId: string,
  patternIds?: string[],
  targetStatuses?: number[]
): Promise<{ job_row_id: string }> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/verify-urls`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(patternIds ? { pattern_ids: patternIds } : {}),
        ...(targetStatuses && targetStatuses.length > 0
          ? { target_statuses: targetStatuses }
          : {})
      })
    }
  );

  return readJsonResponse<{ job_row_id: string }>(response);
}

// patternId scopes the whole response — the job reported, the per-status
// counts, and the freshness check. Omit it for the session-wide view.
export async function getVerificationStatus(
  sessionId: string,
  patternId?: string
): Promise<VerificationStatus> {
  const suffix = patternId
    ? `?pattern_id=${encodeURIComponent(patternId)}`
    : "";
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/verify-urls/status${suffix}`),
    {
      cache: "no-store"
    }
  );

  return readJsonResponse<VerificationStatus>(response);
}

// ---- Sample triage (fast approximate read, v1.50) --------------------------

export type TriageEstimate = {
  http_status: number;
  // Raw count seen in the sample.
  observed: number;
  // Stratified extrapolation to the full population.
  estimate: number;
  ci_low: number;
  ci_high: number;
};

export type TriageStratum = {
  label: string;
  population: number;
  sampled: number;
  hits_by_status: Record<string, number>;
};

export type TriageRun = {
  id: string;
  status: string;
  target_statuses: number[] | null;
  population_total: number;
  sampled_total: number;
  expanded: boolean;
  error: string | null;
  completed_at: string | null;
  result: {
    // The REAL fraction probed. Quote this, not the nominal 1% — the min/max
    // clamps and any adaptive expansion move it.
    sample_rate: number;
    nominal_sample_rate: number;
    duration_ms: number;
    target_statuses: number[];
    estimates: TriageEstimate[];
    strata: TriageStratum[];
  } | null;
};

export async function startPatternTriage(
  sessionId: string,
  patternId: string,
  targetStatuses?: number[]
): Promise<{ run_id: string }> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/triage`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        targetStatuses && targetStatuses.length > 0
          ? { target_statuses: targetStatuses }
          : {}
      )
    }
  );

  return readJsonResponse<{ run_id: string }>(response);
}

export async function getPatternTriage(
  sessionId: string,
  patternId: string
): Promise<{ run: TriageRun | null }> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/triage`),
    {
      cache: "no-store"
    }
  );

  return readJsonResponse<{ run: TriageRun | null }>(response);
}

// Re-measure ONE pattern's sample and rescore its row.
//
// The Status / Confidence / Redirect cells are written only by the sampling job,
// which used to run once per session, so those cells were frozen at whatever the
// checker concluded on the first pass — no amount of triage or verification could
// move them (they write their own tables). This is the path that re-probes the
// pattern's sample pool and rewrites the row.
export type PatternRecheckStatus = {
  running: boolean;
  job_state: string | null;
  status: string;
  confidence_pct: string | null;
  redirect_pct: string | null;
  sample_total: number;
  // How many of those samples were WAF-blocked. The one number that separates
  // "never checked" from "checked, and the site refused to answer" — both of which
  // render as "Not scored".
  blocked_count: number;
  used_fallback_count: number;
  pool_total: number;
  last_checked_at: string | null;
};

export async function startPatternRecheck(
  sessionId: string,
  patternId: string
): Promise<{ job_id: string | null }> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/recheck`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );

  return readJsonResponse<{ job_id: string | null }>(response);
}

export async function getPatternRecheck(
  sessionId: string,
  patternId: string
): Promise<PatternRecheckStatus> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/recheck`),
    {
      cache: "no-store"
    }
  );

  return readJsonResponse<PatternRecheckStatus>(response);
}

const VERIFICATION_POLL_INTERVAL_MS = 1500;
// Full-population checks on huge sessions can genuinely run for hours; the
// backstop only exists so an orphaned poll loop cannot spin forever.
const VERIFICATION_POLL_BACKSTOP_MS = 4 * 60 * 60 * 1000;

// Poll until the verification job leaves PENDING/RUNNING, reporting progress
// ("Verifying 187 of 269 URLs…") along the way. Resolves with the final status.
export async function awaitUrlVerification(
  sessionId: string,
  onProgress?: (done: number, total: number) => void
): Promise<VerificationStatus> {
  const startedAt = Date.now();

  for (;;) {
    const status = await getVerificationStatus(sessionId);
    const job = status.job;

    if (!job || (job.status !== "PENDING" && job.status !== "RUNNING")) {
      return status;
    }

    onProgress?.(job.urls_done, job.urls_total);

    if (Date.now() - startedAt > VERIFICATION_POLL_BACKSTOP_MS) {
      throw new Error("verification is still running; check back later");
    }

    await new Promise((resolve) =>
      setTimeout(resolve, VERIFICATION_POLL_INTERVAL_MS)
    );
  }
}

export type VerifiedUrl = {
  url: string;
  http_status: number | null;
  final_url: string | null;
  source_files: string[];
};

export async function getVerifiedUrls(
  sessionId: string,
  patternId: string,
  options: { statuses?: number[]; limit?: number; offset?: number } = {}
): Promise<{ total: number; urls: VerifiedUrl[] }> {
  const query = new URLSearchParams();

  if (options.statuses && options.statuses.length > 0) {
    query.set("statuses", options.statuses.join(","));
  }

  if (options.limit !== undefined) {
    query.set("limit", String(options.limit));
  }

  if (options.offset !== undefined) {
    query.set("offset", String(options.offset));
  }

  const queryString = query.toString();
  const suffix = queryString.length > 0 ? `?${queryString}` : "";
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/verified-urls${suffix}`
    ),
    {
      cache: "no-store"
    }
  );

  return readJsonResponse<{ total: number; urls: VerifiedUrl[] }>(response);
}

export async function deleteVerifiedUrls(
  sessionId: string,
  patternId: string,
  statuses: number[]
): Promise<{ job_row_id: string }> {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/delete-verified-urls`
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statuses })
    }
  );

  return readJsonResponse<{ job_row_id: string }>(response);
}

export type StatusFileBreakdown = {
  statuses: number[];
  // DISTINCT URLs. Not the sum of the per-file counts below: one <loc> can sit in
  // several sitemap files and is counted once in each.
  total_urls: number;
  files: Array<{ source_file: string; urls: number }>;
};

// Which files the URLs about to be deleted live in, and how many are in each.
// Sourced from verified_urls — the same rows the delete job acts on — so the
// preview and the action cannot disagree. Empty when the pattern has not been
// verified for these statuses yet.
export async function getStatusFileBreakdown(
  sessionId: string,
  patternId: string,
  statuses: number[]
): Promise<StatusFileBreakdown> {
  const query = statuses.length > 0 ? `?statuses=${statuses.join(",")}` : "";
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/status-file-breakdown${query}`
    ),
    { cache: "no-store" }
  );

  return readJsonResponse<StatusFileBreakdown>(response);
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
  // sitemap_files.id for this display name, so the Update Pattern modal can
  // download exactly the ticked files (the download endpoint excludes by id).
  // null when the occurrence has no live file row.
  file_id: string | null;
};

export type RenamePatternResult = {
  old_template: string;
  new_template: string;
  occurrence_count: number;
  source_files_count: number;
  undo?: boolean;
};

// structureFilters, when non-empty, scopes both the file list and each file's
// occurrence count to just that structure — see
// scopedPatternSourceFileBreakdown on the backend for why the whole-pattern
// rollup can't just be filtered client-side after the fact. Omitted/empty
// keeps the old whole-pattern behaviour.
export async function getPatternSourceFiles(
  sessionId: string,
  patternId: string,
  structureFilters?: StructureFilter[]
) {
  const query =
    structureFilters && structureFilters.length > 0
      ? `?structure_filter=${encodeURIComponent(JSON.stringify(structureFilters))}`
      : "";
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/source-files${query}`
    ),
    { cache: "no-store" }
  );
  const data = await readJsonResponse<{ source_files: PatternSourceFile[] }>(
    response
  );

  return data.source_files;
}

// ---- Pattern structure operations run as background jobs -------------------
//
// Rename / transform / transform-undo each rewrite every sitemap file the pattern
// spans. Measured at 823 files / 6.58M URLs that took 136s, and the server keeps
// going after the client's timeout fires — so the old "just use the long timeout"
// approach reported failures for operations that had actually SUCCEEDED, and the
// user's natural retry re-applied them. They are now jobs: the POST/PATCH returns
// a job id in well under a second, and we poll for progress and the result.
//
// The kickoff therefore uses the ORDINARY timeout, not EXPORT_API_TIMEOUT_MS.
// There is no longer any request whose duration scales with the session's size.

export type PatternStructureJobStatus = {
  job_id: string;
  kind: "RENAME" | "TRANSFORM" | "TRANSFORM_UNDO";
  status: "PENDING" | "RUNNING" | "COMPLETE" | "FAILED";
  files_total: number;
  files_done: number;
  urls_rewritten: number;
  result: unknown;
  error: string | null;
  already_completed?: boolean;
};

// Progress of the newest structure operation on a pattern. `status: "NONE"` when
// the pattern has never had one.
export async function getPatternStructureJob(
  sessionId: string,
  patternId: string
) {
  const response = await fetchWithTimeout(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/structure-job`
    ),
    { cache: "no-store" }
  );

  return readJsonResponse<PatternStructureJobStatus | { status: "NONE" }>(
    response
  );
}

export type PatternStructureProgress = {
  filesDone: number;
  filesTotal: number;
};

type PatternStructureKickoff = {
  job_id: string;
  files_total?: number;
  files_done?: number;
  status?: string;
  // Set when this request attached to an operation that was already in flight —
  // i.e. it is the retry of a request whose client gave up.
  already_running?: boolean;
  // Set when the SAME operation had already finished; `result` is replayed.
  already_completed?: boolean;
  result?: unknown;
};

const JOB_POLL_INTERVAL_MS = 1500;
// A backstop so a job row that somehow never reaches a terminal state cannot spin
// forever. Far above any realistic run (the 823-file transform takes ~70s).
const JOB_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Drive a kicked-off structure job to completion and hand back its result — the
// same payload the old synchronous route returned, so callers read it unchanged.
async function awaitPatternStructureJob<T>(
  sessionId: string,
  patternId: string,
  kickoff: PatternStructureKickoff,
  onProgress?: (progress: PatternStructureProgress) => void
): Promise<T & { already_completed?: boolean; already_running?: boolean }> {
  if (kickoff.already_completed && kickoff.result) {
    return {
      ...(kickoff.result as T),
      already_completed: true
    };
  }

  onProgress?.({
    filesDone: kickoff.files_done ?? 0,
    filesTotal: kickoff.files_total ?? 0
  });

  const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;

  for (;;) {
    if (Date.now() > deadline) {
      throw new ApiError(
        "This operation is taking far longer than expected. It may still be running — reload to check.",
        504,
        null
      );
    }

    await sleep(JOB_POLL_INTERVAL_MS);

    const job = await getPatternStructureJob(sessionId, patternId);

    if (!("job_id" in job)) {
      // No job row at all: the row was pruned with its session.
      throw new ApiError("This operation is no longer available.", 404, null);
    }

    onProgress?.({
      filesDone: job.files_done,
      filesTotal: job.files_total
    });

    if (job.status === "FAILED") {
      throw new ApiError(
        job.error ?? "The operation failed.",
        500,
        job
      );
    }

    if (job.status === "COMPLETE") {
      return {
        ...(job.result as T),
        ...(kickoff.already_running ? { already_running: true } : {})
      };
    }
  }
}

export async function renamePatternTemplate(
  sessionId: string,
  patternId: string,
  input: {
    newTemplate: string;
    sourceFiles: string[];
    // Scope the rename to one detected structure (v1.49) — see StructureFilter.
    structureFilters?: StructureFilter[] | null;
  },
  onProgress?: (progress: PatternStructureProgress) => void
) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/patterns/${patternId}/rename`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        new_template: input.newTemplate,
        source_files: input.sourceFiles,
        structure_filter: input.structureFilters ?? null
      })
    }
  );
  const kickoff = await readJsonResponse<PatternStructureKickoff>(response);

  return awaitPatternStructureJob<RenamePatternResult>(
    sessionId,
    patternId,
    kickoff,
    onProgress
  );
}

export type TransformPatternResult = {
  urls_transformed: number;
  files_rewritten: number;
  old_template: string;
  new_template: string;
  sample_before_after: Array<{ before: string; after: string }>;
};

// Apply a pattern-scoped URL structure transformation (+ optional label rename).
// Runs as a background job — see awaitPatternStructureJob.
export async function transformPatternStructure(
  sessionId: string,
  patternId: string,
  input: {
    newTemplate: string;
    currentStructure: string;
    newStructure: string;
    sourceFiles: string[];
    structureFilters?: StructureFilter[] | null;
  },
  onProgress?: (progress: PatternStructureProgress) => void
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
        source_files: input.sourceFiles,
        structure_filter: input.structureFilters ?? null
      })
    }
  );
  const kickoff = await readJsonResponse<PatternStructureKickoff>(response);

  return awaitPatternStructureJob<TransformPatternResult>(
    sessionId,
    patternId,
    kickoff,
    onProgress
  );
}

export async function undoPatternTransform(
  sessionId: string,
  patternId: string,
  onProgress?: (progress: PatternStructureProgress) => void
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
    }
  );
  const kickoff = await readJsonResponse<PatternStructureKickoff>(response);

  return awaitPatternStructureJob<{
    undo: boolean;
    files_restored: number;
    template: string;
  }>(sessionId, patternId, kickoff, onProgress);
}

// A single row in the Fix Redirect URLs modal (v1.42): every URL in the
// pattern, not just the sampled subset. `is_sampled` rows were HTTP-verified
// (their final_url is the observed destination); the rest are inferred by
// applying the confirmed rule, so they carry no http_status.
export type RedirectCandidate = {
  key: string;
  url: string;
  // Null when delete_only: a 404 has no destination to rewrite to.
  final_url: string | null;
  is_sampled: boolean;
  sampled_url_id: string | null;
  http_status: NumberLike;
  // The destination itself looks like a not-found / soft-404 page (v1.42.1), so
  // the source URL is a delete candidate rather than a rewrite one.
  destination_not_found: boolean;
  // No rewrite is possible at all — the PAGE is missing, not its destination.
  // Sampled 404s were previously excluded from this list entirely, so selecting
  // the 404 chip emptied it and the modal claimed "No redirect URLs remain".
  delete_only?: boolean;
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
  // Sampled 404s in the list — delete-only rows, counted apart from the
  // redirects so the modal can say which of the two it is showing.
  sampled_broken_count?: number;
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
  patternId: string,
  options: DownloadOptions = {}
) {
  const { blob, response } = await downloadToBlob(
    backendUrl(
      `/api/sessions/${sessionId}/patterns/${patternId}/download-sitemap`
    ),
    { cache: "no-store" },
    options
  );
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
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams({ type });

  if (options.filter === false) {
    query.set("filter", "false");
  }

  if (options.excludeFileIds && options.excludeFileIds.length > 0) {
    query.set("exclude", options.excludeFileIds.join(","));
  }

  const { blob, response } = await downloadToBlob(
    backendUrl(
      `/api/sessions/${sessionId}/download-sitemaps?${query.toString()}`
    ),
    { cache: "no-store" },
    { signal: options.signal, onProgress: options.onProgress }
  );
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
  format: ExportFormat,
  options: DownloadOptions = {}
) {
  const { blob, response } = await downloadToBlob(
    getSessionExportUrl(sessionId, format),
    {},
    options,
    "Export failed"
  );
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
  // No `duplicate_urls`: the rows are no longer shipped in the summary. They
  // live only in the CSV the backend wrote, fetched on demand by
  // downloadDuplicatesCsv. `duplicates_removed` counts occurrences and so
  // matches the CSV's row count exactly.
  output_files: { filename: string; url_count: number }[];
  index_files_detected: number;
  total_urls_kept_files: number;
  clean_urls_remaining: number;
  reduction_pct: number;
  // Source files that packed several URLs into ONE <loc> with no separator, and
  // how the halves were resolved. Optional so a summary produced by an older
  // backend still parses rather than rendering NaN.
  concatenated_locs?: CleanerConcatenatedLocs;
};

export type CleanerConcatenatedLocs = {
  detected: number;
  parts_kept: number;
  parts_discarded: number;
  fully_resolved: number;
  partially_resolved: number;
  unresolved: number;
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
  | { type: "error"; message: string }
  // First frame of any run stream: the id needed to reconnect to it. Emitted
  // before any work frame so a connection lost one second in is still
  // recoverable.
  // server_epoch identifies the API process that owns this run. Quoted back on
  // reconnect so a 404 can distinguish "the API restarted under me" from "my run
  // was reaped or collected" — see the reconnect branch below.
  | {
      type: "started";
      run_id: string;
      domain: string;
      server_epoch?: string;
    }
  // Synthesised CLIENT-side, never sent by the server: the stream dropped and we
  // are going back for the same run. The UI shows this instead of a failure,
  // because the run is still going — that distinction is the whole point.
  | { type: "reconnecting"; attempt: number; max_attempts: number };

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
  return consumeCleanerRun(
    await fetch(backendUrl("/api/cleaner/process"), {
      method: "POST",
      body: formData,
      signal
    }),
    onEvent
  );
}

// Same clean, pulled from SFTP instead of uploaded. Streams the identical SSE
// shape (including a `done` frame with a download_token), so the whole consumer
// below — and the Cleaner→Migration handoff that follows it — is reused as-is.
// How many times a dropped SFTP-clean stream is reattached before giving up, and
// how long between attempts. The server keeps the run alive for
// CLEANER_ABANDON_GRACE_MINUTES (5 by default) with nobody watching, so the retry
// budget below — 10 attempts, 3s apart, ~30s — sits comfortably inside it: a
// transient blip reconnects long before the run could be reaped, and a client
// that has genuinely gone away stops retrying long before then too.
const CLEANER_RECONNECT_ATTEMPTS = 10;
const CLEANER_RECONNECT_DELAY_MS = 3000;

// Run the SFTP clean, surviving a dropped connection.
//
// The server-side run is independent of any single request, so losing the stream
// is not losing the work. On a drop this reattaches to the SAME run by id and
// keeps reporting progress; the caller sees `reconnecting` frames rather than an
// error. It only fails when the run is genuinely unreachable — a 404 (stopped or
// collected) or the retry budget running out.
export async function processCleanerFromSftp(
  input: { domain: string; siteUrl?: string; subfolder?: string },
  onEvent: (event: CleanerProgressEvent) => void,
  signal?: AbortSignal
): Promise<CleanerDone> {
  let runId: string | null = null;
  let serverEpoch: string | null = null;

  // Captured on the way past so a reconnect knows where to go, while still
  // forwarding every frame to the caller untouched.
  const observe = (event: CleanerProgressEvent) => {
    if (event.type === "started") {
      runId = event.run_id;
      serverEpoch = event.server_epoch ?? null;
    }

    onEvent(event);
  };

  try {
    return await consumeCleanerRun(
      await fetch(backendUrl("/api/cleaner/process-sftp"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: input.domain,
          site_url: input.siteUrl,
          subfolder: input.subfolder
        }),
        signal
      }),
      observe
    );
  } catch (error) {
    // Without a run id there is nothing to reconnect TO — the request never got
    // far enough to start one, so this is a real failure (bad domain, 503, …).
    if (!runId || !isReconnectableStreamError(error)) {
      throw error;
    }
  }

  for (let attempt = 1; attempt <= CLEANER_RECONNECT_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      throw new ApiError("Cleaning was cancelled", 0, null);
    }

    observe({
      type: "reconnecting",
      attempt,
      max_attempts: CLEANER_RECONNECT_ATTEMPTS
    });

    await new Promise((resolve) =>
      setTimeout(resolve, CLEANER_RECONNECT_DELAY_MS)
    );

    let response: Response;

    try {
      // The epoch goes with the request so that if the run is missing, the server
      // can tell us WHY: its own restart, or a genuine reap/collection. Without it
      // a 404 can only guess, and it guessed wrong in the direction that blames
      // the user's connection for a server-side crash.
      const query = serverEpoch
        ? `?epoch=${encodeURIComponent(serverEpoch)}`
        : "";

      response = await fetch(
        backendUrl(
          `/api/cleaner/runs/${encodeURIComponent(runId)}/progress${query}`
        ),
        { signal }
      );
    } catch {
      // Backend unreachable for the moment; that is what the retries are for.
      continue;
    }

    // 404 means the run is genuinely gone — stopped after being left unwatched,
    // or already collected. Retrying cannot help, so surface it.
    if (response.status === 404) {
      const payload = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;

      throw new ApiError(
        payload?.message ??
          "That cleaning run is no longer available.",
        404,
        payload
      );
    }

    try {
      return await consumeCleanerRun(response, observe);
    } catch (error) {
      if (!isReconnectableStreamError(error)) {
        throw error;
      }
      // Dropped again — keep trying while the budget lasts.
    }
  }

  throw new ApiError(
    "Lost the connection to this cleaning run and could not get back to it. It may still be running — reload to check.",
    0,
    { code: "reconnect_exhausted" }
  );
}

// A dropped stream, as opposed to a real refusal. Only the former is worth
// reconnecting for; a 400/503 will fail identically every time.
function isReconnectableStreamError(error: unknown): boolean {
  if (error instanceof ApiError) {
    const payload = error.payload as { code?: string } | null;

    return payload?.code === "stream_closed" || error.status === 0;
  }

  return error instanceof TypeError;
}

async function consumeCleanerRun(
  response: Response,
  onEvent: (event: CleanerProgressEvent) => void
): Promise<CleanerDone> {
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

// Ingest a finished cleaner run into a session SERVER-SIDE. The cleaned files are
// already on the server, so this replaces "download every file to the browser and
// re-upload it as multipart": no second trip over the wire, nothing held in
// browser memory, and no exposure to request-size limits between browser and app.
export type CleanerIngestResult = {
  ingested: number;
  failed: number;
  total: number;
  domain: string;
};

export type CleanerIngestProgress = {
  current: number;
  total: number;
  // How many of `current` were already ingested by a previous attempt and skipped.
  // Surfaced so a resumed retry does not read as a full re-ingest.
  alreadyPresent: number;
};

type CleanerIngestStatus =
  | { status: "NONE" }
  | {
      status: "RUNNING";
      current: number;
      total: number;
      already_present?: number;
      message: string | null;
    }
  | {
      status: "COMPLETE";
      current: number;
      total: number;
      result: CleanerIngestResult | null;
    }
  | { status: "FAILED"; current: number; total: number; error: string };

export async function getCleanerIngestStatus(sessionId: string) {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/sources/cleaner/status`),
    { cache: "no-store" }
  );

  return readJsonResponse<CleanerIngestStatus>(response);
}

// Ingest a finished cleaner run into a session SERVER-SIDE. The cleaned files are
// already on the server, so this replaces "download every file to the browser and
// re-upload it as multipart": no second trip over the wire, nothing held in
// browser memory, and no exposure to request-size limits between browser and app.
//
// The copy+insert work runs as a BACKGROUND JOB and this polls it. It used to be
// one request that did all the work: at ~2,700 files that ran for minutes and died
// as "Server error — fetch failed", which is undici inside our own Next proxy
// abandoning the wait for response headers at 300s (measured 305.1s,
// UND_ERR_HEADERS_TIMEOUT) while the backend was still ingesting. No client-side
// timeout could fix that — the request simply must not be long-running, which is
// why the kickoff now uses the ORDINARY timeout rather than UPLOAD_API_TIMEOUT_MS.
export async function ingestCleanerRun(
  sessionId: string,
  token: string,
  onProgress?: (progress: CleanerIngestProgress) => void
): Promise<CleanerIngestResult> {
  const response = await fetchWithTimeout(
    backendUrl(`/api/sessions/${sessionId}/sources/cleaner`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    }
  );
  const kickoff = await readJsonResponse<{
    queued: boolean;
    job_id: string;
    total: number;
    domain: string;
  }>(response);

  onProgress?.({ current: 0, total: kickoff.total, alreadyPresent: 0 });

  const deadline = Date.now() + 2 * 60 * 60 * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new ApiError(
        "The handoff is taking far longer than expected. It may still be running — reload to check.",
        504,
        null
      );
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    });

    const status = await getCleanerIngestStatus(sessionId);

    if (status.status === "NONE") {
      throw new ApiError("This handoff is no longer available.", 404, null);
    }

    onProgress?.({
      current: status.current,
      total: status.total,
      alreadyPresent:
        status.status === "RUNNING" ? (status.already_present ?? 0) : 0
    });

    if (status.status === "FAILED") {
      throw new ApiError(status.error, 500, status);
    }

    if (status.status === "COMPLETE") {
      return (
        status.result ?? {
          ingested: status.total,
          failed: 0,
          total: status.total,
          domain: kickoff.domain
        }
      );
    }
  }
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
  file: CleanerHandoffFile,
  options: DownloadOptions = {}
): Promise<File> {
  const { blob } = await downloadToBlob(
    backendUrl(`/api/cleaner/handoff/${token}/file/${file.index}`),
    { cache: "no-store" },
    options,
    `Could not load cleaned file ${file.filename}`
  );

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

export async function downloadCleanerZip(
  token: string,
  filename: string,
  options: DownloadOptions = {}
) {
  const { blob } = await downloadToBlob(
    backendUrl(`/api/cleaner/download/${token}`),
    { cache: "no-store" },
    options
  );

  await saveBlobWithPicker(blob, filename, { "application/zip": [".zip"] });
}

// Download the duplicates report the BACKEND already wrote to disk during the
// clean, instead of rebuilding it here.
//
// This used to take the whole row set as an argument and assemble the CSV
// client-side, which meant the API had to hold every duplicate row in memory and
// serialize it through the `done` frame just so this function could reproduce a
// file that already existed on the server. On a large run that copy was hundreds
// of MB of heap on the API for zero benefit. Same bytes, same columns, one
// source of truth — and the browser no longer receives a payload proportional to
// the duplicate count.
export async function downloadDuplicatesCsv(
  token: string,
  filename: string,
  options: DownloadOptions = {}
) {
  const { blob } = await downloadToBlob(
    backendUrl(`/api/cleaner/report/${token}`),
    { cache: "no-store" },
    options
  );

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
  // Files this session lists whose content is no longer on disk (session uploads
  // are deleted an hour after completion). Publishing is REFUSED while this is
  // non-empty: those objects would be left stale in the bucket AND dropped from
  // the regenerated index.
  missing_local: string[];
  // Where the prefix host came from. "sftp" = the folder the files were pulled
  // from (authoritative); "base_url" = the session base URL's host, normalized.
  // The server resolves this itself — the `domain` argument below is ignored.
  domain_source: "sftp" | "base_url";
  // The host used for the public <loc> urls. Legitimately differs from `domain`
  // for a www site: one storage prefix, but the real serving host in the index.
  public_host: string;
  // Set only when an SFTP session's base_url host disagrees with its SFTP
  // folder. The folder wins; this is what was overridden.
  base_url_host_ignored: string | null;
  deletes_objects: boolean;
  // Filenames CloudFront cannot express as an invalidation path (an unsanitized
  // SFTP name with a space, a stray "%", a non-ASCII byte). A WARNING, not a
  // blocker: the file publishes fine, its edge cache just cannot be purged by
  // path. Capped at 50; `uninvalidatable_count` is the true total.
  uninvalidatable: { filename: string; reason: string }[];
  uninvalidatable_count: number;
  // How this publish would invalidate the CDN. "wildcard" = one scoped path for
  // the whole sitemap folder (used for large publishes: CloudFront caps a
  // request at 3,000 paths and bills per path); "exact" = one path per file;
  // "skipped" = no distribution configured.
  invalidation_strategy: "wildcard" | "exact" | "skipped";
  // Another publish of this same domain is already running.
  locked: boolean;
};

// `domain` is sent for backward compatibility and IGNORED by the server: the
// publish prefix is resolved from the session row (SFTP source domain, else the
// normalized base_url host) so a client value can never select which production
// folder gets overwritten. Read the resolved target off the response.
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

// One file the publish could not write. Follows the {filename, reason} shape the
// Cleaner's dropped_files already uses.
export type PublishFailedFile = {
  filename: string;
  reason: string;
  // The regenerated index still references it because an older version of the
  // object is live in the bucket — deliberately kept, since dropping it would
  // de-index live URLs over a transient upload error. False means the file is
  // not on production at all and is not referenced.
  still_indexed: boolean;
};

export type PublishInvalidation = {
  strategy: "wildcard" | "exact" | "skipped";
  invalidation_ids: string[];
  paths_requested: number;
  batches_requested: number;
  batches_failed: number;
  failed_paths: { path: string; reason: string }[];
  // Set when the CDN purge did not fully succeed. This NEVER means the publish
  // failed — every object is already written by the time this runs. It means the
  // edge may serve stale sitemaps until their TTL lapses.
  error: string | null;
};

export type PublishProgressEvent = {
  // "partial" sits between done and error: objects WERE written to production,
  // but some files were skipped or the CDN purge did not complete. Without it a
  // fully successful 2,651-file publish whose invalidation was rejected rendered
  // as a red "Publish failed", which is the opposite of what happened.
  type: "progress" | "done" | "partial" | "error";
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
    failed_files?: PublishFailedFile[];
    invalidation?: PublishInvalidation;
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

export type SftpPullProgressEvent = {
  type: "progress" | "done" | "error";
  stage?: string;
  current?: number;
  total?: number;
  message?: string;
  result?: {
    stored?: number;
    failed?: number;
    total?: number;
    domain?: string;
  };
};

// Follow a running SFTP pull. Same frame shape and same consumer contract as
// followPublishProgress above — only the endpoint differs — so the UI can show
// "N of TOTAL" instead of a bare count that means nothing on its own.
export function followSftpPullProgress(
  sessionId: string,
  onEvent: (event: SftpPullProgressEvent) => void
): EventSource {
  const source = new EventSource(
    backendUrl(`/api/sessions/${sessionId}/sources/sftp/progress`)
  );

  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as SftpPullProgressEvent);
    } catch {
      // Ignore malformed frames rather than tearing the stream down.
    }
  };
  source.onerror = () => {
    source.close();
  };

  return source;
}
