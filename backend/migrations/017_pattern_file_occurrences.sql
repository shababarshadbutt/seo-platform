-- Accurate per-source-file occurrence counts for each pattern.
-- Previously only a single "most common" source file was stored on
-- patterns.source_file and the rename modal estimated per-file counts by
-- redistributing the pattern's total across files (which could attribute more
-- than a single file's max URL count to one file, e.g. 125,936 > 50,000).
-- One row per pattern per contributing file. The sum of occurrence_count for a
-- pattern equals patterns.total_urls.
CREATE TABLE IF NOT EXISTS pattern_file_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  source_file text NOT NULL,
  occurrence_count bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pattern_file_occurrences_pattern_id
  ON pattern_file_occurrences (pattern_id);
