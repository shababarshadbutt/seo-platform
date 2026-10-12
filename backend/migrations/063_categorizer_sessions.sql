-- Sitemap Categorization & Generation Tool: a standalone tool (separate from
-- Migration/Cleaner/sitemap-regenerate) that pulls every URL from a site's
-- existing sitemaps on SFTP or S3, status-checks EVERY one (not a sample),
-- buckets the survivors by path structure (regular/static-listing pages by
-- detected depth, 8 RFQ URL shapes, or uncategorized), and writes a fresh
-- capped-size sitemap set + sitemap-index.xml.
--
-- A SIBLING to `sessions`, not a reuse of it: that table's columns
-- (concurrency, staging_base_url, pattern/sampling fields) are shaped around
-- the Migration tool's domain and would be meaningless here, the same call
-- already made for cleaner_runs alongside sessions.
CREATE TABLE IF NOT EXISTS categorizer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  source_kind text NOT NULL,
  source_domain text NOT NULL,
  user_agent text NOT NULL,
  status text NOT NULL DEFAULT 'CREATED',
  max_urls_per_file integer NOT NULL DEFAULT 45000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  error text,
  CONSTRAINT categorizer_sessions_source_kind_known
    CHECK (source_kind IN ('s3', 'sftp')),
  CONSTRAINT categorizer_sessions_status_known
    CHECK (status IN (
      'CREATED', 'INGESTING', 'INGESTED',
      'CHECKING_STATUS', 'STATUS_CHECKED',
      'CATEGORIZING', 'CATEGORIZED',
      'GENERATING', 'COMPLETE', 'FAILED', 'CANCELLED'
    ))
);

-- The durable per-URL record this whole tool is built around. ONE ROW PER URL
-- in Postgres, at a scale (tens of millions) nothing else in this codebase
-- reaches in a single table — but the same MECHANISM as verified_urls (038),
-- not a new one: row capacity isn't the bottleneck here, crawl throughput is.
--
-- PARTITIONED BY HASH(session_id) into a fixed 16 partitions so autovacuum and
-- index maintenance work on a sixteenth of the table at a time instead of one
-- monolithic relation. Every query below is already scoped by session_id, so
-- this is a maintenance decision, not a query-routing one.
--
-- Append-mostly: three phases touch each row (ingest writes it, status-check
-- fills http_status, categorize fills rule_matched/output_file), and each
-- write must stay cheap at this row count.
CREATE TABLE IF NOT EXISTS categorizer_urls (
  id bigserial,
  session_id uuid NOT NULL REFERENCES categorizer_sessions(id) ON DELETE CASCADE,
  url text NOT NULL,
  -- Display filename the <loc> came from, for operator-facing context only.
  source_file text,
  -- Status-check phase.
  check_state text NOT NULL DEFAULT 'pending',
  http_status integer,
  checked_at timestamptz,
  -- Categorization phase. rule_matched records WHICH rule decided the
  -- bucket ('regular', 'rfq-1' .. 'rfq-8', 'uncategorized') for diagnostics;
  -- category is the UN-CHUNKED base name (e.g. "aviation-components", "main",
  -- "safety-rfq") the generate phase groups and chunks by; output_file is the
  -- actual final chunk filename a URL ended up in (e.g.
  -- "aviation-components-2.xml"), set at generate time so a resumed generate
  -- phase can skip rows it already wrote.
  category_state text NOT NULL DEFAULT 'pending',
  rule_matched text,
  category text,
  output_file text,
  PRIMARY KEY (session_id, id),
  CONSTRAINT categorizer_urls_check_state_known
    CHECK (check_state IN ('pending', 'checking', 'checked', 'skipped')),
  CONSTRAINT categorizer_urls_category_state_known
    CHECK (category_state IN ('pending', 'categorized'))
) PARTITION BY HASH (session_id);

DO $$
BEGIN
  FOR i IN 0..15 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS categorizer_urls_p%1$s PARTITION OF categorizer_urls FOR VALUES WITH (MODULUS 16, REMAINDER %1$s)',
      i
    );
  END LOOP;
END $$;

-- Ingestion dedup: ON CONFLICT DO NOTHING is what makes a crash-and-retry of
-- the ingest phase idempotent (see categorizerIngestJob.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_categorizer_urls_session_url
  ON categorizer_urls (session_id, url);

-- Keyset-pagination source for the status-check crawler: "give me the next
-- batch of pending rows after cursor N".
CREATE INDEX IF NOT EXISTS idx_categorizer_urls_session_check_state
  ON categorizer_urls (session_id, id)
  WHERE check_state <> 'checked';

-- The 404 list (download + exclusion-from-categorize queries).
CREATE INDEX IF NOT EXISTS idx_categorizer_urls_session_http_status
  ON categorizer_urls (session_id, http_status);

-- Keyset-pagination source for the categorize phase.
CREATE INDEX IF NOT EXISTS idx_categorizer_urls_session_category_state
  ON categorizer_urls (session_id, id)
  WHERE category_state = 'pending';

-- Generate phase: group a session's categorized URLs by category to chunk
-- and write each one, and find rows still needing a final output_file.
CREATE INDEX IF NOT EXISTS idx_categorizer_urls_session_category
  ON categorizer_urls (session_id, category, id);

CREATE INDEX IF NOT EXISTS idx_categorizer_urls_session_output_file
  ON categorizer_urls (session_id, output_file);
