-- Read-only full-population measurement of a structure transform, recorded on
-- the SAME job row as the operations it measures.
--
-- WHY IT BELONGS HERE rather than in a table of its own. The Update Pattern
-- preview is computed from `pattern_urls`, a reservoir sample capped at ~1,000
-- rows per pattern (PATTERN_URL_POOL_MIN_SIZE), while a pattern can hold
-- millions of URLs. So the preview can be right about everything it saw and
-- still be wrong about the population — a split position that suits "part-720"
-- produces "part-7-20000" for a value the sample never contained. The dry run
-- reads every file and reports what the transform WOULD produce.
--
-- Reusing pattern_structure_jobs gets it three things for free, each of which
-- would otherwise be reimplemented:
--   * progress — files_total / files_done already drive the modal's bar;
--   * retry-after-timeout — request_fingerprint already makes a repeated
--     request recognisable as the same one;
--   * mutual exclusion — the partial unique index in 037 already allows only
--     one in-flight job per pattern, which is exactly right here: applying
--     while a dry run is still measuring, or measuring while an apply is
--     rewriting, are both incoherent.
--
-- Nothing else changes. The scan opens no transaction and writes no files; its
-- output lands in the existing `result` jsonb column.
ALTER TABLE pattern_structure_jobs
  DROP CONSTRAINT IF EXISTS pattern_structure_jobs_kind_known;

ALTER TABLE pattern_structure_jobs
  ADD CONSTRAINT pattern_structure_jobs_kind_known
  CHECK (kind IN (
    'RENAME',
    'TRANSFORM',
    'TRANSFORM_UNDO',
    'TRANSFORM_DRY_RUN'
  ));
