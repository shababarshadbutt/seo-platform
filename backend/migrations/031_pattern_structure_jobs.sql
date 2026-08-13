-- Pattern rename / structure-transform / transform-undo become background jobs.
--
-- These three operations used to run synchronously inside the HTTP request,
-- rewriting every selected XML file one at a time while a transaction stayed
-- open. On a 491-file / 4.2M-URL pattern that ran far past the frontend's 180s
-- abort, so the user saw "Request timed out" while the server kept working and
-- committed afterwards — and a retry could then apply a compounding transform a
-- second time. They now insert a maintenance_jobs row, enqueue, and return 202.
--
-- maintenance_jobs is EXTENDED rather than forked into a new table so the one
-- status/polling shape already used by delete-problem-urls, restore-deleted-urls
-- and fix-trailing-slashes serves these too. All columns are nullable or
-- defaulted, so existing rows and the existing kinds are unaffected.
ALTER TABLE maintenance_jobs
  -- Which pattern this job belongs to. NULL for the pre-existing session-level
  -- kinds, which have no pattern scope.
  ADD COLUMN IF NOT EXISTS pattern_id uuid
    REFERENCES patterns(id) ON DELETE CASCADE,
  -- The job's input, so the worker can run without re-deriving scope from live
  -- DB state (which would silently widen the edit if files changed between
  -- enqueue and execution). Never SELECTed by the 2s status poll.
  ADD COLUMN IF NOT EXISTS payload jsonb,
  -- The job's outcome, so the UI can build the same success summary the old
  -- synchronous response used to return (old/new template, sample before/after).
  ADD COLUMN IF NOT EXISTS result jsonb,
  -- Files deliberately not rewritten (missing on disk, no URLs matched, remote
  -- source). Previously these were dropped by a bare `catch { continue }` and
  -- the user was told the run succeeded.
  ADD COLUMN IF NOT EXISTS files_skipped integer NOT NULL DEFAULT 0,
  -- [{ file, reason }] detail behind files_skipped, plus any non-fatal anomaly
  -- worth surfacing (e.g. a source_url that could not be reparsed).
  ADD COLUMN IF NOT EXISTS warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE maintenance_jobs
  DROP CONSTRAINT IF EXISTS maintenance_jobs_files_skipped_nonnegative;

ALTER TABLE maintenance_jobs
  ADD CONSTRAINT maintenance_jobs_files_skipped_nonnegative
    CHECK (files_skipped >= 0);

-- Drives "is there a job in flight for this pattern?" (the 409 guard) and the
-- per-pattern status endpoint the modal polls.
CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_pattern
  ON maintenance_jobs (pattern_id, started_at DESC);
