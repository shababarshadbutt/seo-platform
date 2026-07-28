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

// Boolean env vars, read strictly: ONLY the exact string "true" enables. A flag
// that guards an unverified path must not be switched on by "1", "yes" or "TRUE"
// — if the value isn't unambiguous the safe reading is off. Exported so the rule
// is testable rather than being an inline comparison repeated per flag.
export function readBooleanFlag(
  raw: string | undefined,
  fallback = false
): boolean {
  if (raw === undefined || raw === "") {
    return fallback;
  }

  return raw === "true";
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

  // ---- Phase 1: master feature flag -------------------------------------
  // Gates the two capabilities that have NEVER completed a round trip against
  // real AWS: the SFTP pull source and publishing to S3/CloudFront. Everything
  // else on this branch is verified, so only these two hide behind the flag.
  // Default OFF: DevOps deploys this branch as-is, and an unverified path that
  // writes to live production must not be discoverable by accident. Flip to
  // true only after the CloudFront mapping is confirmed and the
  // throwaway-domain live test in docs/aws-deployment.md passes.
  awsPublishEnabled: readBooleanFlag(process.env.AWS_PUBLISH_ENABLED),

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

  // The PUBLIC url a search engine fetches a sitemap at. Deliberately a separate
  // config from s3.prefixTemplate above: that one is where objects LIVE in the
  // bucket, this one is where CloudFront SERVES them. The two happen to share
  // the "sitemaps" segment under the mapping we could test against MinIO, but
  // they are set by different systems (our uploader vs. the distribution's
  // origin path / behaviours) and nothing guarantees they stay in step. Keeping
  // them independent means a different real mapping is an .env change here, not
  // a code change. Placeholders: {domain}, {file}.
  publicSitemapUrlTemplate:
    process.env.PUBLIC_SITEMAP_URL_TEMPLATE ??
    "https://{domain}/sitemaps/{file}",

  cloudfrontDistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID ?? "",

  // Per-domain publish lock TTL. A crashed publish's lock expires rather than
  // wedging that domain forever; the happy path releases it in a finally.
  publishLockTtlSeconds: readNumber("PUBLISH_LOCK_TTL_SECONDS", {
    fallback: 300,
    min: 30,
    max: 3600
  })
};

// Why the AWS-gated features can't run, or null when the flag allows them.
// Deliberately checked FIRST by both gates below, so hiding the UI is not the
// only thing standing between a curious user and an unverified code path: with
// the flag off the endpoints refuse regardless of what a client sends.
function awsFeatureDisabledError(): string | null {
  return config.awsPublishEnabled
    ? null
    : "This feature is disabled on this deployment (AWS_PUBLISH_ENABLED is not true): the SFTP pull and S3 publish paths are unverified against real AWS infrastructure";
}

// Why the SFTP feature can't run, or null when it is usable. Checked by the
// routes so a missing deployment env var is a clear 503 rather than a stack
// trace from deep inside the ssh2 client.
export function sftpConfigError(): string | null {
  const disabled = awsFeatureDisabledError();

  if (disabled) {
    return disabled;
  }

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
  const disabled = awsFeatureDisabledError();

  if (disabled) {
    return disabled;
  }

  if (!config.s3.region) {
    return "S3 publishing is not configured on this deployment (AWS_REGION is unset)";
  }

  if (!config.s3.bucket) {
    return "S3 publishing is not configured on this deployment (S3_BUCKET is unset)";
  }

  // A template without {file} would resolve every child sitemap to the SAME
  // <loc>, producing a syntactically valid index that points at one file. That
  // is silent, so reject it here rather than publishing a broken index.
  if (!config.publicSitemapUrlTemplate.includes("{file}")) {
    return "PUBLIC_SITEMAP_URL_TEMPLATE must contain {file} (every sitemap would otherwise get the same <loc>)";
  }

  return null;
}

// Resolve the S3 key prefix for one domain from the template — where the object
// is STORED. Not related to publicSitemapUrl below; see the note on
// config.publicSitemapUrlTemplate for why these two are separate.
export function s3PrefixForDomain(domain: string): string {
  const prefix = config.s3.prefixTemplate.replace("{domain}", domain);

  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

// Resolve the public url one sitemap is SERVED at. Derived only from the
// template — never from the S3 key or its prefix, so a CloudFront mapping that
// doesn't match our bucket layout is a config change, not a code change. The
// template is a parameter so tests can exercise alternative mappings without
// reloading the module.
export function publicSitemapUrl(
  domain: string,
  filename: string,
  template: string = config.publicSitemapUrlTemplate
): string {
  return template.replaceAll("{domain}", domain).replaceAll("{file}", filename);
}
