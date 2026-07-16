-- URL-level deletion: remove individual problem URLs (redirects / 404s) from
-- the sitemap XML on disk while keeping the sampled_urls row for audit/undo.
--
-- Model (see backend/src/sitemaps/urlDeletion.ts): each affected file is
-- rebuilt FROM its true pre-deletion original every time the deleted-set for
-- that file changes, so deletions and per-URL restores compose cleanly (no
-- one-level-undo limit). sitemap_files.url_deletion_original_path pins that
-- original stored filename; NULL means the file currently has no deletions and
-- its filename IS the original.
ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS is_deleted_from_sitemap boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_from_files text[];

ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS url_deletion_original_path text;

CREATE INDEX IF NOT EXISTS idx_sampled_urls_is_deleted_from_sitemap
  ON sampled_urls (is_deleted_from_sitemap);

-- Trailing-slash fix (Fix Trailing Slashes). Undo mirrors bulk replace: the
-- rewritten file is repointed to a fresh copy and trailing_slash_original_path
-- pins the pre-fix stored filename as the restore point (NULL = no fix applied).
-- The *_fixed flags mark exactly the DB rows the forward pass changed so undo
-- reverses only those (add-slash / strip-slash is otherwise not bijective).
ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS trailing_slash_original_path text;

ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS trailing_slash_fixed boolean NOT NULL DEFAULT false;

ALTER TABLE pattern_urls
  ADD COLUMN IF NOT EXISTS trailing_slash_fixed boolean NOT NULL DEFAULT false;

ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS trailing_slash_fixed boolean NOT NULL DEFAULT false;

-- One row per background maintenance operation (top-level "Delete URLs" job,
-- its restore, and the "Fix Trailing Slashes" apply/undo). Drives the shared
-- progress/status endpoints (files_done / files_total / items_changed). kind
-- distinguishes the operation; item_noun is a display label for the counter.
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  files_total integer NOT NULL DEFAULT 0,
  files_done integer NOT NULL DEFAULT 0,
  items_changed bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT maintenance_jobs_counts_nonnegative
    CHECK (files_total >= 0 AND files_done >= 0 AND items_changed >= 0)
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_session_started
  ON maintenance_jobs (session_id, kind, started_at DESC);
