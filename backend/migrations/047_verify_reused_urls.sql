-- How many URLs a verify-urls run REUSED instead of re-probing (v1.64).
--
-- WHY. Verification is rate-limited to 5 requests/second per host — a deliberate
-- ceiling set after a confirmed AWS WAF captcha incident — so the HTTP phase is
-- essentially the whole cost of a run. Until now a re-verify repeated all of it,
-- including for URLs measured minutes earlier, which meant the second run of a
-- large pattern cost exactly as much as the first. Fix-then-recheck is the normal
-- workflow, so the run someone is actually waiting on was the one paying full
-- price to re-confirm what it already knew.
--
-- verifyUrlsJob now reuses a stored verdict when the row was checked AFTER the
-- session's files last changed AND inside VERIFY_REUSE_WINDOW_HOURS.
--
-- WHY THE COUNT NEEDS ITS OWN COLUMN. files_done starts at the number of URLs the
-- run does not have to check, so a mostly-reused run jumps straight to ~95% and
-- finishes in seconds. That is the correct progress — those URLs really are done
-- — but with no way to say WHY, it reads as a bar that skipped most of its work,
-- which is indistinguishable from a run that quietly failed to check anything.
-- The number is what turns that into "1,200,000 reused from the last check".
--
-- Deliberately NOT folded into files_done: that column answers "how far along",
-- and this one answers "how much was avoided". Migration 041 made the same call
-- for the enumeration counters, for the same reason — a third meaning on an
-- existing counter is how the reader ends up needing to know which phase a row is
-- in before knowing what its numbers mean.
--
-- Nullable with no default. NULL means a run from before reuse existed, which is
-- different from 0 ("reuse was possible and nothing qualified") — a job that
-- predates this column genuinely has no answer, and rendering it as "0 reused"
-- would be a claim nobody measured.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS urls_reused integer;

COMMENT ON COLUMN maintenance_jobs.urls_reused IS
  'For kind ''verify-urls'': URLs whose stored verdict was reused instead of re-probed, because they were checked after the session files last changed and inside VERIFY_REUSE_WINDOW_HOURS. NULL for runs predating reuse; 0 means reuse was available and nothing qualified.';
