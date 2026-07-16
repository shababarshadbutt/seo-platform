ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS source_role TEXT NOT NULL DEFAULT 'current';

DO $$
BEGIN
  ALTER TABLE sitemap_files
    ADD CONSTRAINT sitemap_files_source_role_allowed
    CHECK (source_role IN ('current', 'legacy')) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE sitemap_files
  VALIDATE CONSTRAINT sitemap_files_source_role_allowed;

ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS source_role TEXT NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS missing_in_current BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  ALTER TABLE patterns
    ADD CONSTRAINT patterns_source_role_allowed
    CHECK (source_role IN ('current', 'legacy')) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE patterns
  VALIDATE CONSTRAINT patterns_source_role_allowed;

ALTER TABLE patterns
  DROP CONSTRAINT IF EXISTS patterns_unique_template_per_session;

ALTER TABLE patterns
  DROP CONSTRAINT IF EXISTS patterns_unique_template_per_session_role;

ALTER TABLE patterns
  ADD CONSTRAINT patterns_unique_template_per_session_role
  UNIQUE (session_id, source_role, template);

CREATE TABLE IF NOT EXISTS sitemap_partial_urls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sitemap_file_id UUID NOT NULL REFERENCES sitemap_files(id) ON DELETE CASCADE,
  loc_order INTEGER NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sitemap_partial_urls_loc_order_nonnegative CHECK (loc_order >= 0),
  CONSTRAINT sitemap_partial_urls_unique_order UNIQUE (sitemap_file_id, loc_order)
);

CREATE INDEX IF NOT EXISTS idx_sitemap_files_source_role
  ON sitemap_files(source_role);

CREATE INDEX IF NOT EXISTS idx_patterns_source_role
  ON patterns(source_role);

CREATE INDEX IF NOT EXISTS idx_patterns_missing_in_current
  ON patterns(missing_in_current);

CREATE INDEX IF NOT EXISTS idx_sitemap_partial_urls_file_id
  ON sitemap_partial_urls(sitemap_file_id);
