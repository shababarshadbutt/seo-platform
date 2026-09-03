-- Probe-verified leading-zero normalization (v2.0).
--
-- WHY. The rebuilt site drops zero padding from numeric path tokens, so
-- "page-1-003/" is served as "page-1-3/" and "page-3-00/" as "page-3/". A URL
-- alone cannot say which reading applies: "page-3-00" could normalize to
-- "page-3-0" (strip the padding) or to "page-3" (strip it, and drop a token left
-- as plain zero). Both are defensible, and diffPair derives mutually contradictory
-- literal rules from them.
--
-- So the tool stops guessing and ASKS THE SITE. It probes the original URL and
-- each normalized variant, and the one that actually answers wins. Where more than
-- one answers, the run records the ambiguity and an SEO person decides.
--
-- ITS OWN TABLE, not another maintenance_jobs kind, for the same reason
-- verify_triage_runs has one (migration 040): the result is not a counter. It is
-- per-URL evidence — which variants were tried, what each answered, and whether
-- the outcome was resolved, ambiguous or unresolved — which only makes sense as
-- JSON.
--
-- EVIDENCE IS NEVER SELF-APPLYING. Nothing reads this table to rewrite a sitemap.
-- It exists so redirectRuleCandidates can be RANKED by measurement rather than by
-- string diffing, and so an operator can see why one reading was offered ahead of
-- another. Applying still goes through the ordinary Fix flow, ticked by a human.
CREATE TABLE IF NOT EXISTS normalization_probe_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING',
  -- URLs in the pattern that carry a zero-padded token, i.e. the ones this rule
  -- could possibly apply to. The denominator the UI quotes.
  candidates_total integer NOT NULL DEFAULT 0,
  -- How many of those were actually probed. Bounded — see the job — because each
  -- one costs two or three live requests against a host that is frequently
  -- capped at 5 requests/second.
  sampled_total integer NOT NULL DEFAULT 0,
  -- URL PROBES performed -- NOT HTTP requests, and the distinction is the whole
  -- reason this is not called requests_total.
  --
  -- One probe is one URL checked, and it costs TWO HTTP requests in practice:
  -- a clean 2xx pays a HEAD plus the ranged body GET that detects a soft 404,
  -- and a non-clean result pays a HEAD plus the escalation retry on the browser
  -- fallback profile. MEASURED against a live run: 7 probes produced 14 requests
  -- at the origin.
  --
  -- Recorded because guessing it from sampled_total would be wrong -- a URL whose
  -- two readings agree costs one variant probe, not two -- and because a number an
  -- operator reads as "what this cost the client's server" has to mean what it
  -- says. Multiply by two for the request count.
  probes_total integer NOT NULL DEFAULT 0,
  -- WHICH ENVIRONMENT answered. Exactly the argument migration 057 makes for
  -- sampled_urls.checked_on_staging, and it bites harder here: the normalized
  -- URLs are expected to exist ONLY on the new site, so nearly every useful run
  -- of this feature happens in 2.0 mode. After cutover, evidence gathered against
  -- staging must not be read as proof about production.
  checked_on_staging boolean,
  -- { urls: [{ source, original: {status, healthy},
  --            variants: [{kind, url, status, healthy}],
  --            outcome: "already_healthy"|"resolved"|"ambiguous"|"unresolved" }],
  --   totals: { already_healthy, resolved, ambiguous, unresolved },
  --   by_kind: { strip: n, stripDropZero: n } }
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT normalization_probe_runs_counts_nonnegative
    CHECK (candidates_total >= 0 AND sampled_total >= 0 AND probes_total >= 0)
);

-- AT MOST ONE in-flight run per pattern, enforced by the database rather than a
-- check-then-act in the route — the same guard, and the same reason, as
-- verify_triage_runs_one_active_per_pattern. Two overlapping runs would double the
-- request rate at the client's server, which is the cost this feature is most
-- careful about.
CREATE UNIQUE INDEX IF NOT EXISTS normalization_probe_runs_one_active_per_pattern
  ON normalization_probe_runs (pattern_id)
  WHERE status IN ('PENDING', 'RUNNING');

-- "Latest run for this pattern" is the status endpoint's only query shape.
CREATE INDEX IF NOT EXISTS idx_normalization_probe_runs_pattern_started
  ON normalization_probe_runs (pattern_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_normalization_probe_runs_session_id
  ON normalization_probe_runs (session_id);
