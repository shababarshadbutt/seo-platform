-- Bulk pattern-aware find & replace across all sitemap files in a session.
--
-- File-level undo mirrors the redirect-fix model (see 019): when a bulk replace
-- rewrites a sitemap file, sitemap_files.filename is repointed to a freshly
-- written "<session>-bulk-<hex>-<name>" copy and bulk_replace_original_path
-- records the *pre-replace* stored filename, kept on disk as the restore point.
-- NULL means the file has no applied bulk replace (its current filename IS the
-- original).
ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS bulk_replace_original_path text;

-- One row per bulk-replace operation on a session. Drives the progress/status
-- endpoint (files_done / files_total / urls_rewritten) and records the from/to
-- templates so undo can revert patterns.template and sampled_urls.url.
CREATE TABLE IF NOT EXISTS bulk_replace_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_pattern text NOT NULL,
  to_pattern text NOT NULL,
  files_total integer NOT NULL DEFAULT 0,
  files_done integer NOT NULL DEFAULT 0,
  urls_rewritten bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT bulk_replace_jobs_files_nonnegative
    CHECK (files_total >= 0 AND files_done >= 0 AND urls_rewritten >= 0)
);

CREATE INDEX IF NOT EXISTS idx_bulk_replace_jobs_session_id
  ON bulk_replace_jobs (session_id);

-- Latest job per session is looked up by started_at; index the common ordering.
CREATE INDEX IF NOT EXISTS idx_bulk_replace_jobs_session_started
  ON bulk_replace_jobs (session_id, started_at DESC);
