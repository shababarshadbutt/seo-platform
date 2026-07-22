-- v1.36 — two independent concerns share this one migration (one version prefix
-- = one schema_migrations row, so they must live in the same file).

-- ── Fix 1: pattern-drawer sample lookups ─────────────────────────────────────
-- The pattern drawer loads a pattern's sampled URLs via
--   GET /api/sessions/:id/patterns/:patternId/samples
-- which runs `SELECT ... FROM sampled_urls WHERE pattern_id = $1`. That lookup
-- is already backed by idx_sampled_urls_pattern_id (created in 001), and
-- sitemap_files(session_id) already has idx_sitemap_files_session_id (also 001).
-- Both statements below are therefore no-ops on an up-to-date DB; they are kept
-- (IF NOT EXISTS) so a database that predates those indexes still gets them.
--
-- NOTE: the v1.36 spec also asked for indexes on sampled_urls(session_id) and
-- sampled_urls(session_id, pattern_id). The sampled_urls table has NO session_id
-- column (session is reached via patterns.session_id), so those indexes are
-- intentionally omitted — creating them would abort this migration. The stuck
-- "Loading URL details" spinner is fixed on the frontend (15s AbortController
-- timeout + error/retry), not by an index the query already had.
CREATE INDEX IF NOT EXISTS idx_sampled_urls_pattern_id
  ON sampled_urls (pattern_id);

CREATE INDEX IF NOT EXISTS idx_sitemap_files_session_id
  ON sitemap_files (session_id);

-- ── Fix 2: resumable session processing (checkpoint recovery) ────────────────
-- Track per-file progress through the extract and sample phases so a session
-- that FAILED partway can re-queue only the work that did not finish instead of
-- starting over. Parse already has a checkpoint (sitemap_files.parsed_at IS NOT
-- NULL), so no parse_status column is added — resume keys the parse phase off
-- parsed_at, matching the rest of the pipeline.
ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS extract_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS sample_status text NOT NULL DEFAULT 'pending';

-- resume_count powers the "Session was resumed N times" note on the results
-- page; last_failed_at records when the most recent failure occurred.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS resume_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;

-- Backfill: sessions that already COMPLETEd before this migration have finished
-- every phase, so mark their parsed, non-index files done. This keeps the resume
-- checkpoint math correct if such a session is ever re-opened, and stops a
-- (hypothetical) resume of a legacy session from needlessly re-running phases.
UPDATE sitemap_files
SET extract_status = 'done',
    sample_status = 'done'
WHERE parsed_at IS NOT NULL
  AND is_index = FALSE
  AND session_id IN (
    SELECT id FROM sessions WHERE status IN ('COMPLETE', 'COMPLETED')
  );
