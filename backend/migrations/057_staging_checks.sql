-- URL health checks against a STAGING environment (the 1.90 / 2.0 toggle, v2.0).
--
-- WHY. The sitemap files this tool cleans, rewrites, downloads and publishes are
-- always the PRODUCTION files. But while a site is being rebuilt, the question
-- "is this URL alive?" has to be answered by the DEV/STAGING host, not by
-- production — the prod page may still 200 while its replacement does not exist
-- yet, and vice versa. Until now the only origin a check could reach was
-- sessions.base_url, fixed at session creation, so there was no way to say
-- "these files are prod, but check the URLs over there".
--
-- WHAT THIS DOES NOT CHANGE — and this is the load-bearing part.
--
-- sampled_urls.url and verified_urls.url keep the PRODUCTION identity of the
-- page. The staging host NEVER appears in a stored URL. That is not tidiness:
-- sampled_urls.url is rewrite-participating. It is UPDATEd in lockstep with the
-- XML (bulkReplaceJob, patternStructureJob, maintenanceJobs), and
-- maintenanceJobs cross-joins it against verified_urls.url as RAW TEXT
-- (AND s.url = ANY($3::text[])). A dev host on one side and the prod <loc> on
-- the other makes that match silently return zero rows — delete-by-status stops
-- marking sampled rows and collectProblemFileGroups scans the prod XML for
-- strings that are not in it. Identity and transport are two different values,
-- the same split http/privateRoute.ts already makes (see 045); staging changes
-- the transport only.
--
-- Sitemap XML, rewrites, ZIP downloads, S3 publish and GSC are untouched by all
-- of this and always use production.
--
-- NO NEW ENVIRONMENT VARIABLE IS INTRODUCED, deliberately. The mode lives in
-- app_settings because a user flips it from the navbar at runtime, and the API
-- and the worker are separate containers that must agree. Do not "simplify" it
-- into a STAGING_ENABLED env var later: that would make it deploy-time, and
-- config.compose.test.ts would then have to be taught about it in both compose
-- files. Nothing here requires either.

-- ---------------------------------------------------------------------------
-- 1. The global, runtime-flippable mode.
-- ---------------------------------------------------------------------------
--
-- KEY/VALUE rather than a one-row settings table with a CHECK (id = true): the
-- alternative has to be ALTERed for every new setting. Both processes read this
-- through settings/checkMode.ts, which validates the value strictly, so the
-- loose text column never reaches business logic unparsed.
CREATE TABLE IF NOT EXISTS app_settings (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Free text, NOT a foreign key: this deployment has no user table. NULL for a
  -- value written by a migration rather than by a person. Its only job is making
  -- a screenshot of an unexpected mode attributable to someone.
  updated_by  text
);

COMMENT ON TABLE app_settings IS
  'Global, runtime-flippable settings shared by the API and worker containers. Read through backend/src/settings/checkMode.ts, which parses strictly; never read the raw value directly.';

-- '1.90' is both the DEFAULT and the FAIL-CLOSED value. parseCheckMode accepts
-- ONLY the exact string '2.0' — '2', '2.0.0', ' 2.0' and 'TRUE' all mean 1.90 —
-- mirroring readBooleanFlag in config.ts: a flag that changes what the tool
-- reports about a site must not be switched on by an ambiguous value.
INSERT INTO app_settings (key, value)
VALUES ('url_check_mode', '1.90')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The per-session staging origin OVERRIDE.
-- ---------------------------------------------------------------------------
--
-- NULL means "derive dev.<domain> from base_url at check time", which is what
-- makes every session that predates this feature usable in 2.0 mode with no
-- backfill. The column exists for the cases the derivation gets wrong.
--
-- CREATION-ONLY, exactly like base_url (which has no update route either). That
-- immutability is what lets the effective staging origin be recomputed on demand
-- instead of being persisted per run.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS staging_base_url text;

-- An ORIGIN, not a URL: scheme + host + optional port, no path, no trailing
-- slash. Paths are identical between the two environments — that premise is what
-- the whole feature rests on — so a path here would be silently ignored by
-- applyStagingOrigin and the constraint says so up front instead.
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_staging_base_url_absolute;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_staging_base_url_absolute
  CHECK (staging_base_url IS NULL OR staging_base_url ~ '^https?://[^/]+$');

COMMENT ON COLUMN sessions.staging_base_url IS
  'Origin (scheme+host+optional port, NO path) that URL health checks are sent to when the global url_check_mode is 2.0. NULL = derive dev.<domain> from base_url. READ BY THE PROBE PATH ONLY - sitemap XML, rewrites, ZIP downloads, S3 publish and GSC must never consult it.';

-- ---------------------------------------------------------------------------
-- 3. WHICH ENVIRONMENT measured each verdict.
-- ---------------------------------------------------------------------------
--
-- WHY PERSIST IT. This is the same argument as via_private_route in 045, one
-- level up: a verdict is only comparable to another verdict measured against the
-- same server. The stated plan is that the new site eventually becomes
-- production and everything gets re-checked against prod — at which point a
-- staging verdict left lying in these tables would be indistinguishable from a
-- prod one, and would be read as fact. This column is what makes the data
-- self-describing, and what lets the reuse gates force a genuine re-check on a
-- mode switch instead of serving a cross-environment row.
--
-- BOOLEAN rather than an enum or a TEXT origin: verified_urls holds up to ~1.3M
-- rows per session and the fact worth storing is one bit. WHICH staging origin
-- was used is a property of the SESSION (staging_base_url, immutable) and of the
-- run, not of each URL, so it does not belong here.
--
-- NULLABLE WITH NO DEFAULT, following 045 and 043 verbatim. NULL means "written
-- before staging checks existed", which is genuinely different from FALSE
-- ("measured on production"). Every reuse and staleness gate therefore compares
-- COALESCE(checked_on_staging, false), and THAT is what makes 1.90 provably
-- identical to today's behaviour for every pre-existing row — no backfill, no
-- rewrite of 1.3M rows, and no gate that changes its mind about old data.
ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS checked_on_staging BOOLEAN;

ALTER TABLE verified_urls
  ADD COLUMN IF NOT EXISTS checked_on_staging BOOLEAN;

COMMENT ON COLUMN sampled_urls.checked_on_staging IS
  'TRUE when this verdict was measured against the session staging origin, FALSE when against production, NULL for rows predating the 2.0 mode. url and final_url ALWAYS hold the production identity regardless - the staging host never appears in a stored URL.';

COMMENT ON COLUMN verified_urls.checked_on_staging IS
  'See sampled_urls.checked_on_staging. Compared as COALESCE(checked_on_staging,false) by the reuse filter and the stale-row sweep in verifyUrlsJob, which must always agree with each other.';

-- The reuse filter and the sweep both ride on the existing (session_id, url)
-- lookups, so they need no index of their own. This partial index covers the
-- results banner's "was this session checked on staging?" question on the
-- MINORITY value only, which keeps it small on sessions that never used 2.0.
CREATE INDEX IF NOT EXISTS idx_verified_urls_session_staging
  ON verified_urls (session_id)
  WHERE checked_on_staging;
