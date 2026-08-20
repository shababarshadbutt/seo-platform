-- Structure-scoped verification (v1.66).
--
-- WHY. The Fix Redirect URLs modal gained the same "Limit this edit to" control
-- the Update Pattern modal has: pick one of the pattern's detected
-- sub-structures (nsn-parts-{var}, part-types-{var}, …) and every action in the
-- dialog narrows to it. Verification is one of those actions, and the cheapest
-- one to get wrong in the user's favour or against it: a pattern with 28,413
-- URLs across two structures should probe 613, not all of them.
--
-- Scoping the job alone is not enough, for exactly the reason 040 spells out
-- about pattern_ids: THE SCOPE HAS TO BE RECORDED, or the route's
-- attach-to-in-flight query cannot tell two different runs apart. Without this
-- column a request to verify nsn-parts-{var} would attach to a running
-- whole-pattern verification of the same pattern id — same session, same
-- pattern_ids, so the existing predicate matches — and report that run's
-- 28,413-URL progress as if it were the 613-URL one. Worse, the caller would
-- then treat a whole-pattern verdict set as the scoped one.
--
-- Stored as the RESOLVED filter list (path-segment indexes, not {param}
-- ordinals), which is the same shape the job payload and every worker spec
-- carry, so comparing "same scope?" is a plain jsonb equality on normalised
-- data rather than a template-parsing exercise in SQL.
--
-- NULL = whole pattern (or whole session), which is exactly the pre-v1.66
-- behaviour, so every existing row and every unscoped run is unchanged.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS structure_filters jsonb;

COMMENT ON COLUMN maintenance_jobs.structure_filters IS
  'For kind ''verify-urls'': resolved structure filters (segmentIndex/anchor/value) this run is limited to, ANDed. NULL = the whole pattern, no structure scope.';
