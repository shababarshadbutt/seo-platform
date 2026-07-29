-- A durable record of every attempted S3 publish.
--
-- Why this exists: until now the ONLY trace a publish left was (a) a BullMQ job,
-- which is trimmed after 100 completions and vanishes entirely on a Redis flush,
-- and (b) two log lines. So the question "did a publish for this domain ever
-- actually run, and what did it write?" was unanswerable a day later — which is
-- exactly the question asked when production looks wrong. Now every attempt
-- writes a STARTED row before touching S3 and stamps it COMPLETE or FAILED, so
-- "no row" is real evidence that nothing was enqueued rather than an unknown.
--
-- Recorded per attempt rather than per session (no unique constraint on
-- session_id): republishing the same session is normal and each attempt's
-- outcome matters.
--
-- bucket and prefix are stored EXPLICITLY, not derived at read time. They come
-- from templates plus the session's base_url host, so today's config cannot be
-- used to reconstruct where last week's publish actually wrote. Storing the
-- resolved prefix is what makes a wrong-prefix publish (e.g. writing to
-- sites/www.example.com/sitemaps/ while production serves
-- sites/example.com/sitemaps/) visible after the fact.
CREATE TABLE IF NOT EXISTS publish_runs (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- The publish target host, verbatim: exactly what was interpolated into the
  -- key prefix. A www/non-www discrepancy is only detectable because this is
  -- the unnormalized value.
  domain TEXT NOT NULL,
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL,
  job_id TEXT,
  -- STARTED | COMPLETE | FAILED. A row stuck on STARTED means the worker died
  -- mid-publish, which is itself the answer to "why is production half updated".
  status TEXT NOT NULL,
  -- What the plan intended to upload vs. what actually got a successful PUT.
  -- planned > uploaded on a FAILED row bounds the partial overwrite.
  planned_file_count INTEGER NOT NULL DEFAULT 0,
  uploaded_count INTEGER NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  -- Files the session lists but whose bytes were gone from disk (uploads
  -- cleaned up an hour after completion). Non-zero means the publish refused.
  missing_local_count INTEGER NOT NULL DEFAULT 0,
  index_key TEXT,
  invalidation_id TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

-- "Was this domain ever published, and when last?" — the lookup this table is for.
CREATE INDEX IF NOT EXISTS publish_runs_domain_started_at_idx
  ON publish_runs (domain, started_at DESC);

CREATE INDEX IF NOT EXISTS publish_runs_session_started_at_idx
  ON publish_runs (session_id, started_at DESC);

COMMENT ON TABLE publish_runs IS
  'One row per attempted S3 publish, written before the first PUT and stamped on completion/failure. The only durable evidence that a publish ran and where it wrote; BullMQ job history is trimmed and cannot answer it.';
