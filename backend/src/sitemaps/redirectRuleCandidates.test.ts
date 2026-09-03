import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveRedirectRule } from "./redirectRule.js";
import {
  isOfferedRule,
  parseRedirectRule,
  redirectRuleCandidates
} from "./redirectRuleCandidates.js";

const AGREEING = [
  { source: "https://x.com/product/a-1001/", dest: "https://x.com/product/a/1001/" },
  { source: "https://x.com/product/b-2043/", dest: "https://x.com/product/b/2043/" },
  { source: "https://x.com/product/c-3777/", dest: "https://x.com/product/c/3777/" }
];

test("pairs that agree give ONE candidate at full fit", () => {
  const candidates = redirectRuleCandidates(AGREEING);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fits, 3);
  assert.equal(candidates[0].total, 3);
  assert.equal(candidates[0].counterExample, null);
  // And it is the same rule the automatic path would have chosen on its own —
  // this must not become a second opinion about an unambiguous case.
  assert.deepEqual(candidates[0].rule, deriveRedirectRule(AGREEING));
});

test("pairs that DISAGREE still produce a shortlist — the reported case", () => {
  // deriveRedirectRule returns null here, which is what put "only the 0 reviewed
  // URLs can be rewritten" on screen. A human looking at these can see which
  // transformation was meant; this is what gives them something to point at.
  const disagreeing = [
    ...AGREEING,
    { source: "https://x.com/product/legacy-9/", dest: "https://x.com/promo/legacy-9/" }
  ];

  assert.equal(deriveRedirectRule(disagreeing), null);

  const candidates = redirectRuleCandidates(disagreeing);

  assert.ok(candidates.length >= 2);
  // Best first.
  assert.ok(candidates[0].fits >= candidates[1].fits);
  // Nothing claims to explain everything, because nothing does.
  assert.ok(candidates.every((candidate) => candidate.fits < candidate.total));
});

test("a candidate is scored by APPLICATION, not by how many pairs derived it", () => {
  // Both pairs strip the same needle, but their diffs decompose differently
  // because the surrounding text differs. Counting derivations would score the
  // winning rule 1; applying it scores 2, which is the truth a human is trusting.
  const pairs = [
    { source: "https://x.com/a/old-1/", dest: "https://x.com/a/1/" },
    { source: "https://x.com/b/old-22/", dest: "https://x.com/b/22/" }
  ];
  const candidates = redirectRuleCandidates(pairs);

  assert.equal(candidates[0].fits, 2);
  assert.equal(candidates[0].total, 2);
});

test("a partial rule carries the counter-example, not just the count", () => {
  // "fits 3 of 4" is only safe to approve if you can see what the fourth
  // becomes. The counter-example is the more useful half of the evidence.
  const candidates = redirectRuleCandidates([
    ...AGREEING,
    { source: "https://x.com/product/legacy-9/", dest: "https://x.com/promo/legacy-9/" }
  ]);
  const partial = candidates.find((candidate) => candidate.fits === 3);

  assert.ok(partial);
  assert.ok(partial!.counterExample);
  assert.notEqual(partial!.counterExample!.actual, partial!.counterExample!.expected);
});

test("identical rules from different pairs are deduplicated", () => {
  assert.equal(redirectRuleCandidates(AGREEING).length, 1);
});

test("no usable pairs means no candidates, not a crash", () => {
  assert.deepEqual(redirectRuleCandidates([]), []);
  assert.deepEqual(
    redirectRuleCandidates([{ source: "https://x.com/a/", dest: "https://x.com/a/" }]),
    []
  );
});

// --- the authority guarantee -------------------------------------------------

test("only a rule the server itself derived is accepted", () => {
  const offered = redirectRuleCandidates(AGREEING)[0].rule;

  assert.equal(isOfferedRule(offered, AGREEING), true);
  // An invented rewrite is refused however plausible it looks. apply-redirects
  // is built so a client cannot inject a rewrite, and letting a human pick must
  // not weaken that — they choose among the server's readings of the server's
  // own evidence.
  assert.equal(
    isOfferedRule({ kind: "replace", find: "product", replace: "evil" }, AGREEING),
    false
  );
});

test("a rule offered for OTHER evidence is refused here", () => {
  // The check is against this pattern's confirmed pairs, not against "is this a
  // sensible rule in the abstract".
  const elsewhere = redirectRuleCandidates([
    { source: "https://x.com/z/keep-5/", dest: "https://x.com/z/5/" }
  ])[0].rule;

  assert.equal(isOfferedRule(elsewhere, AGREEING), false);
});

test("parseRedirectRule narrows shape and rejects junk", () => {
  assert.deepEqual(parseRedirectRule({ kind: "replace", find: "a", replace: "b" }), {
    kind: "replace",
    find: "a",
    replace: "b"
  });
  assert.deepEqual(parseRedirectRule({ kind: "insert", prefix: "p", insert: "i" }), {
    kind: "insert",
    prefix: "p",
    insert: "i"
  });
  assert.equal(parseRedirectRule(null), null);
  assert.equal(parseRedirectRule("replace"), null);
  assert.equal(parseRedirectRule({ kind: "replace", find: "", replace: "b" }), null);
  assert.equal(parseRedirectRule({ kind: "delete", find: "a" }), null);
});

// --- the value-based readings ----------------------------------------------

// THE REPORTED CASE, and the reason this kind exists. Before, an operator looking
// at these two pairs was offered `strip "-00"` and `strip "00"` — each reproducing
// exactly ONE of the two, each visibly wrong on the other. Now a single rule
// reproduces both and leads the list.
test("zero-padded pairs put the normalization first, at full fit", () => {
  const candidates = redirectRuleCandidates([
    { source: "https://site.com/page-3-00/", dest: "https://site.com/page-3/" },
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" }
  ]);

  assert.deepEqual(candidates[0].rule, {
    kind: "normalizeDigits",
    dropZeroTokens: true
  });
  assert.equal(candidates[0].fits, 2);
  assert.equal(candidates[0].total, 2);
  assert.equal(candidates[0].counterExample, null);

  // The literal readings are still offered — they are real readings of the
  // evidence — but they are behind it, and each carries the counter-example that
  // shows why.
  const literal = candidates.filter((c) => c.rule.kind === "replace");

  assert.ok(literal.length >= 1);
  assert.ok(literal.every((c) => c.fits < 2));
});

// Offered even when the literal reading fits perfectly, because "fits the sample"
// and "correct for the pattern" are different claims — `replace "00" -> ""` also
// rewrites product-1002. On equal fit the normalization ranks ahead.
test("the normalization is offered and ranked above an equally-fitting replace", () => {
  const candidates = redirectRuleCandidates([
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" },
    { source: "https://site.com/page-2-007/", dest: "https://site.com/page-2-7/" }
  ]);

  const normalize = candidates.findIndex(
    (c) => c.rule.kind === "normalizeDigits"
  );
  const replace = candidates.findIndex((c) => c.rule.kind === "replace");

  assert.notEqual(normalize, -1, "normalization must be offered");
  assert.notEqual(replace, -1, "the literal reading is still offered");
  assert.equal(candidates[normalize].fits, 2);
  assert.equal(candidates[replace].fits, 2);
  assert.ok(normalize < replace, "the value-based reading must come first");
});

// A pattern with no padding must not gain two dead options. They reproduce
// nothing, so the existing fits > 0 bar removes them.
test("unpadded evidence offers no normalization candidates", () => {
  const candidates = redirectRuleCandidates([
    {
      source: "https://site.com/rfq/a/1",
      dest: "https://site.com/aviation/rfq/a/1"
    }
  ]);

  assert.equal(
    candidates.some((c) => c.rule.kind === "normalizeDigits"),
    false
  );
});

// The authority guarantee has to extend to the new kind: a client may pick it only
// because the server derived it from the server's own evidence.
test("a normalization is accepted only against evidence that supports it", () => {
  const padded = [
    { source: "https://site.com/page-3-00/", dest: "https://site.com/page-3/" },
    { source: "https://site.com/page-1-003/", dest: "https://site.com/page-1-3/" }
  ];
  const unpadded = [
    {
      source: "https://site.com/rfq/a/1",
      dest: "https://site.com/aviation/rfq/a/1"
    }
  ];
  const rule = { kind: "normalizeDigits", dropZeroTokens: true } as const;

  assert.equal(isOfferedRule(rule, padded), true);
  assert.equal(isOfferedRule(rule, unpadded), false);
});

test("parseRedirectRule narrows the normalization kind and rejects junk", () => {
  assert.deepEqual(parseRedirectRule({ kind: "normalizeDigits", dropZeroTokens: true }), {
    kind: "normalizeDigits",
    dropZeroTokens: true
  });
  assert.deepEqual(parseRedirectRule({ kind: "normalizeDigits", dropZeroTokens: false }), {
    kind: "normalizeDigits",
    dropZeroTokens: false
  });
  // Not a boolean: refused rather than coerced, so a truthy string cannot pick
  // the wider reading by accident.
  assert.equal(parseRedirectRule({ kind: "normalizeDigits", dropZeroTokens: "true" }), null);
  assert.equal(parseRedirectRule({ kind: "normalizeDigits" }), null);
});
