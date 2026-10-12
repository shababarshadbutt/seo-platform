-- Sampled, per-category status-check for the categorizer tool.
--
-- The pipeline reorders to ingest -> categorize -> check status -> generate
-- (see categorizerCategorizeJob.ts / categorizerStatusSampleJob.ts): categorize
-- only looks at URL path shape, not HTTP status, so it no longer needs to wait
-- behind a full per-URL crawl that is not viable at tens-of-millions-of-URLs
-- scale (the shared WAF-safe 5 req/s ceiling in config.ts's `verification`
-- block makes a full sweep take days-to-months on a large site).
--
-- Status-checking becomes a secondary, per-CATEGORY confidence pass
-- (categorizer_categories below) instead of a per-URL gate in front of
-- categorize, the same sample-score-act shape patterns.ts/patternScore.ts
-- already use for the Migration tool's patterns.

-- Generate already only reads "category_state = 'categorized'"
-- (categorizerGenerateJob.ts) and has no idea what http_status means, so a new
-- 'excluded' value is all that's needed to drop a confirmed-404 URL, or an
-- entire low-confidence category, out of every output file without touching
-- the generate query at all.
ALTER TABLE categorizer_urls
  DROP CONSTRAINT categorizer_urls_category_state_known;
ALTER TABLE categorizer_urls
  ADD CONSTRAINT categorizer_urls_category_state_known
  CHECK (category_state IN ('pending', 'categorized', 'excluded'));

-- SKIPPED is a session-level choice (the user explicitly skipped status
-- checking for this session) — distinct from COMPLETE so the UI can show an
-- honest "status wasn't checked" banner instead of a result that silently
-- looks clean. `mode` tells a sampled status-check job apart from the
-- existing full per-URL one without a new `phase` value, keeping
-- categorizer_jobs_one_active_per_phase and the phase CHECK untouched.
ALTER TABLE categorizer_jobs
  DROP CONSTRAINT categorizer_jobs_status_known;
ALTER TABLE categorizer_jobs
  ADD CONSTRAINT categorizer_jobs_status_known
  CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETE', 'FAILED', 'SKIPPED'));

ALTER TABLE categorizer_jobs
  ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE categorizer_jobs
  ADD CONSTRAINT categorizer_jobs_mode_known
  CHECK (mode IS NULL OR mode IN ('full', 'sampled'));

-- Per-category sampled-check outcome. "category" here is the same un-chunked
-- base name categorizer_urls.category holds, not a foreign key to a separate
-- table (there isn't one — see categorizerGenerateJob.ts's GROUP BY category).
-- PENDING/GOOD/WARNING/BAD mirrors patterns.status (patternScore.ts): PENDING
-- means "sampled but nothing measurable" (e.g. every sampled URL was WAF
-- blocked), never collapsed into BAD, so "never checked" and "checked but
-- unmeasurable" stay distinguishable.
CREATE TABLE IF NOT EXISTS categorizer_categories (
  session_id uuid NOT NULL REFERENCES categorizer_sessions(id) ON DELETE CASCADE,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  confidence_pct numeric,
  sample_size integer NOT NULL DEFAULT 0,
  checked_count integer NOT NULL DEFAULT 0,
  dead_count integer NOT NULL DEFAULT 0,
  blocked_count integer NOT NULL DEFAULT 0,
  sampled_at timestamptz,
  PRIMARY KEY (session_id, category),
  CONSTRAINT categorizer_categories_status_known
    CHECK (status IN ('PENDING', 'GOOD', 'WARNING', 'BAD'))
);
