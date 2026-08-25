-- HOW MUCH OF THE PATTERN DID THAT FIX ACTUALLY COVER? (v1.81)
--
-- WHAT WAS WRONG. 046 added redirects_applied_at, and both apply paths stamp it
-- whenever rewrittenLocCount > 0. That predicate was written to stop a
-- zero-change run from claiming a fix (v1.74) and it does — but it draws the
-- same full grey "Fixed" chip for an apply that rewrote every URL in the pattern
-- and for one that rewrote twelve of 579,034.
--
-- That is not a corner case. A <loc> is rewritten only when a confirmed
-- destination, an approved/derived rule, or an AGREED per-shape rule covers it
-- (buildRedirectApplyRewriter). On a pattern that mixes several URL families —
-- which is most of them once extraction parameterises a whole segment position —
-- deriveRedirectRule returns null for the pattern and most shape strata come back
-- unagreed, so reach collapses to the handful of URLs somebody actually fetched.
-- Both reported sessions were this: "it fixed one pattern and missed the rest",
-- and "it fixed some URLs and skipped their neighbours". In both, the rewrite
-- behaved correctly and only the report was wrong.
--
-- WHY THREE COLUMNS AND NOT A PERCENTAGE. A percentage cannot say which URLs, and
-- "which URLs" is the operator's actual question — they are looking at a sitemap
-- with the old paths still in it. So: what landed, what was left, and a bounded
-- histogram of the left-behind URL SHAPES with a real example each, keyed the same
-- way pattern_shape_rules is so a shape here can be traced to the stratum that
-- disagreed.
--
-- MEASURED, NOT DERIVED. redirects_skipped_locs is counted by applyCoverage during
-- the same streaming pass that does the rewrite — not computed against
-- patterns.total_urls, which is a weighted extrapolation from the first 500 locs
-- of each file AND describes the pre-fix files. Dividing a real count by that
-- estimate would invent a shortfall on a complete apply and hide one on an
-- incomplete apply, which is the failure this migration exists to end.
--
-- NULLABLE with no default, following 043, 045 and 046: rows that predate this
-- genuinely have no answer, and NULL reads as "not measured" — the UI then draws
-- exactly the chip it drew before, so nothing about an existing session changes.
ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS redirects_applied_locs BIGINT,
  ADD COLUMN IF NOT EXISTS redirects_skipped_locs BIGINT,
  ADD COLUMN IF NOT EXISTS redirects_skipped_shapes JSONB;

COMMENT ON COLUMN patterns.redirects_applied_locs IS
  '<loc> entries the last apply-redirects actually rewrote for this pattern. Measured on disk, not inferred. NULL for patterns fixed before this column existed.';

COMMENT ON COLUMN patterns.redirects_skipped_locs IS
  '<loc> entries matching this pattern that the last apply-redirects left unchanged, because no confirmed destination and no agreed rewrite rule covered them. Counted in the same pass as the rewrite. > 0 means the Fixed chip should read "Partly fixed".';

COMMENT ON COLUMN patterns.redirects_skipped_shapes IS
  'Bounded top-N histogram of the URL shapes left unchanged: [{shape, count, example}], biggest first, keyed on valueShape() so an entry can be looked up in pattern_shape_rules to see whether that stratum disagreed or was never probed. The example is a real URL because a normalised shape means nothing to a reviewer.';

-- REUSING maintenance_jobs.skipped FOR THE QUEUED APPLY (v1.81).
--
-- 036 introduced this column for the trailing-slash fix, described as "items the
-- job deliberately skipped (not failures)" — which is precisely what an
-- apply-redirects shortfall is: URLs the rewrite correctly declined to touch
-- because nothing measured covered them. Adding a second column for the same idea
-- would give the status endpoint two places to look, so the payload is
-- discriminated by the job's own `kind` instead.
COMMENT ON COLUMN maintenance_jobs.skipped IS
  'Items the job deliberately skipped (not failures). Trailing-slash: patterns whose target template was already taken. Apply-redirects (v1.81): {skipped_in_scope, by_shape:[{shape,count,example}], shapes_truncated} — the pattern URLs no confirmed destination or agreed rule reached.';

-- WHICH PATTERN IS THIS JOB FOR? (v1.81)
--
-- THE BUG. The apply-redirects route refuses to enqueue when it believes a run is
-- already in flight, and answers with that run's progress row so the client
-- follows the live job instead of a corpse. It decides "already running" from two
-- signals, and both are too loose:
--
--   * bullmq getJob('apply-redirects-<pattern>') !== null — but a COMPLETED job is
--     still there (the queue keeps the last 100), so this is true forever after
--     the first apply on a pattern;
--   * the newest maintenance_jobs row for the SESSION with status PENDING/RUNNING
--     — any pattern's, not this one's.
--
-- Together they say "already running" for pattern A merely because A was applied
-- once before and B happens to be running now. A is then never enqueued, and the
-- operator is handed B's row, watches it complete, and is told their fix
-- succeeded. Applying several patterns in a row — which is the normal way this
-- tool is used — is exactly the sequence that triggers it.
--
-- The route's state check is the primary fix (a finished job is not a running
-- one). This column closes the second half so the row lookup can be scoped to the
-- pattern that asked, rather than to whatever ran last in the session.
--
-- NULLABLE: session-wide jobs (delete-urls, trailing-slash, verification) have no
-- pattern and must keep inserting without one. Existing rows read as NULL, and a
-- NULL-scoped lookup simply finds nothing — which fails CLOSED, enqueuing a fresh
-- job rather than attaching to an unrelated one.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS pattern_id uuid REFERENCES patterns(id) ON DELETE CASCADE;

COMMENT ON COLUMN maintenance_jobs.pattern_id IS
  'The pattern a per-pattern job (apply-redirects) is for. NULL for session-wide jobs. Scopes the "is one already running?" lookup, which used to match any apply-redirects row in the session and could hand one pattern''s caller another pattern''s run.';

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_pattern_status
  ON maintenance_jobs (pattern_id, kind, status)
  WHERE pattern_id IS NOT NULL;
