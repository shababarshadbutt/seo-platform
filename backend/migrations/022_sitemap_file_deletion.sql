-- Sitemap file deletion + Google Search Console deletion tracking (v1.18).
-- Deletions are soft: the DB row is kept for the audit trail and the on-disk
-- file is left in place (marked for cleanup), so a delete can be undone.

ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gsc_deletion_status TEXT,
  ADD COLUMN IF NOT EXISTS gsc_deletion_error TEXT;

ALTER TABLE sitemap_files
  DROP CONSTRAINT IF EXISTS sitemap_files_gsc_deletion_status_allowed;

ALTER TABLE sitemap_files
  ADD CONSTRAINT sitemap_files_gsc_deletion_status_allowed
  CHECK (
    gsc_deletion_status IS NULL
    OR gsc_deletion_status IN ('submitted', 'failed', 'skipped')
  ) NOT VALID;

ALTER TABLE sitemap_files
  VALIDATE CONSTRAINT sitemap_files_gsc_deletion_status_allowed;

CREATE INDEX IF NOT EXISTS idx_sitemap_files_is_deleted
  ON sitemap_files(is_deleted);

-- Per-session Google Search Console credentials. The service-account JSON is
-- encrypted at rest (AES-256-GCM, keyed by the ENCRYPTION_KEY env var); only
-- the encrypted blob is stored here.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS gsc_property_url TEXT,
  ADD COLUMN IF NOT EXISTS gsc_credentials_encrypted TEXT;
