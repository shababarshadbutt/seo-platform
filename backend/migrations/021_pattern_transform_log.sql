-- Pattern-scoped URL structure transformation (per-segment rewrite of {param}
-- values, e.g. stripping "-parts-catalog" and adding a trailing slash).
--
-- Unlike a rename/bulk-replace (whose param values move unchanged, so undo is a
-- bijective reverse-rewrite), a transform can be LOSSY (strip / upper / lower).
-- Undo therefore restores from stored originals rather than reverse-transforming:
--   * files          — the pre-transform stored copy is kept on disk and its
--                       filename recorded in original_file_paths (the current
--                       repointed copy is in new_file_paths); undo repoints
--                       sitemap_files.filename back and deletes the new copy.
--   * pattern_urls   — original_path holds the pre-transform path (NULL = not
--                       transformed / already undone).
--   * sampled_urls   — pre_transform_url holds the pre-transform url. Kept
--                       separate from original_url (used by find/replace undo,
--                       migration 013) so the two undo systems never clobber
--                       each other.
CREATE TABLE IF NOT EXISTS pattern_transforms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  old_template text NOT NULL,
  new_template text NOT NULL,
  current_structure text NOT NULL,
  new_structure text NOT NULL,
  source_files text[] NOT NULL,
  urls_transformed bigint NOT NULL DEFAULT 0,
  files_rewritten integer NOT NULL DEFAULT 0,
  -- Parallel arrays (same index = same file): the pre-transform stored filename
  -- and the repointed post-transform stored filename. Drive file-level undo.
  original_file_paths text[] NOT NULL DEFAULT '{}',
  new_file_paths text[] NOT NULL DEFAULT '{}',
  transformed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pattern_transforms_pattern_id
  ON pattern_transforms (pattern_id);

-- Per-row pre-transform snapshots for lossy-safe undo of the bounded DB samples.
ALTER TABLE pattern_urls
  ADD COLUMN IF NOT EXISTS original_path text;

ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS pre_transform_url text;
