import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRedirectApplyRewriter } from "./rewriteLocs.js";
import {
  applyStructureFilterToRewriter,
  type ResolvedStructureFilter
} from "./structureClusters.js";
import type { RedirectRule } from "./redirectRule.js";

// The bug this fixes: apply-redirects' whole-pattern widening used a pre-built
// exact-match map sourced from the CAPPED pattern_urls sample pool, so any URL
// not in that ~1,000-row sample was silently left unrewritten. These tests pin
// the new rewriter's contract — most importantly, that it rewrites a <loc> that
// matches the derived rule even though that exact URL was never enumerated.

const replaceRule: RedirectRule = {
  kind: "replace",
  find: "-parts-catalog",
  replace: ""
};
const insertRule: RedirectRule = {
  kind: "insert",
  prefix: "https://site.com/",
  insert: "aviation/"
};

test("rewrites a URL that matches the rule but was NEVER in the exact map", () => {
  // Empty exact map on purpose: only the general rule can rewrite this URL.
  const rewrite = buildRedirectApplyRewriter(new Map(), replaceRule);

  assert.equal(
    rewrite("https://site.com/manufacturer/jamco-parts-catalog/widget-9999"),
    "https://site.com/manufacturer/jamco/widget-9999"
  );
});

test("insert-kind rule reaches an un-enumerated URL too", () => {
  const rewrite = buildRedirectApplyRewriter(new Map(), insertRule);

  assert.equal(
    rewrite("https://site.com/manufacturer/never-sampled-88888"),
    "https://site.com/aviation/manufacturer/never-sampled-88888"
  );
});

test("an exact confirmed replacement wins over the general rule", () => {
  // This URL both is in the exact map AND matches the rule; the confirmed,
  // HTTP-verified destination must win.
  const exact = new Map([
    [
      "https://site.com/manufacturer/acme-parts-catalog/x",
      "https://site.com/confirmed/acme/x"
    ]
  ]);
  const rewrite = buildRedirectApplyRewriter(exact, replaceRule);

  assert.equal(
    rewrite("https://site.com/manufacturer/acme-parts-catalog/x"),
    "https://site.com/confirmed/acme/x"
  );
});

test("a URL matching neither the map nor the rule passes through (null)", () => {
  const rewrite = buildRedirectApplyRewriter(new Map(), replaceRule);

  assert.equal(rewrite("https://site.com/already/clean/path"), null);
});

test("null rule degrades to exact-map-only (buildLocMapRewriter behaviour)", () => {
  const exact = new Map([["https://site.com/a", "https://site.com/b"]]);
  const rewrite = buildRedirectApplyRewriter(exact, null);

  assert.equal(rewrite("https://site.com/a"), "https://site.com/b");
  assert.equal(rewrite("https://site.com/unmapped"), null);
});

test("an exact replacement equal to the URL is a no-op (null), not a rewrite", () => {
  const exact = new Map([["https://site.com/a", "https://site.com/a"]]);
  const rewrite = buildRedirectApplyRewriter(exact, null);

  assert.equal(rewrite("https://site.com/a"), null);
});

// --- structure-scoped widening (v1.55) --------------------------------------
// The Fix Redirect URLs modal gained "Limit this edit to", so accepting a fix
// reviewed on ONE of a pattern's sub-structures must leave the pattern's other
// structures byte-identical. That guarantee lives in the composition the apply
// path and the pooled worker both build — buildRedirectApplyRewriter wrapped in
// applyStructureFilterToRewriter — which is what these pin. The composition is
// the contract; a rule alone rewrites every <loc> it can transform, which is
// precisely the sweep the scope has to stop.
//
// The rule here deliberately matches BOTH structures. An earlier draft used a
// rule that only matched the in-scope one, so the sibling test passed whether
// the scope worked or not — it was asserting that a non-matching rule does
// nothing. Every "left alone" assertion below is paired with the same call
// unscoped, so a null can only mean the scope stopped it.
const catalogRule: RedirectRule = {
  kind: "replace",
  find: "-catalog",
  replace: ""
};

// segmentIndex 1 = the {param} slot of /nsn/{param}, resolved from the template
// by the route before it ever reaches here.
const nsnPartsScope: ResolvedStructureFilter[] = [
  { segmentIndex: 1, anchor: "prefix", value: "nsn-parts" }
];

const IN_SCOPE = "https://site.com/nsn/nsn-parts-catalog-1234";
const SIBLING = "https://site.com/nsn/part-types-catalog-1234";

function scopedRedirectRewriter(
  exact: Map<string, string>,
  rule: RedirectRule | null,
  filters: ResolvedStructureFilter[] | null
) {
  return applyStructureFilterToRewriter(
    buildRedirectApplyRewriter(exact, rule),
    filters
  );
}

test("scoped widening rewrites inside the chosen structure", () => {
  const rewrite = scopedRedirectRewriter(new Map(), catalogRule, nsnPartsScope);

  assert.equal(rewrite(IN_SCOPE), "https://site.com/nsn/nsn-parts-1234");
});

test("scoped widening leaves a SIBLING structure byte-identical", () => {
  // The reported bug: a fix reviewed on 613 nsn-parts URLs silently rewrote the
  // other ~27,800 under the same pattern. The unscoped assertion is the control
  // — the rule DOES match this URL, so the null above it is the scope working.
  assert.equal(
    scopedRedirectRewriter(new Map(), catalogRule, nsnPartsScope)(SIBLING),
    null
  );
  assert.equal(
    scopedRedirectRewriter(new Map(), catalogRule, null)(SIBLING),
    "https://site.com/nsn/part-types-1234"
  );
});

test("the scope also withholds an EXACT confirmed replacement", () => {
  // The guard wraps the whole rewriter, replacements included. A sampled row
  // from an excluded structure must not slip through just because its
  // destination was HTTP-confirmed — otherwise "limit this edit to" leaks by
  // exactly the size of the review sample.
  const exact = new Map([[SIBLING, "https://site.com/nsn/confirmed-elsewhere"]]);

  assert.equal(
    scopedRedirectRewriter(exact, null, nsnPartsScope)(SIBLING),
    null
  );
  assert.equal(
    scopedRedirectRewriter(exact, null, null)(SIBLING),
    "https://site.com/nsn/confirmed-elsewhere"
  );
});

test("an empty scope means the pre-v1.55 sweep, unchanged", () => {
  // [] is unscoped, not scoped-to-nothing — the distinction the modal relies on
  // when every dropdown sits on "Any structure".
  const rewrite = scopedRedirectRewriter(new Map(), catalogRule, []);

  assert.equal(rewrite(SIBLING), "https://site.com/nsn/part-types-1234");
  assert.equal(rewrite(IN_SCOPE), "https://site.com/nsn/nsn-parts-1234");
});
