-- Shape-stratified verification (v1.69).
--
-- WHY. Verifying a 579,034-URL pattern took 3h17m, and raising the request rate
-- only buys a constant factor — above ~1M URLs even 400 req/s exceeds an hour.
-- But URLs sharing a SHAPE (valueShape: digit runs to 9xlength, letter runs to
-- a) come from one CMS template, so a sample of a shape usually answers for the
-- whole shape. Probing ~50 per shape turns 579,034 requests into roughly 1,150.
--
-- WHAT THIS TABLE IS FOR, and the invariant it exists to protect.
--
-- v1.68 made apply-redirects treat every verified_urls row carrying a final_url
-- as a CONFIRMED destination — a URL that was actually fetched. That is what
-- fixed the "button says 28,546, toast says 10" bug, and it only works because
-- verified_urls means exactly one thing.
--
-- So extrapolated URLs MUST NOT be written to verified_urls. Writing a row whose
-- final_url was guessed rather than fetched would silently re-create that bug
-- with no way left to tell measured from inferred. Two releases were spent
-- removing it.
--
-- The artifact of a trusted shape is therefore its RULE, stored here, and the
-- apply path reaches the unprobed members through rule-based widening — which
-- already exists and is already honest about being inference. verified_urls
-- keeps meaning "fetched"; this table means "inferred from a sample, and here is
-- how big that sample was".
--
-- agreed = every probed pair in the shape distilled to the same rewrite rule
-- (deriveRedirectRule over that shape alone). FALSE rows are kept rather than
-- discarded: "we sampled this shape and its URLs disagree" is the finding that
-- justifies escalating it to a full verification, and a caller that cannot see
-- it would re-sample the same shape forever.
CREATE TABLE IF NOT EXISTS pattern_shape_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  -- valueShape of the source path, e.g. '/a/a-a-99999/'.
  shape text NOT NULL,
  -- The distilled RedirectRule ({kind:'replace',find,replace} or
  -- {kind:'insert',prefix,insert}). NULL when agreed = false: there is no single
  -- rule, and that is the point of the row.
  rule jsonb,
  -- How many URLs of this shape were actually probed, and how many exist. The
  -- ratio is what the modal reports as evidence, so it is stored rather than
  -- recomputed from a population that may have changed since.
  sample_size integer NOT NULL,
  population integer NOT NULL,
  agreed boolean NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pattern_id, shape)
);

CREATE INDEX IF NOT EXISTS idx_pattern_shape_rules_pattern
  ON pattern_shape_rules (pattern_id);

COMMENT ON TABLE pattern_shape_rules IS
  'Per-URL-shape rewrite rules distilled from a sampled verification (v1.69). Inference, NOT measurement: verified_urls holds only URLs that were actually fetched, and apply-redirects depends on that distinction.';

COMMENT ON COLUMN pattern_shape_rules.agreed IS
  'True when every probed pair in this shape distilled to the same rule. False rows are retained deliberately — they are what justifies escalating the shape to a full verification.';

-- The verification STRATEGY is part of a run's identity, for the third time and
-- the same reason migrations 040 (pattern_ids) and 050 (structure_filters)
-- record.
--
-- The route attaches a re-POST to an in-flight run of the same scope instead of
-- stacking a second one. Without this column a request for a FULL verification
-- would attach to a running STRATIFIED run of the same pattern — same session,
-- same pattern_ids, same structure_filters, so the existing predicate matches —
-- and poll a 1,150-probe run while believing it had asked for 579,034 URLs to be
-- checked. It would then treat a sampled result set as an exhaustive one, which
-- is precisely the measured-versus-inferred confusion pattern_shape_rules above
-- exists to keep apart.
--
-- NULL is read as 'full': every row written before v1.69 was a full run, and so
-- is every request that does not ask otherwise.
ALTER TABLE maintenance_jobs
  ADD COLUMN IF NOT EXISTS strategy text;

COMMENT ON COLUMN maintenance_jobs.strategy IS
  'For kind ''verify-urls'': ''stratified'' when this run probed a sample per URL shape, ''full''/NULL when it probed every URL. Part of the attach identity — a full request must never attach to a stratified run.';
