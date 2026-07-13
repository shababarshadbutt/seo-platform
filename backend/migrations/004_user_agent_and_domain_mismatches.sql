ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_agent TEXT NOT NULL DEFAULT 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS mismatched_url_count BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT sitemap_files_mismatched_url_count_nonnegative CHECK (
    mismatched_url_count >= 0
  ) NOT VALID;

ALTER TABLE sitemap_files
  VALIDATE CONSTRAINT sitemap_files_mismatched_url_count_nonnegative;

CREATE TABLE IF NOT EXISTS mismatched_urls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sitemap_file_id UUID NOT NULL REFERENCES sitemap_files(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  detected_host TEXT NOT NULL,
  expected_host TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mismatched_urls_sitemap_file_id
  ON mismatched_urls(sitemap_file_id);
