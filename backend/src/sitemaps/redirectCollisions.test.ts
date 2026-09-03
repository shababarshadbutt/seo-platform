import assert from "node:assert/strict";
import { test } from "node:test";

import { RedirectCollisionCounter } from "./redirectCollisions.js";
import type { RedirectRule } from "./redirectRule.js";

const STRIP: RedirectRule = { kind: "normalizeDigits", dropZeroTokens: false };

function count(urls: string[], rule: RedirectRule = STRIP) {
  const counter = new RedirectCollisionCounter(rule);

  for (const url of urls) {
    counter.offer(url);
  }

  return counter.totals();
}

// THE CASE THE FEATURE CREATES. Three spellings of one page collapse to one URL,
// so two of the three entries become duplicates.
test("three spellings of one page collapse into two duplicates", () => {
  const totals = count([
    "https://s.com/page-1-3/",
    "https://s.com/page-1-03/",
    "https://s.com/page-1-003/"
  ]);

  assert.equal(totals.scanned, 3);
  assert.equal(totals.duplicates, 2);
  assert.equal(totals.collidingDestinations, 1);
  assert.equal(totals.truncated, false);
});

// THE CASE A "count only what the rule rewrites" IMPLEMENTATION WOULD MISS. The
// rule does not touch "page-1-3" at all — it has no padding — yet it is exactly
// what the rewritten URL collides with.
test("an untouched URL still counts as the thing collided with", () => {
  const totals = count([
    "https://s.com/page-1-3/", // rule does nothing here
    "https://s.com/page-1-003/" // ...but this becomes it
  ]);

  assert.equal(totals.duplicates, 1);
  assert.equal(totals.collidingDestinations, 1);
});

test("distinct pages that stay distinct produce no warning", () => {
  const totals = count([
    "https://s.com/page-1-003/",
    "https://s.com/page-2-007/",
    "https://s.com/page-4-17/"
  ]);

  assert.equal(totals.scanned, 3);
  assert.equal(totals.duplicates, 0);
  assert.equal(totals.collidingDestinations, 0);
});

test("several separate collisions are counted separately", () => {
  const totals = count([
    "https://s.com/page-1-3/",
    "https://s.com/page-1-003/",
    "https://s.com/page-2-7/",
    "https://s.com/page-2-007/",
    "https://s.com/page-2-07/"
  ]);

  // page-1-3 gains one duplicate, page-2-7 gains two.
  assert.equal(totals.duplicates, 3);
  assert.equal(totals.collidingDestinations, 2);
});

// A literal rule can collide too — the counter is not specific to the new kind.
test("a literal replace rule that collapses two URLs is counted", () => {
  const totals = count(
    ["https://s.com/a-x/", "https://s.com/a-y/"],
    { kind: "replace", find: "-x", replace: "-y" }
  );

  assert.equal(totals.duplicates, 1);
});

test("nothing scanned means nothing to warn about", () => {
  const totals = count([]);

  assert.equal(totals.scanned, 0);
  assert.equal(totals.duplicates, 0);
  assert.equal(totals.truncated, false);
});
