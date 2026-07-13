-- Track which XML file(s) on disk were rewritten by a pattern rename so the
-- corrected sitemap can be downloaded and an undo can revert the file. Stores a
-- comma-separated list of the stored filenames produced by the rename.
ALTER TABLE pattern_renames
  ADD COLUMN IF NOT EXISTS renamed_file_path text;
