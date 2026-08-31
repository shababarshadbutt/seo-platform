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

// --- structure-scoped widening (v1.66) --------------------------------------
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

test("an empty scope means the pre-v1.66 sweep, unchanged", () => {
  // [] is unscoped, not scoped-to-nothing — the distinction the modal relies on
  // when every dropdown sits on "Any structure".
  const rewrite = scopedRedirectRewriter(new Map(), catalogRule, []);

  assert.equal(rewrite(SIBLING), "https://site.com/nsn/part-types-1234");
  assert.equal(rewrite(IN_SCOPE), "https://site.com/nsn/nsn-parts-1234");
});

// --- per-shape rules (v1.69) --------------------------------------------------
// A stratified verification distils a rule PER URL SHAPE, because
// deriveRedirectRule needs every sampled pair to agree and across a whole
// pattern that is a global constraint — which is why the reported 579,034-URL
// pattern distilled to nothing and had to be probed end to end. Within one shape
// the constraint only has to hold among URLs built by the same template.

const FIVE_DIGIT = "https://site.com/nsn/nsn-parts-12191/";
const FOUR_DIGIT = "https://site.com/nsn/nsn-parts-6492/";

// Two shapes, two different rewrites — the case a single whole-pattern rule
// cannot express at all.
const shapeRules = new Map<string, RedirectRule>([
  ["/a/a-a-99999/", { kind: "replace", find: "nsn-parts-", replace: "five/" }],
  ["/a/a-a-9999/", { kind: "replace", find: "nsn-parts-", replace: "four/" }]
]);

test("each shape is rewritten by its OWN rule", () => {
  const rewrite = buildRedirectApplyRewriter(new Map(), null, shapeRules);

  assert.equal(rewrite(FIVE_DIGIT), "https://site.com/nsn/five/12191/");
  assert.equal(rewrite(FOUR_DIGIT), "https://site.com/nsn/four/6492/");
});

test("a shape with no rule is left alone", () => {
  // Only shapes whose samples AGREED get a rule. An unagreed shape must pass
  // through untouched rather than borrowing a neighbour's rewrite.
  const rewrite = buildRedirectApplyRewriter(new Map(), null, shapeRules);

  assert.equal(rewrite("https://site.com/nsn/page-1-34/"), null);
});

test("a confirmed exact destination outranks a shape rule", () => {
  // Measurement beats inference. This is the v1.68 invariant and it must survive
  // per-shape rules being added underneath it.
  const exact = new Map([[FIVE_DIGIT, "https://site.com/confirmed/"]]);
  const rewrite = buildRedirectApplyRewriter(exact, null, shapeRules);

  assert.equal(rewrite(FIVE_DIGIT), "https://site.com/confirmed/");
});

test("a whole-pattern rule outranks a shape rule", () => {
  // The pattern-wide rule was distilled from every sample, the shape rule from
  // one stratum, so the broader evidence wins where both apply.
  const rewrite = buildRedirectApplyRewriter(
    new Map(),
    { kind: "replace", find: "nsn-parts-", replace: "all/" },
    shapeRules
  );

  assert.equal(rewrite(FIVE_DIGIT), "https://site.com/nsn/all/12191/");
});

test("a shape rule still applies where the pattern rule does not match", () => {
  // The fallback that makes this worth having: the pattern-wide rule is real but
  // does not touch this URL, so the shape's own rule gets its turn instead of the
  // URL being skipped.
  const rewrite = buildRedirectApplyRewriter(
    new Map(),
    { kind: "replace", find: "never-present", replace: "x" },
    shapeRules
  );

  assert.equal(rewrite(FIVE_DIGIT), "https://site.com/nsn/five/12191/");
});

test("no shape rules means the pre-v1.69 rewriter, unchanged", () => {
  for (const rules of [undefined, null, new Map<string, RedirectRule>()]) {
    const rewrite = buildRedirectApplyRewriter(new Map(), null, rules);

    assert.equal(rewrite(FIVE_DIGIT), null);
  }
});

// --- several approved rules at once (v1.72) ----------------------------------
// The live shortlist on internetofindustrials.com was one rule per CATEGORY —
// /product/{cat}/rfq -> /rfq/product/{cat} decomposes that way because diffPair
// only expresses literal edits. No single option fits all ten confirmed
// redirects, so the operator ticks several and they are applied together.

const CATEGORY_RULES: RedirectRule[] = [
  {
    kind: "replace",
    find: "product/material-handling/rfq",
    replace: "rfq/product/material-handling"
  },
  {
    kind: "replace",
    find: "product/safety/rfq",
    replace: "rfq/product/safety"
  }
];

test("each ticked rule rewrites its own category", () => {
  const rewrite = buildRedirectApplyRewriter(new Map(), CATEGORY_RULES);

  assert.equal(
    rewrite("https://x.com/product/material-handling/rfq/cotterman/20z380/"),
    "https://x.com/rfq/product/material-handling/cotterman/20z380/"
  );
  assert.equal(
    rewrite("https://x.com/product/safety/rfq/3m-dbi-sala/1112475/"),
    "https://x.com/rfq/product/safety/3m-dbi-sala/1112475/"
  );
});

test("a category nobody ticked is left byte-identical", () => {
  // The core promise of the multi-select: unticked means untouched. Abrasives is
  // in the shortlist but not in this selection.
  const rewrite = buildRedirectApplyRewriter(new Map(), CATEGORY_RULES);

  assert.equal(
    rewrite("https://x.com/product/abrasives/rfq/3m/60650024015/"),
    null
  );
});

test("first matching rule wins, in list order", () => {
  // Overlap is not expected between category needles, but the order has to be
  // defined anyway so the rewrite is deterministic and the impact count can
  // reproduce it.
  const broad: RedirectRule = { kind: "replace", find: "product", replace: "A" };
  const narrow: RedirectRule = { kind: "replace", find: "product/safety", replace: "B" };

  assert.equal(
    buildRedirectApplyRewriter(new Map(), [broad, narrow])("https://x.com/product/safety/x/"),
    "https://x.com/A/safety/x/"
  );
  assert.equal(
    buildRedirectApplyRewriter(new Map(), [narrow, broad])("https://x.com/product/safety/x/"),
    "https://x.com/B/x/"
  );
});

test("a confirmed destination still outranks every rule", () => {
  // The v1.68 invariant, now with more rules to outrank: measurement beats
  // inference, however many inferences there are.
  const url = "https://x.com/product/safety/rfq/a/1/";
  const exact = new Map([[url, "https://x.com/confirmed/"]]);

  assert.equal(
    buildRedirectApplyRewriter(exact, CATEGORY_RULES)(url),
    "https://x.com/confirmed/"
  );
});

test("an empty rule list behaves exactly like no rule", () => {
  // Nothing ticked must mean nothing rewritten by inference — the pre-v1.72
  // no-rule path, unchanged.
  for (const rules of [[], null]) {
    assert.equal(
      buildRedirectApplyRewriter(new Map(), rules)(
        "https://x.com/product/safety/rfq/a/1/"
      ),
      null
    );
  }
});

// --- exclusions (v1.73) ------------------------------------------------------
// A rule sweeps every matching <loc>, so a row the operator set to Skip is still
// rewritten unless something stops it. That is the worst of the two possible
// bugs: the database records "skipped", the file disagrees, and nothing on
// screen ever contradicts itself.

test("an excluded URL is left alone even though a rule matches it", () => {
  const rule: RedirectRule = { kind: "replace", find: "-old", replace: "-new" };
  const skipped = "https://x.com/a/thing-old/";
  const rewrite = buildRedirectApplyRewriter(
    new Map(),
    rule,
    null,
    new Set([skipped])
  );

  assert.equal(rewrite(skipped), null);
  // The control: the same rule DOES rewrite its neighbours, so the null above is
  // the exclusion working and not a rule that never applied.
  assert.equal(
    rewrite("https://x.com/b/thing-old/"),
    "https://x.com/b/thing-new/"
  );
});

test("an exclusion outranks even a confirmed destination", () => {
  // Skip is the operator's explicit "leave this alone". A fetched destination is
  // stronger evidence than a rule, but it is not a decision — this is.
  const url = "https://x.com/a/1/";
  const exact = new Map([[url, "https://x.com/confirmed/"]]);
  const rewrite = buildRedirectApplyRewriter(
    exact,
    null,
    null,
    new Set([url])
  );

  assert.equal(rewrite(url), null);
});

test("an exclusion blocks a per-shape rule too", () => {
  const shapeRules = new Map<string, RedirectRule>([
    ["/a/a-9/", { kind: "replace", find: "old", replace: "new" }]
  ]);
  const url = "https://x.com/a/old-1/";

  assert.equal(
    buildRedirectApplyRewriter(new Map(), null, shapeRules, new Set([url]))(url),
    null
  );
  // Control: without the exclusion the shape rule does fire.
  assert.equal(
    buildRedirectApplyRewriter(new Map(), null, shapeRules)(url),
    "https://x.com/a/new-1/"
  );
});

test("no exclusions changes nothing", () => {
  // The pre-v1.73 path, unchanged — an empty set and an absent argument must both
  // behave as they did before.
  const rule: RedirectRule = { kind: "replace", find: "-old", replace: "-new" };
  const url = "https://x.com/a/thing-old/";

  for (const excluded of [undefined, null, new Set<string>()]) {
    assert.equal(
      buildRedirectApplyRewriter(new Map(), rule, null, excluded)(url),
      "https://x.com/a/thing-new/"
    );
  }
});

// THE OPERATOR'S PATTERN-WIDE RULE (v1.90).
//
// WHAT IT IS FOR. A group here is a valueShape, which keeps digit-run LENGTH, so
// /rfq/textron-inc/95-23218/ and /rfq/bell-industries-inc/t103228-101/ are
// DIFFERENT groups needing separate rules. The reported 8.2M-URL pattern holds
// thousands of them and a coverage report can name 25 per pass, so an operator
// with one correct answer could never finish: 149,745 of 8,184,592 URLs updated,
// then the same again. This parameter is the answer at the scope the answer
// actually has.
//
// TWO PROPERTIES CARRY THE WHOLE DESIGN, and both are pinned below: it is tried
// LAST, and it is confined to the pattern's own template.

const patternWide: RedirectRule = {
  kind: "replace",
  find: "aviation/",
  replace: ""
};

const AVIATION_TEMPLATE = "/aviation/{param}/{param}/{param}";

test("the pattern rule fixes a URL no shape rule has ever been saved for", () => {
  // The reported case exactly: this shape is one of the thousands that never
  // made it into a 25-row coverage report, so nothing has an answer for it.
  const rewrite = buildRedirectApplyRewriter(new Map(), null, null, null, {
    rule: patternWide,
    template: AVIATION_TEMPLATE
  });

  assert.equal(
    rewrite("https://www.nsnfulfillment.com/aviation/rfq/zodiac-in-lhc/1024-931-0/"),
    "https://www.nsnfulfillment.com/rfq/zodiac-in-lhc/1024-931-0/"
  );
  assert.equal(
    rewrite("https://www.nsnfulfillment.com/aviation/rfq/textron-inc/95-23218/"),
    "https://www.nsnfulfillment.com/rfq/textron-inc/95-23218/"
  );
});

test("a URL of ANOTHER pattern in the same file is left byte-identical", () => {
  // The reason the fallback is template-gated and the template is not optional.
  // These 653 sitemap files are shared: "aviation/" appears in URLs belonging to
  // patterns nobody was looking at when this rule was typed, and a sweep that
  // edited them would be the v1.68 overreach wearing a success message. Note the
  // rule ITSELF matches these strings — only the template stops it.
  const rewrite = buildRedirectApplyRewriter(new Map(), null, null, null, {
    rule: patternWide,
    template: AVIATION_TEMPLATE
  });

  // Two segments, not four.
  assert.equal(rewrite("https://www.nsnfulfillment.com/aviation/rfq/"), null);
  // Five segments.
  assert.equal(
    rewrite("https://www.nsnfulfillment.com/aviation/rfq/a/b/c/"),
    null
  );
  // Four segments, but a different literal first segment.
  assert.equal(
    rewrite("https://www.nsnfulfillment.com/electronic/rfq/a/b/"),
    null
  );
});

test("a group's own rule beats the pattern rule", () => {
  // PRECEDENCE, and it is the whole reason this is a separate parameter rather
  // than another entry in `rule`. An answer somebody gave for one shape — or a
  // probe measured for it — is more specific than a catch-all typed for the
  // groups nothing else covers, so it must win. Folding the two would let a
  // pattern-wide sweep quietly overwrite work that was already correct.
  const shapeRules = new Map<string, RedirectRule>([
    ["/a/a/a-a/99-99999/", { kind: "replace", find: "/aviation/", replace: "/av/" }]
  ]);
  const rewrite = buildRedirectApplyRewriter(new Map(), null, shapeRules, null, {
    rule: patternWide,
    template: AVIATION_TEMPLATE
  });

  assert.equal(
    rewrite("https://www.nsnfulfillment.com/aviation/rfq/textron-inc/95-23218/"),
    "https://www.nsnfulfillment.com/av/rfq/textron-inc/95-23218/"
  );
  // A sibling shape with no rule of its own still gets the pattern answer.
  assert.equal(
    rewrite("https://www.nsnfulfillment.com/aviation/rfq/zodiac-in-lhc/1024-931-0/"),
    "https://www.nsnfulfillment.com/rfq/zodiac-in-lhc/1024-931-0/"
  );
});

test("a confirmed destination and an approved rule both still outrank it", () => {
  const url = "https://www.nsnfulfillment.com/aviation/rfq/textron-inc/95-23218/";
  const exact = new Map([[url, "https://www.nsnfulfillment.com/measured/"]]);
  const approved: RedirectRule = {
    kind: "replace",
    find: "/aviation/",
    replace: "/approved/"
  };

  assert.equal(
    buildRedirectApplyRewriter(exact, approved, null, null, {
      rule: patternWide,
      template: AVIATION_TEMPLATE
    })(url),
    "https://www.nsnfulfillment.com/measured/"
  );
  assert.equal(
    buildRedirectApplyRewriter(new Map(), approved, null, null, {
      rule: patternWide,
      template: AVIATION_TEMPLATE
    })(url),
    "https://www.nsnfulfillment.com/approved/rfq/textron-inc/95-23218/"
  );
});

test("an exclusion blocks the pattern rule too", () => {
  // Skip is the operator's explicit "leave this alone", and it outranks even a
  // confirmed destination — so a sweep this wide must not be the one thing that
  // gets past it. The database would say skipped and the file would disagree.
  const url = "https://www.nsnfulfillment.com/aviation/rfq/textron-inc/95-23218/";
  const fallback = { rule: patternWide, template: AVIATION_TEMPLATE };

  assert.equal(
    buildRedirectApplyRewriter(
      new Map(),
      null,
      null,
      new Set([url]),
      fallback
    )(url),
    null
  );
  // Control: without the exclusion it fires.
  assert.equal(
    buildRedirectApplyRewriter(new Map(), null, null, null, fallback)(url),
    "https://www.nsnfulfillment.com/rfq/textron-inc/95-23218/"
  );
});

test("a rule that does not fit leaves the URL alone rather than mangling it", () => {
  // The honest half of "saved for the whole pattern without checking it fits
  // every group". A URL the find string does not occur in passes through, and the
  // next coverage report counts it exactly as it does now — so the number after
  // the apply stays true and the operator can see what is left.
  const rewrite = buildRedirectApplyRewriter(new Map(), null, null, null, {
    rule: { kind: "replace", find: "helicopter/", replace: "" },
    template: AVIATION_TEMPLATE
  });

  assert.equal(
    rewrite("https://www.nsnfulfillment.com/aviation/rfq/textron-inc/95-23218/"),
    null
  );
});

test("no pattern rule changes nothing", () => {
  // The pre-v1.90 path: an absent argument and an explicit null must both behave
  // as the four-argument form always did.
  const shapeRules = new Map<string, RedirectRule>([
    ["/a/a-9/", { kind: "replace", find: "old", replace: "new" }]
  ]);
  const url = "https://x.com/a/old-1/";

  for (const fallback of [undefined, null]) {
    assert.equal(
      buildRedirectApplyRewriter(new Map(), null, shapeRules, null, fallback)(url),
      "https://x.com/a/new-1/"
    );
  }
});

test("a malformed <loc> reaches neither the shape map nor the pattern rule", () => {
  // These two lookups share one pathname parse since v1.90. Before, the try/catch
  // returned from the whole function, which was correct when the shape map was
  // last; with a second consumer after it, a junk <loc> has to leave BOTH alone
  // rather than only the one that used to follow.
  const shapeRules = new Map<string, RedirectRule>([
    ["/a/", { kind: "replace", find: "a", replace: "b" }]
  ]);

  assert.equal(
    buildRedirectApplyRewriter(new Map(), null, shapeRules, null, {
      rule: patternWide,
      template: AVIATION_TEMPLATE
    })("not-a-url aviation/x"),
    null
  );
});
