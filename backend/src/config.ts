type NumberEnvOptions = {
  fallback: number;
  min?: number;
  max?: number;
};

export const DEFAULT_HTTP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function readNumber(name: string, options: NumberEnvOptions): number {
  const raw = process.env[name];

  if (!raw) {
    return options.fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value)) {
    return options.fallback;
  }

  if (options.min !== undefined && value < options.min) {
    return options.min;
  }

  if (options.max !== undefined && value > options.max) {
    return options.max;
  }

  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: readNumber("PORT", { fallback: 3001, min: 1, max: 65535 }),
  workerHealthPort: readNumber("WORKER_HEALTH_PORT", {
    fallback: 3002,
    min: 1,
    max: 65535
  }),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://sitemap:sitemap@localhost:5432/sitemap_health",
  migrationsDir: process.env.MIGRATIONS_DIR ?? "migrations",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  uploadDir: process.env.UPLOAD_DIR ?? "/uploads",
  exportDir: process.env.EXPORT_DIR ?? "/exports",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
  pdfBackendUrl: process.env.PDF_BACKEND_URL,
  chromiumPath: process.env.CHROMIUM_PATH,
  patternUrlPoolMultiplier: readNumber("PATTERN_URL_POOL_MULTIPLIER", {
    fallback: 20,
    min: 1
  }),
  patternUrlPoolMinSize: readNumber("PATTERN_URL_POOL_MIN_SIZE", {
    fallback: 1000,
    min: 1
  }),
  defaultHttpUserAgent:
    process.env.DEFAULT_HTTP_USER_AGENT ?? DEFAULT_HTTP_USER_AGENT,

  // ---- Sitemap Cleaner ------------------------------------------------------
  // A cleaner run is owned by the API process, not by a queue. These control how
  // long one is allowed to live and how loudly it reports itself.

  // A run whose client has stopped watching is aborted after this. Keyed on the
  // SSE heartbeat, not on subscriber count — a socket can linger open long after
  // the tab is gone, so counting subscribers never reaps.
  cleanerAbandonGraceMs:
    readNumber("CLEANER_ABANDON_GRACE_MINUTES", {
      fallback: 5,
      min: 1,
      max: 120
    }) *
    60 *
    1000,
  // A run is reserved before its upload arrives. If the upload never comes, the
  // reservation (and its working directory) must not leak.
  cleanerPendingUploadMs:
    readNumber("CLEANER_PENDING_UPLOAD_TIMEOUT_SECONDS", {
      fallback: 120,
      min: 10,
      max: 3600
    }) * 1000,
  cleanerRequestTimeoutMs:
    readNumber("CLEANER_REQUEST_TIMEOUT_MINUTES", {
      fallback: 30,
      min: 1,
      max: 240
    }) *
    60 *
    1000,
  // Age-based sweep of <uploadDir>/cleaner/<runId>, so a directory whose owning
  // timer died with a process restart is still reclaimed.
  cleanerRunMaxAgeMs:
    readNumber("CLEANER_RUN_MAX_AGE_HOURS", { fallback: 6, min: 1, max: 168 }) *
    60 *
    60 *
    1000,
  // Log volume. A default run must stay quiet: one timing line plus a bounded
  // heartbeat, and nothing per-file.
  //   trace     -> ~2 debug lines PER FILE (both passes). Diagnostic only.
  //   heartbeat -> one info line per interval, independent of file count.
  cleanerTrace: process.env.CLEANER_TRACE === "1",
  cleanerHeartbeatMs:
    readNumber("CLEANER_HEARTBEAT_SECONDS", { fallback: 30, min: 0, max: 3600 }) *
    1000,
  // Secret used to encrypt sensitive per-session data at rest (GSC service
  // account JSON). Any non-empty string works; it is stretched to a 32-byte
  // AES-256 key via scrypt. Falls back to a dev-only default so local runs
  // work without extra setup — set a real value in production.
  encryptionKey:
    process.env.ENCRYPTION_KEY ?? "dev-insecure-encryption-key-change-me"
};
