-- Scoped pattern edits (v1.49): a rename/transform may be constrained to ONE
-- detected URL structure inside the pattern (e.g. only the niin-parts-{n}
-- family of /nsn/{param}), carried as a structure filter
-- { param_index, anchor: prefix|suffix, value } in pattern_structure_jobs.params.
--
-- pattern_renames needs the filter PERSISTED because undo replays the rename in
-- reverse from this history row: a scoped rename leaves patterns.template
-- untouched (the pattern still contains its other structures), so the undo can
-- NOT derive the rename's target template from the pattern row — and it must
-- re-apply the same scope so the reverse rewrite cannot over-reach either.
-- NULL = the rename was unscoped (every pre-v1.49 row), preserving the existing
-- undo behaviour exactly.
ALTER TABLE pattern_renames
  ADD COLUMN IF NOT EXISTS structure_filter JSONB;
