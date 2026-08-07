type NumberEnvOptions = {
  fallback: number;
  min?: number;
  max?: number;
};

// Identify as a crawler, NOT as a browser. Impersonating Chrome is what broke
// sampling behind AWS WAF: a browser UA arriving without browser TLS/header
// fingerprints trips the Bot Control "signal: non-browser" rule, and the ALB
// answers every request — HEAD and GET alike — with 405 + x-amzn-waf-action:
// captcha. Verified 2026-07-29 against aerooemparts.com, industrialworld360.com
// and acquireelectrical.com: Chrome UA -> 405 captcha, this UA -> 200/301.
export const DEFAULT_HTTP_USER_AGENT =
  "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)";

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

  // ---- URL verification: load placed on the CLIENT's web server ----------
  //
  // These bound traffic we aim at someone else's production origin, which makes
  // them different from every other limit in this file. The numbers below were
  // chosen against two references, not picked for feel:
  //
  //   * SFTP_MAX_CONCURRENT_CONNECTIONS = 4 — our closest existing "don't
  //     overwhelm a remote endpoint" cap. That is a floor to reason from, not a
  //     target: an SFTP session holding a file transfer is far more expensive
  //     for the far side than an HTTP HEAD that returns headers and closes.
  //   * The MEASURED behaviour of the unbounded run this work fixes: ~35 URL
  //     checks/second sustained for 80 minutes at sessions.concurrency = 10.
  //     That number is the thing to come in under. Anything at or above it
  //     would mean shipping a "protection" that protects nothing.
  //
  // maxConcurrency 16 — simultaneous in-flight URL checks, and an upper clamp on
  // sessions.concurrency (which a user may set to 30, defensible for a 20-URL
  // sample burst and not for a sustained sweep).
  //
  // CONCURRENCY AND RATE ARE COUPLED, and getting this wrong makes the rate
  // setting a fiction. A check's requests are sequential, so sustaining R
  // requests/second against an origin of latency L needs at least R x L requests
  // in flight. At 50/s and a 300ms origin that is 15. MEASURED with this left at
  // 8 after the ceiling went to 50: the run held 25.01 req/s against a 50/s
  // ceiling and the limiter never engaged — concurrency was the entire
  // constraint and raising the rate alone changed nothing.
  //
  // 16 is that floor plus headroom. It bounds SOCKETS, not load: load is bounded
  // by maxRequestsPerSecond, which is metered per request and is the real
  // governor. Raising this without raising the rate cannot increase traffic —
  // the limiter still holds the rate, and the extra slots only stop latency from
  // throttling a run below the rate it is already allowed. 16 simultaneous
  // connections is modest for a production origin (a browser opens 6 per host).
  //
  // maxRequestsPerSecond 50 — the real governor, enforced per target host and
  // counted per HTTP REQUEST (see http/hostRateLimiter.ts and verifyProbe.ts).
  //
  // Raised from 25 on the evidence already in hand, not on feel. The broken
  // unbounded run sustained ~35 requests/second against a live client origin
  // for 80 minutes with no reported incident, which is a real observation of
  // what that infrastructure tolerates; 50 is above it but still under a
  // typical Googlebot crawl rate and a fraction of a percent of what a
  // CDN-fronted origin serves.
  //
  // Read this number together with the metering fix: it used to be charged per
  // CHECK, and a check is 1-2 requests, so the OLD "25" delivered up to 49
  // requests/second in practice (measured). The new 50 is therefore closer to a
  // formalisation of the load already being sent than a doubling of it — the
  // difference is that it is now the number the origin actually experiences,
  // whatever the pattern's status mix.
  //
  // Lower it for a small origin. VERIFY_MAX_REQUESTS_PER_SECOND.
  //
  // rateLimitBurst 10 — idle credit only. Lets a small triage draw against an
  // idle host go out immediately instead of being paced over 30s to prove a
  // point. Credit does not accumulate past this, so it cannot become a flood.
  //
  // All three are env-tunable because the right answer depends on the client's
  // infrastructure, which is not knowable here. Lower them for a small origin.
  verification: {
    maxConcurrency: readNumber("VERIFY_MAX_CONCURRENCY", {
      fallback: 16,
      min: 1,
      max: 32
    }),
    maxRequestsPerSecond: readNumber("VERIFY_MAX_REQUESTS_PER_SECOND", {
      fallback: 50,
      min: 1,
      max: 200
    }),
    rateLimitBurst: readNumber("VERIFY_RATE_LIMIT_BURST", {
      fallback: 10,
      min: 1,
      max: 100
    })
  },
  // Secret used to encrypt sensitive per-session data at rest (GSC service
  // account JSON). Any non-empty string works; it is stretched to a 32-byte
  // AES-256 key via scrypt. Falls back to a dev-only default so local runs
  // work without extra setup — set a real value in production.
  encryptionKey:
    process.env.ENCRYPTION_KEY ?? "dev-insecure-encryption-key-change-me",

  // How long after a session completes its upload blobs are deleted as a SAFETY
  // NET for abandoned sessions.
  //
  // This was a hardcoded 1 hour, and it was the primary reclamation path. Two
  // problems: the clock starts when ANALYSIS finishes, not when the user is done
  // — review, fixes and publishing all happen after it — and an hour is not
  // enough to work through a multi-gigabyte client site. It also fired regardless
  // of whether anything had been published.
  //
  // It is now a backstop, at 48 hours, behind the deliberate human-confirmed
  // cleanup (the post-publish prompt and the History storage view). Env-tunable
  // because the right value depends on the volume's headroom and how many
  // concurrent users a deployment has, and neither is knowable here.
  //
  // Floor of 1 hour rather than 0: a zero would delete blobs the instant analysis
  // finished, which no deployment can want. Ceiling of 30 days keeps a typo from
  // effectively disabling the backstop on a 500 GB volume.
  uploadCleanupDelayMs:
    readNumber("UPLOAD_CLEANUP_DELAY_HOURS", {
      fallback: 48,
      min: 1,
      max: 720
    }) *
    60 *
    60 *
    1000,

  // How long a Cleaner run with NOBODY WATCHING keeps going before it is treated
  // as abandoned, aborted, and its SFTP connection slots released.
  //
  // A client disconnect no longer kills the run — that is the point of the
  // reconnect support — but "runs forever unwatched" is not an acceptable
  // alternative on a shared VM: each in-flight transfer holds one of
  // SFTP_MAX_CONCURRENT_CONNECTIONS, and a forgotten run measurably halved
  // throughput for everyone else (found while benchmarking the 2,264-file pull).
  //
  // 5 minutes is the default: comfortably longer than a tab reload, a network
  // blip, or a laptop lid closing for a moment — the SSE stream heartbeats every
  // poll, so a live viewer refreshes this constantly — but short enough that a
  // closed tab frees its slots inside one coffee break rather than holding them
  // for the run's full duration.
  //
  // Applies to the CLEANER only, deliberately. An abandoned Cleaner run produces
  // nothing: its output lives in a process-local cache behind a token the user
  // has to claim. A Migration SFTP pull is the opposite — the files land in a
  // durable session the user will come back to — so it is left to finish.
  cleanerAbandonGraceMs:
    readNumber("CLEANER_ABANDON_GRACE_MINUTES", {
      fallback: 5,
      min: 1,
      max: 120
    }) *
    60 *
    1000,

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
    }),
    // Hard ceiling on a single SFTP connect / transfer / disconnect.
    //
    // There was NO timeout here, and it is a slot leak with teeth: every
    // operation holds one of maxConcurrentConnections for its duration, and
    // ssh2's connect and fastGet can both hang indefinitely on a half-open
    // socket. Observed directly — after a run was stopped, two ESTABLISHED
    // sockets to the SFTP endpoint stayed open and the pool sat at 0 of 2
    // available for minutes, so no other user could pull anything at all.
    //
    // 120s is generous for one file (a 50 MB sitemap over a slow link) while
    // still bounded. Clamped to 10..3600.
    operationTimeoutMs:
      readNumber("SFTP_OPERATION_TIMEOUT_SECONDS", {
        fallback: 120,
        min: 10,
        max: 3600
      }) * 1000
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
