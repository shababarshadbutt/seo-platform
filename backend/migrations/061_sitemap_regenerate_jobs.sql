-- The CSV-driven sitemap regeneration wizard: given a CSV list of URLs for a
-- site already pulled from S3, derive patterns, let the user decide per
-- pattern whether to keep URLs as-is or rewrite them, chunk the final URL set
-- into <=50,000-URL files under a user-chosen filename template, and publish
-- as a BACKGROUND job. Same shape as lastmod_update_jobs (060): the work can
-- span the whole site and take minutes, so a client retry after a timeout
-- must attach to the same job rather than regenerate and republish.
CREATE TABLE IF NOT EXISTS sitemap_regenerate_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING',
  -- Stable hash of the operation's inputs (csv file + pattern decisions +
  -- filename template + lastmod policy), so a client retry after a timeout
  -- attaches to the in-flight/just-finished job. Same mechanism as
  -- lastmod_update_jobs.request_fingerprint (canonicalFingerprint()).
  request_fingerprint text NOT NULL,
  -- The full validated request: {csv_sitemap_file_id, pattern_decisions:
  -- [{pattern_id, mode, current_structure?, new_structure?}],
  -- filename_template, lastmod_policy}.
  params jsonb NOT NULL,
  urls_total integer NOT NULL DEFAULT 0,
  urls_written bigint NOT NULL DEFAULT 0,
  files_total integer NOT NULL DEFAULT 0,
  files_done integer NOT NULL DEFAULT 0,
  -- The response body a poller (or a retry that arrives after completion) reads.
  result jsonb,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT sitemap_regenerate_jobs_status_known
    CHECK (status IN ('PENDING', 'RUNNING', 'PUBLISHING', 'COMPLETE', 'FAILED')),
  CONSTRAINT sitemap_regenerate_jobs_counts_nonnegative
    CHECK (
      urls_total >= 0 AND urls_written >= 0 AND
      files_total >= 0 AND files_done >= 0
    )
);

-- AT MOST ONE in-flight job per session — two overlapping runs would race the
-- same file generation and could publish a half-written set.
CREATE UNIQUE INDEX IF NOT EXISTS sitemap_regenerate_jobs_one_active_per_session
  ON sitemap_regenerate_jobs (session_id)
  WHERE status IN ('PENDING', 'RUNNING', 'PUBLISHING');

CREATE INDEX IF NOT EXISTS idx_sitemap_regenerate_jobs_session_started
  ON sitemap_regenerate_jobs (session_id, started_at DESC);

-- Retry-after-timeout lookup: most recent COMPLETE job matching a fingerprint.
CREATE INDEX IF NOT EXISTS idx_sitemap_regenerate_jobs_fingerprint
  ON sitemap_regenerate_jobs (session_id, request_fingerprint, started_at DESC);
