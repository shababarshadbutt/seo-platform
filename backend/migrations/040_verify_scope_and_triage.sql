-- Pattern-scoped verification + sample triage (v1.50).
--
-- WHY (the production bug). Opening "Fix Redirect URLs" for ONE pattern
-- (/manufacturer/{param}/{param}, 25,744 URLs) started a verification of the
-- ENTIRE session — observed live as "Verifying 167,575 of 1,324,310 URLs…",
-- 75-90 minutes and still going. The Fix modal's Verify button called
-- startUrlVerification(sessionId) with no pattern_ids, so verifyUrlsJob selected
-- every current pattern. 98% of that sweep was URLs the user was not looking at.
--
-- Scoping alone is not enough, because the SCOPE WAS NEVER RECORDED. Two things
-- keyed off the session and would have silently mis-reported a scoped run:
--
--   1. The route's attach-to-in-flight query matched any RUNNING 'verify-urls'
--      row for the session. A pattern-scoped request arriving while a
--      whole-session run was going would attach to it and report that run's
--      1.3M-URL progress as if it were the pattern's — the exact confusing
--      display the bug report describes. maintenance_jobs.pattern_ids makes
--      "same scope?" answerable, so attach only happens on a real match.
--
--   2. The status endpoint's counts_by_status aggregated verified_urls across
--      the whole session, so a per-pattern chip would show a session-wide
--      number. The column lets the endpoint report the running job's scope back
--      to the client, which then asks for counts scoped the same way.
--
-- NULL = whole session, which is exactly the pre-v1.50 behaviour, so existing
-- rows and the Delete Problem URLs dialog (deliberately session-wide) are
-- unchanged.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS pattern_ids uuid[];

COMMENT ON COLUMN maintenance_jobs.pattern_ids IS
  'For kind ''verify-urls'': the patterns this run covers. NULL = whole session.';

-- Sample triage: the fast, approximate read taken BEFORE committing to a full
-- verification.
--
-- WHY A TABLE AND A JOB, not a synchronous route. Triage is cheap relative to
-- full verification but it is still real network I/O against someone else's
-- production web server: ~400 rate-limited probes is ~16s, and an adaptive
-- expansion can reach ~48s. That is too long to hold an HTTP request open with
-- no progress, and this codebase already answers that shape of problem the same
-- way everywhere else (pattern_structure_jobs, maintenance_jobs) — validate,
-- enqueue, poll.
--
-- It gets its OWN table rather than another maintenance_jobs kind because the
-- result is not a counter: it is a stratified estimate with a confidence
-- interval and a per-sub-pattern breakdown, which only makes sense as JSON.
--
-- ESTIMATES ARE NEVER ACTIONABLE. Nothing reads this table to decide what to
-- delete — deletion still requires verified_urls rows from a full run. This
-- exists so a user can find out whether a full run is worth starting.
CREATE TABLE IF NOT EXISTS verify_triage_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING',
  -- The status codes the caller cared about (e.g. [404] for "Verify 404s"), or
  -- NULL for "tell me about every problem status".
  target_statuses integer[],
  -- Deduplicated population size of the pattern at triage time. The estimate's
  -- denominator, and what the UI prints after "of".
  population_total integer NOT NULL DEFAULT 0,
  -- How many URLs were actually probed. sampled_total / population_total is the
  -- REAL sample rate, which is what the UI must quote — it drifts from the
  -- nominal 1% whenever the min/max clamps or an expansion bind.
  sampled_total integer NOT NULL DEFAULT 0,
  -- True when an anomaly (high observed error rate) triggered a second, larger
  -- draw. Surfaced so "we looked harder here" is visible rather than implied.
  expanded boolean NOT NULL DEFAULT false,
  -- { strata: [{label, population, sampled, hits_by_status, ...}],
  --   estimates: [{http_status, estimate, ci_low, ci_high, observed}], ... }
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT verify_triage_runs_counts_nonnegative
    CHECK (population_total >= 0 AND sampled_total >= 0)
);

-- AT MOST ONE in-flight triage per pattern, enforced by the database rather than
-- a check-then-act in the route — the same guard, for the same reason, as
-- pattern_structure_jobs_one_active_per_pattern. Two overlapping triages on one
-- pattern would double the request rate at the client's server, which is the
-- one thing this whole feature exists to avoid.
CREATE UNIQUE INDEX IF NOT EXISTS verify_triage_runs_one_active_per_pattern
  ON verify_triage_runs (pattern_id)
  WHERE status IN ('PENDING', 'RUNNING');

-- "Latest triage for this pattern" is the status endpoint's only query shape.
CREATE INDEX IF NOT EXISTS idx_verify_triage_runs_pattern_started
  ON verify_triage_runs (pattern_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_verify_triage_runs_session_id
  ON verify_triage_runs (session_id);
