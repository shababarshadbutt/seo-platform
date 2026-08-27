-- "THESE URLs ARE ALREADY CORRECT" IS A THIRD ANSWER (v1.87).
--
-- WHAT WAS MISSING. v1.86 gave the Review unfixed groups dialog two states per
-- group: it has a rule, or nobody has said anything about it. On the reported
-- pattern (/manufacturer/{param}, 11 groups) several groups need NO rewrite —
-- their URLs are already right. There was no way to say so, so they sat under
-- "Still needs an answer" for ever and the operator could not tell "I checked
-- this, it is fine" from "I have not looked at this yet". Every pass re-examined
-- all of them.
--
-- WHY IT IS A ROW AND NOT A UI FLAG. The apply ALREADY leaves such a group alone —
-- a group with no rule is never rewritten. So nothing about the rewrite changes
-- here, and the only thing being added is the RECORD of the decision. That record
-- is the entire point: without it the group reappears identically next time, which
-- is the repeated-work complaint v1.86 set out to end.
--
-- WHY IT LIVES IN pattern_shape_rules, a table whose name says "rules". Because
-- UNIQUE (pattern_id, shape) is exactly the constraint this needs: a group carries
-- a rule OR a leave-it-alone mark, never both. A separate table would permit a
-- group to hold a rule and a contradicting mark at once, and something would then
-- have to decide which wins. Here the database decides, for free.
--
-- A FOURTH WORD, and 053 explains why that matters. verified_urls means FETCHED,
-- a sampled row means INFERRED, an operator row means ASSERTED. This is asserted
-- too, but it asserts that NOTHING is needed — which is not a rule, and must never
-- be read as one.
ALTER TABLE pattern_shape_rules
  DROP CONSTRAINT IF EXISTS pattern_shape_rules_source_known;

ALTER TABLE pattern_shape_rules
  ADD CONSTRAINT pattern_shape_rules_source_known
  CHECK (source IN ('sampled', 'operator', 'no_change'));

-- THE LOAD-BEARING INVARIANT. redirectApply loads shape rules with
-- "agreed = true AND rule IS NOT NULL", so a row that is guaranteed to hold
-- neither can never reach the rewriter. This constraint is what turns that from a
-- property of today's write path into a property of the schema: no future caller
-- can produce a "leave these alone" row that quietly rewrites something.
--
-- agreed = false is the honest value, not a technicality. Nothing was measured and
-- nothing agreed; a human said no rewrite is wanted. sample_size and population
-- stay 0 for the same reason they do on an operator row (053): 0 means "nothing
-- was probed", never "a probe of size 0 agreed".
ALTER TABLE pattern_shape_rules
  DROP CONSTRAINT IF EXISTS pattern_shape_rules_no_change_has_no_rule;

ALTER TABLE pattern_shape_rules
  ADD CONSTRAINT pattern_shape_rules_no_change_has_no_rule
  CHECK (source <> 'no_change' OR (rule IS NULL AND agreed = false));

COMMENT ON COLUMN pattern_shape_rules.source IS
  'sampled = distilled from a stratified probe of this shape (sample_size/population say how big). operator = a rewrite asserted by a human in the Review unfixed groups dialog (v1.84); sample_size is 0 and means nothing was probed, NOT that a probe agreed. no_change = a human asserted this group needs NO rewrite because its URLs are already correct (v1.87); rule is NULL and agreed is false by constraint, so the apply path cannot see it.';
