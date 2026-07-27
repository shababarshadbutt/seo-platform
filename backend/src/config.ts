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
  // Secret used to encrypt sensitive per-session data at rest (GSC service
  // account JSON). Any non-empty string works; it is stretched to a 32-byte
  // AES-256 key via scrypt. Falls back to a dev-only default so local runs
  // work without extra setup — set a real value in production.
  encryptionKey:
    process.env.ENCRYPTION_KEY ?? "dev-insecure-encryption-key-change-me",

  // ---- Phase 1: SFTP input (AWS Transfer Family) ------------------------
  // Names are the contract in docker-compose.aws.yml — do not rename one side
  // without the other. Everything is optional at boot so a local dev run (and
  // the whole existing test suite) works with none of it set; the SFTP routes
  // report a clear 503 instead, via sftpConfigError().
  sftp: {
    host: process.env.SFTP_HOST ?? "",
    port: readNumber("SFTP_PORT", { fallback: 22, min: 1, max: 65535 }),
    username: process.env.SFTP_USERNAME ?? "",
    // Key is preferred; password is the fallback used when the key file is
    // absent. At least one must be usable — enforced at connect time, not boot.
    privateKeyPath:
      process.env.SFTP_PRIVATE_KEY_PATH ?? "/run/secrets/sftp_private_key",
    password: process.env.SFTP_PASSWORD ?? "",
    // Files live flat in <basePath>/<domain>/.
    basePath: process.env.SFTP_BASE_PATH ?? "sftp-sitemaps-asapsmei",
    // Hard cap on simultaneous SFTP connections across ALL users of this shared
    // VM; excess pulls queue rather than fail.
    maxConcurrentConnections: readNumber("SFTP_MAX_CONCURRENT_CONNECTIONS", {
      fallback: 4,
      min: 1,
      max: 32
    })
  },

  // ---- Phase 1: S3 publish (IAM instance role — never access keys) ------
  s3: {
    bucket: process.env.S3_BUCKET ?? "asap-cms-prod",
    // "{domain}" is substituted per publish; kept as a template so the layout
    // can change without a code change.
    prefixTemplate:
      process.env.S3_SITEMAPS_PREFIX_TEMPLATE ?? "sites/{domain}/sitemaps/",
    region: process.env.AWS_REGION ?? "",
    // Publish NEVER issues DeleteObject (explicit decision: no bucket
    // versioning, so a wrong delete is unrecoverable). A file removed in a
    // session simply stops being referenced by the regenerated index; the
    // orphaned object stays put, harmless. Read as a flag so the decision is
    // visible and auditable rather than implicit in the absence of code.
    allowDelete: (process.env.S3_PUBLISH_ALLOW_DELETE ?? "false") === "true"
  },

  cloudfrontDistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID ?? "",

  // Per-domain publish lock TTL. A crashed publish's lock expires rather than
  // wedging that domain forever; the happy path releases it in a finally.
  publishLockTtlSeconds: readNumber("PUBLISH_LOCK_TTL_SECONDS", {
    fallback: 300,
    min: 30,
    max: 3600
  })
};

// Why the SFTP feature can't run, or null when it is usable. Checked by the
// routes so a missing deployment env var is a clear 503 rather than a stack
// trace from deep inside the ssh2 client.
export function sftpConfigError(): string | null {
  if (!config.sftp.host) {
    return "SFTP is not configured on this deployment (SFTP_HOST is unset)";
  }

  if (!config.sftp.username) {
    return "SFTP is not configured on this deployment (SFTP_USERNAME is unset)";
  }

  return null;
}

// Why publishing can't run, or null when it is usable.
export function publishConfigError(): string | null {
  if (!config.s3.region) {
    return "S3 publishing is not configured on this deployment (AWS_REGION is unset)";
  }

  if (!config.s3.bucket) {
    return "S3 publishing is not configured on this deployment (S3_BUCKET is unset)";
  }

  return null;
}

// Resolve the S3 key prefix for one domain from the template.
export function s3PrefixForDomain(domain: string): string {
  const prefix = config.s3.prefixTemplate.replace("{domain}", domain);

  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}
