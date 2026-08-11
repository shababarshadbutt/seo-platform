import { strict as assert } from "node:assert";
import { test } from "node:test";

import { appliesPatternWide, fixAcceptCount } from "./fix-accept-count";

// The regression this guards: the banner above the button said "applies the
// confirmed rule to all 92,643 matching URLs" while the button said 1,000. Same
// screen, same click, two different numbers.
test("shows the pattern-wide total when one rule applies to the whole pattern", () => {
  assert.equal(
    fixAcceptCount({
      fixCount: 1000,
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false
    }),
    92643
  );
});

test("falls back to the reviewed count when no single rule could be inferred", () => {
  // Nothing beyond the reviewed rows gets rewritten in this case, so the
  // pattern-wide number would promise changes that never happen.
  assert.equal(
    fixAcceptCount({
      fixCount: 1000,
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: true
    }),
    1000
  );
});

test("falls back to the reviewed count when the sample IS the whole pattern", () => {
  // fixPatternTotal === fixCandidateCount: every occurrence was reviewed, so the
  // reviewed count is already the real scope and the two agree by construction.
  assert.equal(
    fixAcceptCount({
      fixCount: 7,
      fixPatternTotal: 12,
      fixCandidateCount: 12,
      inferredWithoutRule: false
    }),
    7
  );
});

test("does not go pattern-wide when the total is somehow below the sample", () => {
  // Defensive: fixPatternTotal is fetched separately from the candidate list, so
  // a stale or partial fetch could report fewer occurrences than rows reviewed.
  // Showing the smaller number is the safe direction.
  assert.equal(
    fixAcceptCount({
      fixCount: 5,
      fixPatternTotal: 3,
      fixCandidateCount: 10,
      inferredWithoutRule: false
    }),
    5
  );
});

test("still reports the pattern-wide total when nothing is selected yet", () => {
  // Documenting the deliberate consequence rather than asserting a nicer number:
  // the count is the SCOPE of an accept, not the selection size, so it does not
  // drop to 0 when fixCount is 0. That is safe only because the button's
  // disabled={fixCount === 0} condition is unchanged, so this label is never
  // clickable in that state. If that condition is ever relaxed, revisit this.
  assert.equal(
    fixAcceptCount({
      fixCount: 0,
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false
    }),
    92643
  );
});

// --- the two banners are mutually exclusive (follow-up to ba286d5f) ---------
// results/page.tsx has no component test harness, so these assert the PREDICATE
// that gates the indigo banner rather than the rendered DOM. The banner is
// `{fixAppliesPatternWide ? <indigo/> : null}` and the amber one is
// `{fixInferredWithoutRule ? <amber/> : null}`, so predicate false + flag true is
// exactly "indigo absent, amber present".

test("no single rule inferred: indigo banner gated OFF while amber is ON", () => {
  const inferredWithoutRule = true;
  const gate = appliesPatternWide({
    fixPatternTotal: 92643,
    fixCandidateCount: 1000,
    inferredWithoutRule
  });

  // Indigo banner does not render, even though the pattern total exceeds the
  // reviewed rows — which is the condition that used to be enough on its own.
  assert.equal(gate, false);
  // Amber banner does render: it keys off the flag directly.
  assert.equal(inferredWithoutRule, true);
  // …and the button agrees, falling back to the reviewed count.
  assert.equal(
    fixAcceptCount({
      fixCount: 1000,
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule
    }),
    1000
  );
});

test("the two banners can never both render, for any input", () => {
  // The invariant rather than one example: whenever amber is on, indigo is off.
  for (const fixPatternTotal of [0, 12, 1000, 92643]) {
    for (const fixCandidateCount of [0, 12, 1000]) {
      assert.equal(
        appliesPatternWide({
          fixPatternTotal,
          fixCandidateCount,
          inferredWithoutRule: true
        }),
        false,
        `indigo must stay off at total=${fixPatternTotal} candidates=${fixCandidateCount}`
      );
    }
  }
});

test("a real pattern-wide rule still turns the indigo banner ON", () => {
  // The guard must not have silenced the banner in the case it exists for.
  assert.equal(
    appliesPatternWide({
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false
    }),
    true
  );
});
