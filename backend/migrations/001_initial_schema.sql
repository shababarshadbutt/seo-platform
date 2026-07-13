CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE session_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE pattern_status AS ENUM (
    'PENDING',
    'GOOD',
    'WARNING',
    'BAD'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE export_type AS ENUM (
    'csv',
    'xlsx',
    'pdf'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE http_status_category AS ENUM (
    '2xx',
    '301',
    '302',
    '404',
    '5xx',
    'timeout',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 10,
  concurrency INTEGER NOT NULL DEFAULT 10,
  status session_status NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sessions_sample_size_allowed CHECK (sample_size IN (5, 10, 20)),
  CONSTRAINT sessions_concurrency_range CHECK (concurrency >= 1 AND concurrency <= 30)
);

CREATE TABLE IF NOT EXISTS sitemap_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  total_urls BIGINT NOT NULL DEFAULT 0,
  parsed_at TIMESTAMPTZ,
  is_valid BOOLEAN NOT NULL DEFAULT TRUE,
  parse_error TEXT,
  parse_error_offset BIGINT,
  is_index BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT sitemap_files_total_urls_nonnegative CHECK (total_urls >= 0),
  CONSTRAINT sitemap_files_parse_error_offset_nonnegative CHECK (
    parse_error_offset IS NULL OR parse_error_offset >= 0
  )
);

CREATE TABLE IF NOT EXISTS patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  template TEXT NOT NULL,
  total_urls BIGINT NOT NULL DEFAULT 0,
  coverage_pct NUMERIC(7, 4) NOT NULL DEFAULT 0,
  confidence_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  status pattern_status NOT NULL DEFAULT 'PENDING',
  has_suspicious_segment BOOLEAN NOT NULL DEFAULT FALSE,
  suspicious_segment_value TEXT,
  redirect_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  CONSTRAINT patterns_total_urls_nonnegative CHECK (total_urls >= 0),
  CONSTRAINT patterns_coverage_pct_range CHECK (coverage_pct >= 0 AND coverage_pct <= 100),
  CONSTRAINT patterns_confidence_pct_range CHECK (confidence_pct >= 0 AND confidence_pct <= 100),
  CONSTRAINT patterns_redirect_pct_range CHECK (redirect_pct >= 0 AND redirect_pct <= 100),
  CONSTRAINT patterns_unique_template_per_session UNIQUE (session_id, template)
);

CREATE TABLE IF NOT EXISTS sampled_urls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id UUID NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  http_status INTEGER,
  response_ms INTEGER,
  is_hit BOOLEAN NOT NULL DEFAULT FALSE,
  checked_at TIMESTAMPTZ,
  final_url TEXT,
  redirect_count INTEGER NOT NULL DEFAULT 0,
  http_status_category http_status_category,
  CONSTRAINT sampled_urls_http_status_range CHECK (
    http_status IS NULL OR (http_status >= 100 AND http_status <= 599)
  ),
  CONSTRAINT sampled_urls_response_ms_nonnegative CHECK (
    response_ms IS NULL OR response_ms >= 0
  ),
  CONSTRAINT sampled_urls_redirect_count_nonnegative CHECK (redirect_count >= 0)
);

CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type export_type NOT NULL,
  file_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sitemap_files_session_id
  ON sitemap_files(session_id);

CREATE INDEX IF NOT EXISTS idx_sitemap_files_is_valid
  ON sitemap_files(is_valid);

CREATE INDEX IF NOT EXISTS idx_patterns_session_id
  ON patterns(session_id);

CREATE INDEX IF NOT EXISTS idx_patterns_status
  ON patterns(status);

CREATE INDEX IF NOT EXISTS idx_patterns_has_suspicious_segment
  ON patterns(has_suspicious_segment);

CREATE INDEX IF NOT EXISTS idx_sampled_urls_pattern_id
  ON sampled_urls(pattern_id);

CREATE INDEX IF NOT EXISTS idx_sampled_urls_http_status_category
  ON sampled_urls(http_status_category);

CREATE INDEX IF NOT EXISTS idx_exports_session_id
  ON exports(session_id);

CREATE INDEX IF NOT EXISTS idx_exports_type
  ON exports(type);

