-- Durable, resumable phase/progress tracker for the categorizer tool.
--
-- Deliberately a DB row, not BullMQ's job.updateProgress(): a status-check run
-- can take hours to days (see categorizerStatusCheckJob.ts), which outlives
-- any single BullMQ job attempt and must survive a worker restart. Resumability
-- is a KEYSET CURSOR in `checkpoint`, not a re-scan: "read checkpoint.last_id,
-- WHERE id > last_id ORDER BY id, continue" for the status-check/categorize
-- phases, a list of completed filenames for ingest, and {category, chunk} for
-- generate.
--
-- One row per (session, phase); phases do not share a row because they have
-- independent checkpoints and can be resumed/retried independently.
CREATE TABLE IF NOT EXISTS categorizer_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES categorizer_sessions(id) ON DELETE CASCADE,
  phase text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
  items_total bigint NOT NULL DEFAULT 0,
  items_done bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error text,
  CONSTRAINT categorizer_jobs_phase_known
    CHECK (phase IN ('ingest', 'status-check', 'categorize', 'generate')),
  CONSTRAINT categorizer_jobs_status_known
    CHECK (status IN ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETE', 'FAILED')),
  CONSTRAINT categorizer_jobs_counts_nonnegative
    CHECK (items_total >= 0 AND items_done >= 0)
);

-- At most one active row per (session, phase) — two overlapping runs of the
-- same phase would race each other's checkpoint and could double-write output.
CREATE UNIQUE INDEX IF NOT EXISTS categorizer_jobs_one_active_per_phase
  ON categorizer_jobs (session_id, phase)
  WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_categorizer_jobs_session
  ON categorizer_jobs (session_id, started_at DESC);

-- Per-category output bookkeeping — the output-side sibling of sitemap_files,
-- kept separate because that table's ingestion-lifecycle columns (is_index,
-- parse_error, etc.) don't apply to pure generated output here.
CREATE TABLE IF NOT EXISTS categorizer_output_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES categorizer_sessions(id) ON DELETE CASCADE,
  category text NOT NULL,
  -- 1-based; chunk 1 renders as "{category}.xml", chunk 2+ as "{category}-N.xml".
  chunk_index integer NOT NULL,
  filename text NOT NULL,
  url_count integer NOT NULL DEFAULT 0,
  stored_path text,
  written_at timestamptz,
  CONSTRAINT categorizer_output_files_chunk_index_positive
    CHECK (chunk_index >= 1),
  UNIQUE (session_id, category, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_categorizer_output_files_session
  ON categorizer_output_files (session_id);
