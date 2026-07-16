-- Track redirect-fix rewrites of source XML files so "apply-redirects" can be
-- undone at the file level, mirroring how pattern renames rewrite files on disk.
--
-- When apply-redirects rewrites a sitemap file, sitemap_files.filename is
-- repointed to a freshly written "<session>-fixed-<hex>-<name>" copy and
-- fixed_file_path records the *pre-fix original* stored filename, which is kept
-- on disk as the restore point. NULL means the file has no applied redirect
-- fixes (its current filename IS the original). The original is preserved across
-- chained applies so "Undo last replace" restores the true, unmodified file.
ALTER TABLE sitemap_files
  ADD COLUMN IF NOT EXISTS fixed_file_path text;
