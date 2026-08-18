-- WHEN a pattern's redirect fixes were applied (v1.64).
--
-- WHY PERSIST IT. The results table's Fix button is drawn from the pattern's
-- STATUS alone (frontend/lib/fix-visibility.ts): amber "Fix" while the row is
-- Broken or Warning, and nothing at all once it is Healthy. So the reward for
-- successfully fixing a pattern was the button silently disappearing, which is
-- indistinguishable from a pattern that never needed fixing in the first place.
-- Reviewers working down a long table had no way to see what they had already
-- dealt with, and re-opened patterns to find out.
--
-- The missing fact is not derivable from anything already stored. After a
-- successful apply the sampled rows are rewritten in place — url becomes
-- final_url and http_status_category becomes 'success' (see applyRedirectsJob)
-- — so a fixed pattern ends up looking exactly like one that was always
-- healthy. original_url survives on the sampled rows, but it is also set by
-- other edit paths and says nothing about WHEN, or about a widened rule-only
-- rewrite that touched no sampled row at all.
--
-- TIMESTAMPTZ rather than BOOLEAN: "has been fixed" is one query away from the
-- timestamp, and the timestamp additionally answers "was this before or after
-- the re-check that rescored it", which is the question asked whenever a fixed
-- pattern turns Broken again.
--
-- NULLABLE with no default, following 043 and 045: existing rows predate this
-- and genuinely have no answer. NULL = never applied (or applied before this
-- column existed), which is the same thing the UI needs to draw the plain amber
-- button. Nothing older reads the column, so this is additive and instant.
ALTER TABLE patterns
  ADD COLUMN IF NOT EXISTS redirects_applied_at TIMESTAMPTZ;

COMMENT ON COLUMN patterns.redirects_applied_at IS
  'When an apply-redirects job last rewrote this pattern. Drives the grey Fixed chip in the results table, which exists because a successful fix otherwise removes the Fix button and leaves no trace that the pattern was dealt with. NULL for patterns never fixed, or fixed before this column existed.';
