-- History of cosmetic pattern-template renames (display only; does not change URLs).
-- Note: named 015 because 014 is already used (014_cancelled_status.sql).
CREATE TABLE IF NOT EXISTS pattern_renames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  old_template text NOT NULL,
  new_template text NOT NULL,
  source_files text[] NOT NULL,
  occurrence_count bigint NOT NULL,
  renamed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pattern_renames_pattern_id
  ON pattern_renames (pattern_id);
