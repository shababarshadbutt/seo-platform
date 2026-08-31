-- ONE ANSWER FOR A WHOLE PATTERN (v1.90)
--
-- THE REPORTED FAILURE. On /aviation/{param}/{param}/{param} the SEO team ticked
-- all 25 unfixed groups, gave them ONE answer — replace "aviation/" with "" — and
-- pressed Fix. The run reported 149,745 of 8,184,592 URLs updated across 653 of
-- 653 files. Reopening showed 25 fresh groups and 8,034,847 still unfixed.
--
-- WHY. Everything in this table is keyed on valueShape(pathname), which collapses
-- letter runs to 'a' but keeps digit-run LENGTH. So within that one pattern
--
--   /rfq/national-semiconductor-corp/am27c32qe45/  ->  /a/a/a-a-a/a99a99a99/
--   /rfq/textron-inc/95-23218/                     ->  /a/a/a-a/99-99999/
--   /rfq/bell-industries-inc/t103228-101/          ->  /a/a/a-a-a/a999999-999/
--
-- every vendor-name hyphen count crossed with every part-number layout is a
-- DIFFERENT row here. 8.2M URLs fragment into thousands of shapes, the coverage
-- report only ever surfaces 25 of them (applyCoverage's SKIPPED_SHAPE_LIMIT), and
-- the dialog can only save rules for shapes it can see. Each pass therefore paid a
-- full 653-file scan to teach the rewriter 25 shapes. Hundreds of passes.
--
-- The operator's rule was shape-independent all along. Nothing could apply it that
-- way, so this migration adds the row that can.
--
-- WHY A FOURTH `source` AND NOT 'operator' WITH A MAGIC SHAPE. 051, 053 and 055
-- spent three releases keeping FETCHED (verified_urls) apart from INFERRED
-- (source = 'sampled') apart from ASSERTED (source = 'operator'), and 051 records
-- that undoing an earlier conflation cost two of them. The scope of an assertion
-- is the same kind of fact: every reader of this table must be able to tell a rule
-- that covers ONE shape from one that covers a WHOLE PATTERN without parsing
-- `shape` and knowing what '*' means. resolveApplyInputs depends on exactly that —
-- it loads per-shape rules into a map keyed on valueShape, where a '*' row could
-- never match anything and would sit there silently inert.
--
-- SHAPE IS '*' — A SENTINEL, NOT A SHAPE. valueShape is only ever called on a URL
-- pathname, which always begins with '/', so no real shape can equal '*' and the
-- existing UNIQUE (pattern_id, shape) already makes this row singular per pattern
-- with no new index or constraint of its own. The CHECK below pins the sentinel so
-- a pattern-wide rule cannot be written against a real shape, where it would read
-- as covering that shape alone.

ALTER TABLE pattern_shape_rules
  DROP CONSTRAINT IF EXISTS pattern_shape_rules_source_known;

ALTER TABLE pattern_shape_rules
  ADD CONSTRAINT pattern_shape_rules_source_known
  CHECK (source IN ('sampled', 'operator', 'no_change', 'operator_pattern'));

-- An operator's pattern-wide assertion MUST carry the rewrite and MUST agree:
-- redirectApply only honours agreed rows with a rule, and a row that says "the
-- whole pattern" while carrying nothing to apply would be an answer that silently
-- does nothing — the state this whole area exists to stop producing. The shape
-- clause is what keeps '*' meaning "every URL of this pattern" and nothing else.
ALTER TABLE pattern_shape_rules
  DROP CONSTRAINT IF EXISTS pattern_shape_rules_pattern_wide_has_rule;

ALTER TABLE pattern_shape_rules
  ADD CONSTRAINT pattern_shape_rules_pattern_wide_has_rule
  CHECK (
    source <> 'operator_pattern'
    OR (rule IS NOT NULL AND agreed = true AND shape = '*')
  );

COMMENT ON COLUMN pattern_shape_rules.source IS
  'Provenance AND scope of the rule. sampled = distilled from a stratified probe of this shape (INFERRED). operator = asserted by a human for this shape (v1.84). no_change = a human asserted these URLs are already correct, so the row carries no rule (v1.87). operator_pattern = asserted by a human for EVERY URL of the pattern, stored once with shape = ''*'' and applied as the lowest-precedence fallback, template-gated (v1.90). Never flatten these to "has a rule": verified_urls means fetched, and 051 records that conflating fetched with inferred took two releases to undo.';
