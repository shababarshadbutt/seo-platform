-- Pre-generated download ZIP cache. When a session completes (and after any
-- file-mutating operation) a background job builds both the "all" and "edited"
-- sitemap ZIPs to disk under EXPORT_DIR, so the download endpoint can serve a
-- ready file instantly instead of streaming a fresh archive (which took 30+ min
-- for 1000+ files). The paths are cleared (and regeneration re-enqueued)
-- whenever the underlying sitemap files change.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS zip_all_path text,
  ADD COLUMN IF NOT EXISTS zip_edited_path text,
  ADD COLUMN IF NOT EXISTS zip_generated_at timestamptz;
