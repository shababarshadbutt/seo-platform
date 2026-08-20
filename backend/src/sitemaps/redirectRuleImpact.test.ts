import assert from "node:assert/strict";
import { test } from "node:test";

import type { RedirectRule } from "./redirectRule.js";
import { RedirectRuleImpact } from "./redirectRuleImpact.js";

// The live shortlist: one literal rule per category.
const RULES: RedirectRule[] = [
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

const POPULATION = [
  "https://x.com/product/material-handling/rfq/a/1/",
  "https://x.com/product/material-handling/rfq/b/2/",
  "https://x.com/product/material-handling/rfq/c/3/",
  "https://x.com/product/safety/rfq/d/4/",
  // Belongs to the pattern but to a category nobody ticked.
  "https://x.com/product/abrasives/rfq/e/5/"
];

function count(rules: RedirectRule[], urls: string[]) {
  const impact = new RedirectRuleImpact(rules);

  for (const url of urls) {
    impact.offer(url);
  }

  return impact.totals();
}

test("each rule is counted over the real population, not the sample", () => {
  // "fits 3 of 10" describes ten confirmed redirects; this is the number that
  // goes on a button which rewrites files.
  const totals = count(RULES, POPULATION);

  assert.equal(totals.perRule[0].matches, 3);
  assert.equal(totals.perRule[1].matches, 1);
  assert.equal(totals.scanned, 5);
});

test("URLs no ticked rule matches are not counted", () => {
  // The abrasives URL is in the pattern and must stay out of every total, or the
  // button would promise to change a category nobody selected.
  const totals = count(RULES, POPULATION);

  assert.equal(totals.anyRule, 4);
  assert.equal(totals.scanned - totals.anyRule, 1);
});

test("with no overlap the per-rule counts sum to the total", () => {
  // This is what lets the UI add up the ticked rules' numbers rather than
  // re-scanning on every tick.
  const totals = count(RULES, POPULATION);
  const summed = totals.perRule.reduce((sum, rule) => sum + rule.matches, 0);

  assert.equal(totals.overlapping, 0);
  assert.equal(summed, totals.anyRule);
});

test("a URL two rules both match is counted ONCE, and reported", () => {
  // Not expected between category needles, but summing per-rule numbers into a
  // label would over-report if it ever happened — so it is detected rather than
  // assumed away.
  const overlapping: RedirectRule[] = [
    { kind: "replace", find: "product", replace: "A" },
    { kind: "replace", find: "product/safety", replace: "B" }
  ];
  const totals = count(overlapping, ["https://x.com/product/safety/x/"]);

  assert.equal(totals.perRule[0].matches, 1);
  assert.equal(totals.perRule[1].matches, 1);
  assert.equal(totals.anyRule, 1);
  assert.equal(totals.overlapping, 1);
});

test("a rule that would not CHANGE a URL does not count as a match", () => {
  // applyRedirectRule returns null for "does not apply" and for "applies but
  // changes nothing"; both mean the rule does nothing to this URL.
  const noop: RedirectRule[] = [{ kind: "replace", find: "zzz", replace: "zzz" }];
  const totals = count(noop, ["https://x.com/product/zzz/"]);

  assert.equal(totals.perRule[0].matches, 0);
  assert.equal(totals.anyRule, 0);
});

test("no rules and no URLs are both answerable", () => {
  assert.deepEqual(count([], POPULATION).perRule, []);
  assert.equal(count([], POPULATION).anyRule, 0);
  assert.equal(count(RULES, []).scanned, 0);
});
