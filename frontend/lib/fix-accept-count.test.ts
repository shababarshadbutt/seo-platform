import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  appliesPatternWide,
  fixAcceptCount,
  fixModalBanner
} from "./fix-accept-count";

// The regression this guards: the banner above the button said "applies the
// confirmed rule to all 92,643 matching URLs" while the button said 1,000. Same
// screen, same click, two different numbers.
test("shows the pattern-wide total when one rule applies to the whole pattern", () => {
  assert.equal(
    fixAcceptCount({
      fixCount: 1000,
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false,
      allInPattern: true
    }),
    92643
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
      inferredWithoutRule: false,
      allInPattern: true
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
      inferredWithoutRule: false,
      allInPattern: true
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
      inferredWithoutRule: false,
      allInPattern: true
    }),
    92643
  );
});

// --- the "Set all to Fix" toggle drives the number (v1.54) ------------------
// The toggle exists because a text link gave no way to tell pressed from
// unpressed. A toggle whose number does not move when pressed would have the
// same problem, so these pin the number to the toggle in both directions.

test("pressed: reports the pattern total even with no inferable rule", () => {
  // The pre-v1.54 behaviour returned 1,000 here. The number now states the scope
  // the toggle asks for; fixModalBanner() carries the shortfall in words, and the
  // success toast reports what actually changed. See the header comment.
  assert.equal(
    fixAcceptCount({
      fixCount: 10,
      fixPatternTotal: 28413,
      fixCandidateCount: 10,
      inferredWithoutRule: true,
      allInPattern: true
    }),
    28413
  );
});

test("released: always the reviewed count, whatever else is true", () => {
  // Releasing the toggle means "only the rows I selected", so no combination of
  // the other inputs may widen the number back out.
  for (const fixPatternTotal of [0, 12, 1000, 92643]) {
    for (const fixCandidateCount of [0, 12, 1000]) {
      for (const inferredWithoutRule of [false, true]) {
        assert.equal(
          fixAcceptCount({
            fixCount: 42,
            fixPatternTotal,
            fixCandidateCount,
            inferredWithoutRule,
            allInPattern: false
          }),
          42,
          `released must stay at the reviewed count at total=${fixPatternTotal} candidates=${fixCandidateCount} noRule=${inferredWithoutRule}`
        );
      }
    }
  }
});

test("the number changes when the toggle is pressed, on a partly-reviewed pattern", () => {
  // The whole point of the control: the two states must not render the same
  // label, or it is a text link again.
  const shared = {
    fixCount: 10,
    fixPatternTotal: 28413,
    fixCandidateCount: 10,
    inferredWithoutRule: true
  };

  assert.notEqual(
    fixAcceptCount({ ...shared, allInPattern: true }),
    fixAcceptCount({ ...shared, allInPattern: false })
  );
});

test("releasing the toggle turns the pattern-wide gate off", () => {
  assert.equal(
    appliesPatternWide({
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false,
      allInPattern: false
    }),
    false
  );
});

test("a real pattern-wide rule still turns the indigo banner ON", () => {
  // The guard must not have silenced the banner in the case it exists for.
  assert.equal(
    appliesPatternWide({
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false,
      allInPattern: true
    }),
    true
  );
});

// --- exactly one banner, ever (follow-up to ba286d5f, revised v1.54) --------
// results/page.tsx has no component test harness, so these assert the function
// that PICKS the banner rather than the rendered DOM. It replaced two
// independent `? :` gates precisely because those two could both be true once
// the count stopped keying off inferredWithoutRule — the modal would then have
// claimed pattern-wide scope and "only the sampled URLs are listed" at once.

test("pressed with a rule: the indigo scope banner", () => {
  assert.equal(
    fixModalBanner({
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false,
      allInPattern: true
    }),
    "scope"
  );
});

test("pressed without a rule: the banner that states BOTH facts", () => {
  // Not "scope" (would overclaim) and not "no-rule" (would contradict the
  // button's 28,413). The combined banner is the only honest option once the
  // button reports intended scope.
  assert.equal(
    fixModalBanner({
      fixPatternTotal: 28413,
      fixCandidateCount: 10,
      inferredWithoutRule: true,
      allInPattern: true
    }),
    "scope-limited"
  );
});

test("released without a rule: the plain sampled-only banner", () => {
  assert.equal(
    fixModalBanner({
      fixPatternTotal: 28413,
      fixCandidateCount: 10,
      inferredWithoutRule: true,
      allInPattern: false
    }),
    "no-rule"
  );
});

test("fully reviewed pattern with a rule: no banner to show", () => {
  assert.equal(
    fixModalBanner({
      fixPatternTotal: 12,
      fixCandidateCount: 12,
      inferredWithoutRule: false,
      allInPattern: true
    }),
    null
  );
});

test("the banner never overclaims: 'scope' implies a rule and a wide accept", () => {
  // The invariant rather than one example. "scope" is the only banner that
  // asserts the rule reaches every matching URL, so it must never appear when
  // no rule was inferred, nor when the toggle is released.
  for (const fixPatternTotal of [0, 12, 1000, 92643]) {
    for (const fixCandidateCount of [0, 12, 1000]) {
      for (const inferredWithoutRule of [false, true]) {
        for (const allInPattern of [false, true]) {
          const banner = fixModalBanner({
            fixPatternTotal,
            fixCandidateCount,
            inferredWithoutRule,
            allInPattern
          });
          const where = `total=${fixPatternTotal} candidates=${fixCandidateCount} noRule=${inferredWithoutRule} pressed=${allInPattern}`;

          if (banner === "scope") {
            assert.equal(inferredWithoutRule, false, `overclaimed at ${where}`);
            assert.equal(allInPattern, true, `overclaimed at ${where}`);
            assert.ok(
              fixPatternTotal > fixCandidateCount,
              `overclaimed at ${where}`
            );
          }

          // And whichever banner is chosen, the button agrees with it about
          // whether this accept is pattern-wide.
          const wide = banner === "scope" || banner === "scope-limited";
          assert.equal(
            wide,
            appliesPatternWide({
              fixPatternTotal,
              fixCandidateCount,
              inferredWithoutRule,
              allInPattern
            }),
            `banner and button disagree at ${where}`
          );
        }
      }
    }
  }
});
