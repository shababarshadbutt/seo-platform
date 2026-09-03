import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyRedirectRule,
  deriveNormalizationRule,
  deriveRedirectRule,
  sameRule,
  type RedirectRule
} from "./redirectRule.js";

test("derives a strip/replace rule from a removed segment", () => {
  const rule = deriveRedirectRule([
    {
      source: "https://site.com/products-parts-catalog/widget",
      dest: "https://site.com/products/widget"
    },
    {
      source: "https://site.com/products-parts-catalog/gadget",
      dest: "https://site.com/products/gadget"
    }
  ]);

  assert.deepEqual(rule, { kind: "replace", find: "-parts-catalog", replace: "" });
  assert.equal(
    applyRedirectRule("https://site.com/products-parts-catalog/thingy", rule as RedirectRule),
    "https://site.com/products/thingy"
  );
});

// Reproduces the real-world case reported after v1.42/1.43: a redirect that
// only ADDS a static segment (e.g. "/rfq/x" -> "/aviation/rfq/x") with nothing
// removed. Before this fix, diffPair's prefix/suffix peel consumed the entire
// source as "common suffix" (since source is literally a suffix of dest),
// leaving find === "" — which the old code treated as "cannot generalise" and
// returned null, so the "Fix" modal only ever offered the handful of
// HTTP-sampled URLs and the other tens of thousands of matching URLs in the
// pattern were silently never rewritten.
test("derives an insert rule from a pure segment insertion (no removal)", () => {
  const rule = deriveRedirectRule([
    {
      source: "https://www.purchasingmatrix.com/rfq/airbus-helicopter/c642a0300103",
      dest: "https://www.purchasingmatrix.com/aviation/rfq/airbus-helicopter/c642a0300103"
    },
    {
      source: "https://www.purchasingmatrix.com/rfq/airbus-helicopter/366a58122925",
      dest: "https://www.purchasingmatrix.com/aviation/rfq/airbus-helicopter/366a58122925"
    }
  ]);

  assert.ok(rule, "expected a rule to be derived instead of null");
  assert.deepEqual(rule, {
    kind: "insert",
    prefix: "https://www.purchasingmatrix.com/",
    insert: "aviation/"
  });

  const applied = applyRedirectRule(
    "https://www.purchasingmatrix.com/rfq/airbus-helicopter/9999999999",
    rule as RedirectRule
  );

  assert.equal(
    applied,
    "https://www.purchasingmatrix.com/aviation/rfq/airbus-helicopter/9999999999"
  );
});

test("insert rule does not apply to a URL missing the shared prefix", () => {
  const rule: RedirectRule = {
    kind: "insert",
    prefix: "https://www.purchasingmatrix.com/",
    insert: "aviation/"
  };

  assert.equal(applyRedirectRule("https://other-site.com/rfq/x/1", rule), null);
});

test("disagreeing pairs (different edits) refuse to derive a rule", () => {
  const rule = deriveRedirectRule([
    {
      source: "https://site.com/rfq/a/1",
      dest: "https://site.com/aviation/rfq/a/1"
    },
    {
      source: "https://site.com/rfq/b/2",
      dest: "https://site.com/marine/rfq/b/2"
    }
  ]);

  assert.equal(rule, null);
});

test("identical source/dest pairs are skipped without forcing a null rule", () => {
  const rule = deriveRedirectRule([
    { source: "https://site.com/x", dest: "https://site.com/x" },
    {
      source: "https://site.com/rfq/a/1",
      dest: "https://site.com/aviation/rfq/a/1"
    }
  ]);

  assert.deepEqual(rule, {
    kind: "insert",
    prefix: "https://site.com/",
    insert: "aviation/"
  });
});

test("no usable pairs yields null", () => {
  assert.equal(deriveRedirectRule([]), null);
  assert.equal(
    deriveRedirectRule([{ source: "https://site.com/x", dest: "https://site.com/x" }]),
    null
  );
});

// --- normalizeDigits (the value-based kind) --------------------------------

// THE HEADLINE CASE. These two pairs are exactly why the kind exists: diffPair
// reads them as `strip "-00"` and `strip "00"`, which are mutually wrong
// (page-1-003 -> "page-13", page-3-00 -> "page-3-"), so the literal path refuses.
// One normalization explains both.
test("zero-padded pairs that diffPair contradicts now derive a normalization", () => {
  const rule = deriveRedirectRule([
    { source: "https://site.com/page-3-00/", dest: "https://site.com/page-3/" },
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" }
  ]);

  assert.deepEqual(rule, { kind: "normalizeDigits", dropZeroTokens: true });
});

// Narrowest reading first: when plain zero-stripping already explains every pair,
// the rule that ALSO deletes tokens must not be chosen. Picking the wider one here
// would silently delete "-0" segments from URLs nobody complained about.
test("plain zero-stripping is preferred over dropping zero tokens", () => {
  const rule = deriveNormalizationRule([
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" },
    { source: "https://site.com/page-2-007/", dest: "https://site.com/page-2-7/" }
  ]);

  assert.deepEqual(rule, { kind: "normalizeDigits", dropZeroTokens: false });
});

// AN AGREEING LITERAL RULE STILL WINS, and that is deliberate: deriveRedirectRule
// falls back to the value-based reading only when diffPair CONTRADICTS itself, so
// every case that already worked keeps working byte-for-byte.
//
// It also documents a hazard that predates this feature. Both pairs below diff to
// `replace "00" -> ""`, which is right for them and WRONG for the rest of the
// pattern — it would turn "product-1002" into "product-12". The automatic path
// cannot see that from two samples. That is exactly why redirectRuleCandidates
// offers the normalization alongside the literal reading even when derivation
// agrees, and why the probe evidence, not the diff, decides which one an operator
// is shown first.
test("a literal rule that agrees on the sample is still what derivation returns", () => {
  const rule = deriveRedirectRule([
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" },
    { source: "https://site.com/page-2-007/", dest: "https://site.com/page-2-7/" }
  ]);

  assert.deepEqual(rule, { kind: "replace", find: "00", replace: "" });
  // ...and that rule is demonstrably wrong for a URL neither sample covered.
  assert.equal(
    applyRedirectRule("https://site.com/product-1002/", rule),
    "https://site.com/product-12/"
  );
});

// A normalization is adopted only when it explains EVERY pair — one contradictory
// destination and we are back to inferring nothing.
test("a pair the normalization cannot explain still yields no rule", () => {
  const rule = deriveRedirectRule([
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" },
    { source: "https://site.com/page-2-007/", dest: "https://site.com/somewhere-else/" }
  ]);

  assert.equal(rule, null);
});

// ONLY THE PATH. A host can carry a zero-padded label of its own, and rewriting it
// would point the sitemap at a different SERVER rather than a different page.
test("normalizeDigits rewrites the path and never the origin", () => {
  const rule = { kind: "normalizeDigits", dropZeroTokens: false } as const;

  assert.equal(
    applyRedirectRule("https://web-007.example.com/page-003/", rule),
    "https://web-007.example.com/page-3/"
  );
  assert.equal(
    applyRedirectRule("https://site.com:8080/a-09/", rule),
    "https://site.com:8080/a-9/"
  );
});

// The whole pattern gets this rule, and most of its URLs carry no padding. They
// must come back as null (no change), which is the contract rewriteLocs relies on
// to leave a <loc> untouched.
test("normalizeDigits returns null for a URL with no zero padding", () => {
  const rule = { kind: "normalizeDigits", dropZeroTokens: true } as const;

  assert.equal(applyRedirectRule("https://site.com/page-4-17/", rule), null);
  assert.equal(applyRedirectRule("https://site.com/plain/", rule), null);
});

// The old two-branch ternary in sameRule treated "not insert" as "must be
// replace", so these two would have compared their undefined find/replace fields
// and reported EQUAL — merging the two readings the probe ladder exists to tell
// apart.
test("sameRule distinguishes the two normalization readings", () => {
  const strip = { kind: "normalizeDigits", dropZeroTokens: false } as const;
  const stripDrop = { kind: "normalizeDigits", dropZeroTokens: true } as const;

  assert.equal(sameRule(strip, strip), true);
  assert.equal(sameRule(strip, stripDrop), false);
  assert.equal(sameRule(stripDrop, strip), false);
  assert.equal(sameRule(strip, { kind: "replace", find: "a", replace: "b" }), false);
});
