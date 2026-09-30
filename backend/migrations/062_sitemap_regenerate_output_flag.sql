-- Marks a sitemap_files row as this wizard's OWN generated chunk output
-- (written by sitemapChunkFiles.ts:writeSitemapChunks), as opposed to a
-- 'current' file this session pulled for real from S3/SFTP during Step 1.
--
-- Why: sitemapRegenerateJob.ts soft-deletes every one of a session's existing
-- 'current' files before writing the new CSV-derived chunks, so a re-run
-- supersedes its OWN previous chunk output instead of piling up duplicates.
-- Before this column existed, both kinds of row looked identical
-- (source_role = 'current', is_index = FALSE), so that soft-delete could not
-- tell "this wizard's own prior output" apart from "every other sitemap file
-- this site actually has" — it deleted both, and the regenerated publish
-- index (built from exactly what is_deleted = false) then contained ONLY the
-- CSV's chunk files, de-indexing every other live sitemap sub-file the site
-- served (e.g. hundreds of per-manufacturer files) even though the CSV only
-- ever covered one segment of the site.
ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS is_regenerate_output BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sitemap_files.is_regenerate_output IS
  'TRUE for a chunk file written by the sitemap-regenerate wizard itself (writeSitemapChunks); FALSE for a file this session actually pulled from S3/SFTP. Only TRUE rows are candidates for the wizard''s own re-run supersede logic.';
