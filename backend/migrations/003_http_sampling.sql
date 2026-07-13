ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'SAMPLING';
ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'COMPLETE';

CREATE TABLE IF NOT EXISTS pattern_urls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pattern_id UUID NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pattern_urls_session_id
  ON pattern_urls(session_id);

CREATE INDEX IF NOT EXISTS idx_pattern_urls_pattern_id
  ON pattern_urls(pattern_id);

ALTER TYPE http_status_category RENAME TO http_status_category_old;

CREATE TYPE http_status_category AS ENUM (
  'success',
  'redirect',
  'failure'
);

ALTER TABLE sampled_urls
  ALTER COLUMN http_status_category TYPE http_status_category
  USING (
    CASE
      WHEN http_status_category IS NULL THEN NULL
      WHEN http_status_category::text = '2xx' THEN 'success'::http_status_category
      WHEN http_status_category::text IN ('301', '302') THEN 'redirect'::http_status_category
      ELSE 'failure'::http_status_category
    END
  );

DROP TYPE http_status_category_old;
