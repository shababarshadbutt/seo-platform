-- The Lastmod Updater: rewrite <lastmod> on selected sitemap files/URLs, then
-- publish, as a BACKGROUND job.
--
-- Same shape of fix as pattern_structure_jobs (037): the scope (all files / a
-- selection / a set of patterns) can span every file in a session, which is the
-- same "may take minutes, cannot run inside one HTTP request" problem rename and
-- transform already solved. Keyed by session_id rather than pattern_id, since a
-- "whole session" or "selected files" scope has no single pattern to hang off.
CREATE TABLE IF NOT EXISTS lastmod_update_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING',
  -- Stable hash of the operation's inputs (scope + target date), so a client
  -- retry after a timeout attaches to the in-flight/just-finished job instead of
  -- re-rewriting the same files and re-publishing. Same mechanism as
  -- pattern_structure_jobs.request_fingerprint (canonicalFingerprint()).
  request_fingerprint text NOT NULL,
  -- The full validated request: {scope: {type, filenames?/pattern_ids?}, target_date}.
  params jsonb NOT NULL,
  files_total integer NOT NULL DEFAULT 0,
  files_done integer NOT NULL DEFAULT 0,
  urls_rewritten bigint NOT NULL DEFAULT 0,
  -- The response body a poller (or a retry that arrives after completion) reads.
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT lastmod_update_jobs_status_known
    CHECK (status IN ('PENDING', 'RUNNING', 'PUBLISHING', 'COMPLETE', 'FAILED')),
  CONSTRAINT lastmod_update_jobs_counts_nonnegative
    CHECK (files_total >= 0 AND files_done >= 0 AND urls_rewritten >= 0)
);

-- AT MOST ONE in-flight job per session — two overlapping runs would race the
-- same copy-on-write file swaps and could publish a half-updated set.
CREATE UNIQUE INDEX IF NOT EXISTS lastmod_update_jobs_one_active_per_session
  ON lastmod_update_jobs (session_id)
  WHERE status IN ('PENDING', 'RUNNING', 'PUBLISHING');

CREATE INDEX IF NOT EXISTS idx_lastmod_update_jobs_session_started
  ON lastmod_update_jobs (session_id, started_at DESC);

-- Retry-after-timeout lookup: most recent COMPLETE job matching a fingerprint.
CREATE INDEX IF NOT EXISTS idx_lastmod_update_jobs_fingerprint
  ON lastmod_update_jobs (session_id, request_fingerprint, started_at DESC);
