import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  appliesPatternWide,
  fixAcceptContextTotal,
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
      allInPattern: true,
      confirmedRedirectCount: 999999
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
      allInPattern: true,
      confirmedRedirectCount: 999999
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
      allInPattern: true,
      confirmedRedirectCount: 999999
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
      allInPattern: true,
      confirmedRedirectCount: 999999
    }),
    92643
  );
});

// --- the "Set all to Fix" toggle drives the number (v1.66) ------------------
// The toggle exists because a text link gave no way to tell pressed from
// unpressed. A toggle whose number does not move when pressed would have the
// same problem, so these pin the number to the toggle in both directions.

test("pressed, no rule: reports the CONFIRMED count, not the pattern total", () => {
  // This assertion is the inverse of the one v1.66 shipped, and the reason it
  // flipped is the whole point of v1.68. v1.66 returned 28,413 here on the
  // theory that the button should state intended scope. Production then did
  // this: button 28,546, toast "10 URLs updated", ten <loc> entries changed.
  //
  // With no rule, the only rewritable URLs are the ones whose destination was
  // actually fetched. That is the number now — and it climbs to the total on its
  // own as the user verifies more of the pattern.
  assert.equal(
    fixAcceptCount({
      fixCount: 10,
      fixPatternTotal: 28413,
      fixCandidateCount: 10,
      inferredWithoutRule: true,
      allInPattern: true,
      confirmedRedirectCount: 10
    }),
    10
  );
});

test("pressed, no rule, fully verified: the count HAS climbed to the total", () => {
  // The payoff. Same pattern, same absent rule, after "Verify all in this
  // pattern": every URL has a confirmed destination, so an accept really does
  // rewrite all 28,413 — each to its own fetched destination, no inference.
  assert.equal(
    fixAcceptCount({
      fixCount: 10,
      fixPatternTotal: 28413,
      fixCandidateCount: 10,
      inferredWithoutRule: true,
      allInPattern: true,
      confirmedRedirectCount: 28413
    }),
    28413
  );
});

test("pressed, WITH a rule: the pattern total, ignoring the confirmed count", () => {
  // A rule is a pure per-URL transform, so it reaches occurrences nobody
  // fetched. The confirmed count is not the ceiling in this regime and must not
  // cap it — this is the case v1.53 got right and it stays right.
  assert.equal(
    fixAcceptCount({
      fixCount: 1000,
      fixPatternTotal: 92643,
      fixCandidateCount: 1000,
      inferredWithoutRule: false,
      allInPattern: true,
      confirmedRedirectCount: 12
    }),
    92643
  );
});

test("the confirmed count never exceeds the scope total", () => {
  // Defensive: pattern total and confirmed count are fetched by separate
  // requests, so a stale pair is possible. Over-reporting is the direction that
  // lies, so it is the one that gets clamped.
  assert.equal(
    fixAcceptCount({
      fixCount: 10,
      fixPatternTotal: 500,
      fixCandidateCount: 10,
      inferredWithoutRule: true,
      allInPattern: true,
      confirmedRedirectCount: 99999
    }),
    500
  );
});

test("the context total appears only when the count falls short of it", () => {
  // Drives "Accept Selected Changes (10 of 28,413)". Printing "28,413 of 28,413"
  // would be noise, so a complete scope reports no context total at all.
  const short = {
    fixCount: 10,
    fixPatternTotal: 28413,
    fixCandidateCount: 10,
    inferredWithoutRule: true,
    allInPattern: true,
    confirmedRedirectCount: 10
  };

  assert.equal(fixAcceptContextTotal(short), 28413);
  assert.equal(
    fixAcceptContextTotal({ ...short, confirmedRedirectCount: 28413 }),
    null
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
            allInPattern: false,
            confirmedRedirectCount: 999999
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
    inferredWithoutRule: true,
    confirmedRedirectCount: 999999
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
      allInPattern: false,
      confirmedRedirectCount: 999999
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
      allInPattern: true,
      confirmedRedirectCount: 999999
    }),
    true
  );
});

// --- exactly one banner, ever (follow-up to ba286d5f, revised v1.66) --------
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
      allInPattern: true,
      confirmedRedirectCount: 999999
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
      allInPattern: true,
      confirmedRedirectCount: 999999
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
      allInPattern: false,
      confirmedRedirectCount: 999999
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
      allInPattern: true,
      confirmedRedirectCount: 999999
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
            allInPattern,
            confirmedRedirectCount: 999999
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
              allInPattern,
              confirmedRedirectCount: 999999
            }),
            `banner and button disagree at ${where}`
          );
        }
      }
    }
  }
});
