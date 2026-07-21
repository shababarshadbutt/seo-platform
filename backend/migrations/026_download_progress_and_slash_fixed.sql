-- v1.31 columns.
--
-- zip_progress / zip_progress_file back the on-demand download progress overlay
-- (Fix 2). While a session's download ZIP is being assembled — either on demand
-- in the API process or by the background piscina worker — the builder writes
-- its progress here after each file is added, so the results page can poll
-- GET /api/sessions/:id and show a percentage bar + "Zipping file X of Y".
-- (The v1.31 spec assumed zip_progress already existed from v1.26; it never did,
-- so both columns are introduced here.)
--
-- trailing_slash_fixed_at records when a trailing-slash fix last completed for a
-- session (Fix 4). The results page uses it to warn before silently re-running
-- the fix on a session that already had slashes applied.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS zip_progress integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS zip_progress_file integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trailing_slash_fixed_at timestamptz;
