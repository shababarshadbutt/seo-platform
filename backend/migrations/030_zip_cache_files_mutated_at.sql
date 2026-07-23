-- v1.42 ZIP-cache staleness fix. Records when a session's sitemap files were
-- last mutated after completion (any fix/delete/redirect/rename/etc.). The
-- pre-generate-zip job refuses to record a cache it built while this advanced,
-- and the download endpoint refuses to serve a cache older than this — so an
-- edit that lands while a pre-gen build is already in flight can no longer end
-- up as a stale cached ZIP. NULL = no post-completion mutation recorded.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS files_mutated_at timestamptz;
