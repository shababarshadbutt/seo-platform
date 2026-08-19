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

// The ESCALATION user-agent, used only after the honest UA above is confirmed
// blocked (see BROWSER_FALLBACK_PROFILE in jobs/sampleUrlCheck.ts).
//
// This is NOT interchangeable with DEFAULT_HTTP_USER_AGENT, and the two must never
// be collapsed: that constant is deliberately the honest crawler UA because a
// browser UA tripped AWS WAF Bot Control on aerooemparts.com and friends (the
// comment above, migration 032). stackedindustrials.com measured the exact
// reverse — the honest UA gets 403/405 there, and this string plus four
// Sec-Fetch-* headers returns clean 200s.
//
// Both findings are real, on sites in the same family, which is why neither UA can
// be "the" default across 650+ sites. The honest one stays primary so nothing
// working today regresses; this one is the second attempt.
//
// The exact string is the pre-migration-032 built-in default, i.e. the one that
// was in production long enough to be measured — kept verbatim rather than bumped
// to a newer Chrome version, because a version nobody has tested is not evidence.
export const BROWSER_PROFILE_USER_AGENT =
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

  // WHICH COMPOSE FILE STARTED THIS CONTAINER. Set as a LITERAL in each file —
  // "dev" in docker-compose.yml, "aws" in docker-compose.aws.yml — never a
  // ${...} substitution, because it identifies the FILE and must not be
  // overridable from .env.
  //
  // Why it exists: the two files default to the same compose project name (the
  // directory), so `docker compose up` without -f on the deployed VM silently
  // REPLACES the production containers with dev-file ones. That happened, and
  // the only symptom was /api/sftp/* answering 503 "SFTP_HOST is unset" while
  // .env plainly had SFTP_HOST — because the dev file did not pass it. Nothing
  // the deployment reported could distinguish "variable missing from .env" from
  // "container built from the wrong file", and it took three rounds to tell
  // apart. Reported on /health and appended to the *ConfigError messages so it
  // takes one look now.
  //
  // "unknown" means neither file started it, which is itself the answer.
  deploymentProfile: process.env.DEPLOYMENT_PROFILE ?? "unknown",
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

  // ---- Durable host-strategy diagnostics ---------------------------------
  //
  // Its own bind-mounted directory rather than a corner of uploads/: these files exist
  // to be read by a human over SSH, and mixing them into the volume that holds session
  // data would put them behind the upload cleanup's rules instead of their own.
  diagnostics: {
    dir: process.env.DIAGNOSTICS_DIR ?? "/diagnostics",
    // DEFAULT ON. The events are bounded per host and per pattern (roughly 25KB per
    // session), and the entire point is that the record is there when a screenshot
    // arrives — not that somebody remembered to turn it on first. A kill switch, not
    // an opt-in.
    enabled: readBooleanFlag(process.env.HOST_STRATEGY_DIAGNOSTICS, true),
    // A hard stop, not a rotation. 32MB of these events means something is emitting
    // per-URL, which is a bug at a call site; rotating would consume the volume while
    // hiding it.
    maxFileBytes: readNumber("DIAGNOSTICS_MAX_FILE_BYTES", {
      fallback: 32 * 1024 * 1024,
      min: 64 * 1024
    }),
    retentionDays: readNumber("DIAGNOSTICS_RETENTION_DAYS", {
      fallback: 7,
      min: 1
    }),
    // The backstop behind the per-file cap, in MB to keep the env var readable. At the
    // measured ~25KB/session this is roughly three orders of magnitude above steady
    // state; it only ever engages if a call site regresses to per-URL logging.
    maxTotalBytes:
      readNumber("DIAGNOSTICS_MAX_TOTAL_MB", { fallback: 2048, min: 16 }) *
      1024 *
      1024,
    // OFF, and it should stay off. A successful S3 publish reclaiming a session's
    // diagnostics saves nothing anyone needs at the box's free space, and the daily
    // sweep already covers abandoned and failed runs — which is most of them, since
    // most sessions never publish at all. The knob exists so that if disk pressure ever
    // becomes real it is already written and tested.
    deleteOnSuccess: readBooleanFlag(
      process.env.DIAGNOSTICS_DELETE_ON_SUCCESS,
      false
    ),
    // "Keep the last day of successful runs", as one number instead of a keep-last-N
    // rule that would need two processes to agree on an ordering.
    deleteOnSuccessMinAgeHours: readNumber(
      "DIAGNOSTICS_DELETE_ON_SUCCESS_MIN_AGE_HOURS",
      { fallback: 24, min: 0 }
    )
  },
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
  // NOTE after the rate drop to 5/s below: 5 req/s against a 300ms origin needs
  // only ~1.5 in flight, so 16 is now well above what throughput requires. Left
  // unchanged deliberately — it bounds sockets while the rate limiter bounds
  // load, and lowering it would not reduce the traffic a target experiences.
  //
  // maxRequestsPerSecond 5 — the real governor, enforced per target host and
  // counted per HTTP REQUEST (see http/hostRateLimiter.ts and verifyProbe.ts).
  //
  // LOWERED FROM 50 on a confirmed incident, reversing the reasoning below.
  // Verify-urls job 0779ff01 ran continuously 11:18:28 -> past 11:45:32 (27+
  // minutes) against a single domain, and a sampled URL on that same domain
  // came back 405 with `x-amzn-waf-action: captcha` at 11:45:32. AWS WAF Bot
  // Control rate-limited the box's egress IP under sustained volume to one
  // host. This is NOT the UA problem from migration 032 — the honest crawler
  // UA is confirmed correct and gets a clean 308 outside burst conditions.
  //
  // The arithmetic that matters: 50 req/s sustained is ~15,000 requests per
  // 5-minute window from one IP to one host. AWS WAF rate-based rules are
  // commonly configured at 2,000 per 5 minutes, so 50/s ran ~7.5x over a
  // typical threshold and 27 minutes was simply how long it took to trip.
  // 5 req/s is ~1,500 per 5 minutes, which leaves headroom under that rule
  // instead of relying on the target not having one.
  //
  // The previous justification for 50 was "~35 req/s for 80 minutes with no
  // reported incident". That observation is now superseded: there IS a reported
  // incident, and an absence of complaints was never evidence of tolerance —
  // WAF actions are silent until they are not.
  //
  // THROUGHPUT COST, stated plainly rather than discovered later: at 5 req/s a
  // 10,000-URL pattern takes ~33 minutes, 100,000 takes ~5.5 hours, and a
  // multi-million-URL pattern is not viable in one run at all. That is a real
  // trade, and the knob exists precisely so a client whose origin is known to
  // tolerate more can be raised deliberately — per client, with their
  // agreement, rather than globally by default.
  //
  // Metering context, unchanged: this is charged per REQUEST, not per check (a
  // check is 1-2 requests), so the number is what the origin actually
  // experiences whatever the pattern's status mix.
  //
  // Raise it only for an origin known to tolerate more.
  // VERIFY_MAX_REQUESTS_PER_SECOND.
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
      fallback: 5,
      min: 1,
      max: 200
    }),
    rateLimitBurst: readNumber("VERIFY_RATE_LIMIT_BURST", {
      fallback: 10,
      min: 1,
      max: 100
    }),
    // How long a stored verdict may be reused instead of re-probed, in hours.
    // 0 disables reuse entirely — every run re-measures everything, which is
    // exactly what happened before this existed.
    //
    // WHY IT MATTERS. At 5 requests/second a large pattern takes hours, and a
    // re-verify used to repeat all of it even for URLs measured minutes earlier.
    // The common workflow is fix-then-recheck, so the second run — the one
    // someone is actually waiting on — was paying full price to re-confirm what
    // it already knew.
    //
    // REUSE IS GATED ON TWO CONDITIONS, and the first one is correctness rather
    // than freshness: the row must have been checked AFTER the session's files
    // last changed (sessions.files_mutated_at). That is the same rule the Fix
    // modal already uses to call a verification "stale", so an edit, a rename or
    // an applied redirect invalidates the cache automatically and nothing has to
    // remember to clear it.
    //
    // The window is the SECOND condition and answers a different question: the
    // files may be untouched while the SITE changed underneath us. 24h is short
    // enough that a verdict is still a fair description of a live page and long
    // enough to cover a working session.
    reuseWindowHours: readNumber("VERIFY_REUSE_WINDOW_HOURS", {
      fallback: 24,
      min: 0,
      max: 8760
    })
  },

  // ---- Private-VPC routing for URL health checks --------------------------
  //
  // The ~650 sites this checker measures run on 7 EC2 boxes inside the SAME VPC
  // as the checker (10.0.x.x). Every health check nonetheless leaves through the
  // box's public IP and comes back in through the site's public edge, which costs
  // egress and puts an AWS WAF in the path — the WAF that forced
  // maxRequestsPerSecond down to 5 above. When a host is listed in the map file,
  // its checks are sent to the private address instead: no internet, no WAF, no
  // new AWS resource (no PrivateLink, no peering, no per-site Route53 zone).
  //
  // OFF BY DEFAULT, for the same reason awsPublishEnabled is: this path changes
  // what the tool REPORTS about a site, and the failure mode is a plausible-
  // looking measurement of the wrong server. It must be switched on deliberately,
  // after the vhost/content checks in the deploy note pass.
  //
  // SCOPE: URL health checks only. Remote sitemap fetches and the cleaner keep
  // using the public path — which is why the DNS override lives on its own
  // dispatcher pair in http/tlsDispatcher.ts rather than on the global one.
  privateRoute: {
    enabled: readBooleanFlag(process.env.PRIVATE_ROUTE_ENABLED),
    mapFile: process.env.PRIVATE_HOST_MAP_FILE ?? "/etc/sitemap/private-hosts.conf",
    // http, because these origins answer on :80 privately and the TLS the public
    // edge terminates buys nothing inside the VPC. If an origin turns out to
    // redirect :80 -> https, the checker detects that per host and flips itself
    // (see isForcedTlsRedirect); this value is only the starting assumption.
    scheme: (process.env.PRIVATE_ROUTE_SCHEME === "https"
      ? "https"
      : "http") as "http" | "https",
    mapReloadSeconds: readNumber("PRIVATE_HOST_MAP_RELOAD_SECONDS", {
      fallback: 60,
      min: 5,
      max: 3600
    }),
    // SHIPPED AT TODAY'S NUMBERS ON PURPOSE. A private origin has no WAF, so the
    // reasoning that pinned verification to 5/s does not apply to it and these
    // could be 10-40x higher. They are not raised here because routing and
    // throughput are two separate changes: if a verdict looks wrong after both
    // land at once, nothing distinguishes "wrong network path" from "origin under
    // load". Raise them per-IP after a full session has been compared against its
    // public-path run.
    maxRequestsPerSecond: readNumber("PRIVATE_MAX_REQUESTS_PER_SECOND", {
      fallback: 5,
      min: 1,
      max: 2000
    }),
    rateLimitBurst: readNumber("PRIVATE_RATE_LIMIT_BURST", {
      fallback: 10,
      min: 1,
      max: 500
    }),
    // Concurrency must rise WITH the rate or the rate is a fiction — measured
    // above: 25 req/s against a 50/s ceiling because concurrency was 8. Ceiling
    // is higher than the public 32 because the private budget is shared by ~93
    // vhosts per box.
    maxConcurrency: readNumber("PRIVATE_MAX_CONCURRENCY", {
      fallback: 16,
      min: 1,
      max: 128
    }),
    // Consecutive transport failures (nothing answered at all) before an IP is
    // abandoned for the life of the process. Mirrors
    // REFUSAL_STREAK_BEFORE_RENEGOTIATION so the two "stop trying" thresholds in
    // this system agree.
    failureStreak: readNumber("PRIVATE_ROUTE_FAILURE_STREAK", {
      fallback: 3,
      min: 1,
      max: 50
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

  // Above this many exact paths, one publish invalidates a single scoped
  // wildcard (".../sitemaps/*") instead of listing every file.
  //
  // Two reasons, and the second is the one that bites. CloudFront caps a
  // non-wildcard request at 3,000 paths, so a large domain cannot be invalidated
  // path-by-path at all. And it bills PER PATH beyond the first 1,000 a month: a
  // 2,650-sitemap domain costs roughly $13 in invalidation every time it
  // publishes, versus one billable path for the wildcard. Exact paths stay the
  // default for small publishes because they are the narrower blast radius, and
  // the wildcard is always scoped to one domain's sitemap folder — never "/*",
  // which would evict every other client site on the shared distribution.
  cloudfrontWildcardThreshold: readNumber("CLOUDFRONT_WILDCARD_THRESHOLD", {
    fallback: 200,
    min: 1,
    max: 3000
  }),

  // Paths per CreateInvalidation request. Below CloudFront's 3,000 hard cap so a
  // rejected batch costs one batch rather than the whole publish.
  cloudfrontMaxPathsPerRequest: readNumber("CLOUDFRONT_MAX_PATHS_PER_REQUEST", {
    fallback: 1000,
    min: 1,
    max: 3000
  }),

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

// Every AWS-gated variable, and whether this container HAS it. Names and
// booleans only — never a value, so this is safe on the unauthenticated /health
// and safe to append to a 503 body. The names are already public in the repo,
// .env.example and docs/aws-deployment.md; what was missing was any way to see
// which of them a RUNNING container actually got.
export function awsConfigStatus() {
  return {
    profile: config.deploymentProfile,
    node_env: config.nodeEnv,
    publish_enabled: config.awsPublishEnabled,
    sftp: {
      SFTP_HOST: config.sftp.host !== "",
      SFTP_USERNAME: config.sftp.username !== "",
      SFTP_BASE_PATH: config.sftp.basePath !== ""
    },
    s3: {
      AWS_REGION: config.s3.region !== "",
      S3_BUCKET: config.s3.bucket !== "",
      PUBLIC_SITEMAP_URL_TEMPLATE: config.publicSitemapUrlTemplate !== ""
    },
    cdn: {
      CLOUDFRONT_DISTRIBUTION_ID: config.cloudfrontDistributionId !== ""
    }
  };
}

// The names of every AWS-gated variable this container is missing.
function unsetAwsVariables(): string[] {
  const status = awsConfigStatus();

  return [
    ...Object.entries(status.sftp),
    ...Object.entries(status.s3),
    ...Object.entries(status.cdn)
  ]
    .filter(([, isSet]) => !isSet)
    .map(([name]) => name);
}

// Diagnostic context appended to a *ConfigError message.
//
// The leading sentence of those messages is deliberately NOT touched: tests
// match on it and the frontend renders it verbatim. This only ADDS what the bare
// sentence could never say — which compose file produced this container, and
// what else is missing — because "SFTP_HOST is unset" on a box whose .env plainly
// sets SFTP_HOST reads as a bug in the app rather than a container built from
// the wrong file.
function configDiagnostics(exclude: string): string {
  const parts: string[] = [];

  if (config.deploymentProfile === "unknown") {
    parts.push(
      "This container reports no DEPLOYMENT_PROFILE, so it was not started by either compose file — check how it was launched"
    );
  } else {
    const startedFrom =
      config.deploymentProfile === "aws"
        ? "docker-compose.aws.yml"
        : config.deploymentProfile === "dev"
          ? "docker-compose.yml"
          : null;

    parts.push(
      `This container reports DEPLOYMENT_PROFILE=${config.deploymentProfile}` +
        (startedFrom ? `, so it was started from ${startedFrom}` : "")
    );

    // The actionable half. Both files default to the same compose project name,
    // so `docker compose up` without -f on the deployed VM replaces the
    // production containers with dev-file ones — which is exactly how a
    // correctly-configured .env ends up serving an unconfigured backend.
    if (config.deploymentProfile === "dev") {
      parts.push(
        "On the deployed box, bring it up with `docker compose -f docker-compose.aws.yml up -d --force-recreate` instead"
      );
    }
  }

  const alsoUnset = unsetAwsVariables().filter((name) => name !== exclude);

  if (alsoUnset.length > 0) {
    parts.push(`Also unset here: ${alsoUnset.join(", ")}`);
  }

  parts.push("See /health for the full picture");

  return ` ${parts.join(". ")}.`;
}

// Why the SFTP feature can't run, or null when it is usable. Checked by the
// routes so a missing deployment env var is a clear 503 rather than a stack
// trace from deep inside the ssh2 client.
export function sftpConfigError(): string | null {
  const disabled = awsFeatureDisabledError();

  if (disabled) {
    return disabled;
  }

  // The leading sentence is unchanged and must stay so — tests match on it and
  // the frontend shows it verbatim. configDiagnostics only appends.
  if (!config.sftp.host) {
    return (
      "SFTP is not configured on this deployment (SFTP_HOST is unset)" +
      configDiagnostics("SFTP_HOST")
    );
  }

  if (!config.sftp.username) {
    return (
      "SFTP is not configured on this deployment (SFTP_USERNAME is unset)" +
      configDiagnostics("SFTP_USERNAME")
    );
  }

  return null;
}

// Why publishing can't run, or null when it is usable.
export function publishConfigError(): string | null {
  const disabled = awsFeatureDisabledError();

  if (disabled) {
    return disabled;
  }

  // Leading sentences unchanged, for the same reason as sftpConfigError above.
  if (!config.s3.region) {
    return (
      "S3 publishing is not configured on this deployment (AWS_REGION is unset)" +
      configDiagnostics("AWS_REGION")
    );
  }

  if (!config.s3.bucket) {
    return (
      "S3 publishing is not configured on this deployment (S3_BUCKET is unset)" +
      configDiagnostics("S3_BUCKET")
    );
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
