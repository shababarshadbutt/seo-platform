-- Prevent duplicate sitemap file registration for the same session
-- ON CONFLICT DO NOTHING in the insert handles duplicates gracefully
ALTER TABLE sitemap_files
ADD CONSTRAINT sitemap_files_session_filename_unique
UNIQUE (session_id, filename);
