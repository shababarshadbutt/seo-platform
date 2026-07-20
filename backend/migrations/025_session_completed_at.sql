-- Records when a session finished analysis. Used by GET /api/sessions/:id to
-- decide whether a not-yet-ready download ZIP is still being generated in the
-- background (recently completed) versus one that failed or predates the ZIP
-- cache (in which case the UI falls back to on-demand streaming). Backfilled
-- from created_at so existing completed sessions get a sensible timestamp.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE sessions
  SET completed_at = created_at
  WHERE completed_at IS NULL
    AND status IN ('COMPLETE', 'COMPLETED');
