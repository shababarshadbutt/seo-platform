-- Where a per-shape rewrite rule CAME FROM (v1.84).
--
-- WHY A THIRD WORD IS NEEDED. Migration 051 established two, and spent twenty
-- lines on why they must not blur: verified_urls means a URL that was actually
-- FETCHED, and pattern_shape_rules means INFERRED from a sample of that shape,
-- with sample_size/population recording how big the sample was. It also records
-- that two releases were spent removing an earlier conflation of the two.
--
-- v1.84 lets an operator supply a rule for a shape by hand, because the reported
-- session is one where nothing else can: the pattern spans unrelated families,
-- its confirmed pairs disagree, deriveRedirectRule returns null pattern-wide, and
-- every stratum comes back unagreed — so a fix reached 8 of 10,427,507 URLs and
-- the operator who could SEE the right rewrite had no way to say so.
--
-- That rule is neither fetched nor inferred. It is ASSERTED. Without this column
-- it would have to be written as agreed = true with sample_size = 0, which reads
-- as "we sampled this shape and it agreed" — the exact class of lie 051 exists to
-- prevent, and one that would be indistinguishable from measurement forever after.
--
-- The apply path deliberately does NOT branch on this. It already honours every
-- agreed row (redirectApply.ts), and an operator rule is agreed by construction:
-- a human said so. This column exists so the UI can LABEL the difference and so a
-- future reader can tell measurement from assertion — not to gate the rewrite.
ALTER TABLE pattern_shape_rules
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'sampled';

-- Every row that existed before this migration came from a stratified
-- verification, so the default is not a guess — it is what they are.
ALTER TABLE pattern_shape_rules
  DROP CONSTRAINT IF EXISTS pattern_shape_rules_source_known;

ALTER TABLE pattern_shape_rules
  ADD CONSTRAINT pattern_shape_rules_source_known
  CHECK (source IN ('sampled', 'operator'));

-- Who asserted it and when. NULL for sampled rows, which have measured_at
-- already and no author.
ALTER TABLE pattern_shape_rules
  ADD COLUMN IF NOT EXISTS authored_by text;

ALTER TABLE pattern_shape_rules
  ADD COLUMN IF NOT EXISTS authored_at timestamptz;

-- An operator row must carry a rule: "I assert this shape has no rule" is not a
-- statement the apply path can act on, and an agreed row with a NULL rule would
-- be loaded and then silently skipped.
ALTER TABLE pattern_shape_rules
  DROP CONSTRAINT IF EXISTS pattern_shape_rules_operator_has_rule;

ALTER TABLE pattern_shape_rules
  ADD CONSTRAINT pattern_shape_rules_operator_has_rule
  CHECK (source <> 'operator' OR (rule IS NOT NULL AND agreed = true));

COMMENT ON COLUMN pattern_shape_rules.source IS
  'sampled = distilled from a stratified probe of this shape (sample_size/population say how big). operator = asserted by a human in the Review unfixed groups dialog (v1.84); sample_size is 0 and means nothing was probed, NOT that a probe agreed.';
