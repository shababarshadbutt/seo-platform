import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  appliesPatternWide,
  fixAcceptBreakdown,
  fixAcceptContextTotal,
  fixAcceptCount,
  fixAcceptLimit,
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
  // the other inputs may widen the number back out — a ticked, measured rule
  // reaching the whole pattern included (v1.76).
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
            confirmedRedirectCount: 999999,
            approvedRuleCount: 2,
            approvedRuleImpact: 92643
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
          // Ticked rules are in the sweep since v1.76: approving one must not be
          // able to reach the indigo banner, which is how the button came to
          // claim 579,034 for a rule that changed 10.
          for (const approvedRuleCount of [0, 1, 3]) {
            const scope = {
              fixPatternTotal,
              fixCandidateCount,
              inferredWithoutRule,
              allInPattern,
              confirmedRedirectCount: 999999,
              approvedRuleCount
            };
            const banner = fixModalBanner(scope);
            const where = `total=${fixPatternTotal} candidates=${fixCandidateCount} noRule=${inferredWithoutRule} pressed=${allInPattern} ticked=${approvedRuleCount}`;

            if (banner === "scope") {
              assert.equal(
                inferredWithoutRule,
                false,
                `overclaimed at ${where}`
              );
              assert.equal(allInPattern, true, `overclaimed at ${where}`);
              assert.ok(
                fixPatternTotal > fixCandidateCount,
                `overclaimed at ${where}`
              );
            }

            // And whichever banner is chosen, the button agrees with it about
            // whether this accept is pattern-wide.
            const wide =
              banner === "scope" ||
              banner === "scope-rules" ||
              banner === "scope-limited";
            assert.equal(
              wide,
              appliesPatternWide(scope),
              `banner and button disagree at ${where}`
            );
          }
        }
      }
    }
  }
});

// --- per-shape extrapolation (v1.69) ----------------------------------------
// A stratified verification probes ~50 per URL shape and distils a rule per
// shape, so a pattern that yields NO whole-pattern rule can still be reached
// almost entirely. Those URLs are real reach but they were never fetched, so the
// count includes them and the breakdown names them.

const NO_RULE = {
  fixCount: 10,
  fixPatternTotal: 28413,
  fixCandidateCount: 10,
  inferredWithoutRule: true,
  allInPattern: true
};

test("per-shape reach is added to the measured count", () => {
  assert.equal(
    fixAcceptCount({
      ...NO_RULE,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 27000
    }),
    28150
  );
});

test("the pair is clamped to the scope, never past it", () => {
  // The two numbers come from separate queries, so a stale pair is possible.
  assert.equal(
    fixAcceptCount({
      ...NO_RULE,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 999999
    }),
    28413
  );
});

test("the breakdown names both halves and never sums them", () => {
  assert.deepEqual(
    fixAcceptBreakdown({
      ...NO_RULE,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 27000
    }),
    { measured: 1150, extrapolated: 27000 }
  );
});

test("no extrapolation means no breakdown to show", () => {
  // Nothing was inferred, so the count is entirely measured and a split line
  // would be noise.
  assert.equal(
    fixAcceptBreakdown({
      ...NO_RULE,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 0
    }),
    null
  );
});

test("a whole-pattern rule has no split to report", () => {
  // One transform reaches the whole scope; "measured vs inferred" is not the
  // useful distinction there, and the indigo scope banner already says so.
  assert.equal(
    fixAcceptBreakdown({
      ...NO_RULE,
      inferredWithoutRule: false,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 27000
    }),
    null
  );
});

test("a released toggle reports no split", () => {
  assert.equal(
    fixAcceptBreakdown({
      ...NO_RULE,
      allInPattern: false,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 27000
    }),
    null
  );
});

test("the breakdown's halves never exceed the scope together", () => {
  const split = fixAcceptBreakdown({
    ...NO_RULE,
    fixPatternTotal: 2000,
    confirmedRedirectCount: 1150,
    shapeExtrapolatedCount: 27000
  });

  assert.ok(split);
  assert.equal(split!.measured + split!.extrapolated, 2000);
});

// --- a DERIVED rule reaches the whole scope (v1.71, narrowed v1.76) ----------

test("a DERIVED rule reaches the whole scope, ignoring the confirmed count", () => {
  // inferredWithoutRule === false means the server distilled ONE rule that
  // reproduces every confirmed pair. That case is unchanged since v1.53 and is
  // deliberately still unmeasured — see the module header's note on the gap.
  assert.equal(
    fixAcceptCount({
      fixCount: 10,
      fixPatternTotal: 579034,
      fixCandidateCount: 10,
      inferredWithoutRule: false,
      allInPattern: true,
      confirmedRedirectCount: 5000
    }),
    579034
  );
});

test("a derived rule removes the measured/inferred split", () => {
  // The split exists to name an extrapolation. A whole-pattern rule is not an
  // extrapolation of some URLs and not others — it applies to all of them — so
  // there is no half to name and no breakdown to show.
  assert.equal(
    fixAcceptBreakdown({
      fixCount: 10,
      fixPatternTotal: 579034,
      fixCandidateCount: 10,
      inferredWithoutRule: false,
      allInPattern: true,
      confirmedRedirectCount: 5000,
      shapeExtrapolatedCount: 27000
    }),
    null
  );
});

// --- an APPROVED rule reaches only what it MATCHES (v1.76) ------------------
// The reported regression, and the reason v1.71's assertion above was narrowed to
// derived rules only. A shortlist candidate is a literal edit distilled from
// single confirmed pairs; it can match one URL out of half a million.

const APPROVED = {
  fixCount: 10,
  fixPatternTotal: 579034,
  fixCandidateCount: 10,
  // The server derived NO whole-pattern rule. Ticking one does not change that
  // fact, which is why this input no longer carries the approval (v1.76).
  inferredWithoutRule: true,
  allInPattern: true,
  confirmedRedirectCount: 10,
  approvedRuleCount: 1
};

test("the reported case: button 579,034, apply 10 — the measured 10 wins", () => {
  // Production, v1.75-Live, /product/{param}x6 on internetofindustrials.com. The
  // apply was already correct (v1.75 opened all 187 files); the rule-impact scan
  // had already measured 10 matches across 579,034 URLs; the button said 579,034
  // anyway because ticking a rule flipped inferredWithoutRule off.
  assert.equal(fixAcceptCount({ ...APPROVED, approvedRuleImpact: 10 }), 10);
  // And the gap goes ON the button: "Accept Selected Changes (10 of 579,034)".
  assert.equal(
    fixAcceptContextTotal({ ...APPROVED, approvedRuleImpact: 10 }),
    579034
  );
  assert.equal(fixAcceptLimit({ ...APPROVED, approvedRuleImpact: 10 }), "rules");
});

test("a ticked rule that really does reach the pattern reports it", () => {
  // v1.71's intent, now earned by measurement rather than assumed: the same
  // wiring reports 500,000 when the scan actually found 500,000 matches.
  assert.equal(
    fixAcceptCount({ ...APPROVED, approvedRuleImpact: 500000 }),
    500000
  );
});

test("ticked but NOT counted is an unknown, never a number", () => {
  // No scan has run, so the ticked rule contributes nothing and the count falls
  // back to the confirmed floor. The limit says why, and the modal blocks Accept
  // on it rather than putting a guess on a button that rewrites files.
  assert.equal(
    fixAcceptCount({ ...APPROVED, approvedRuleImpact: null }),
    10
  );
  assert.equal(
    fixAcceptLimit({ ...APPROVED, approvedRuleImpact: null }),
    "rules-uncounted"
  );
});

test("an uncounted tick cannot block a scope that is already fully confirmed", () => {
  // Every URL in the scope has a fetched destination, so the count is the whole
  // scope and no scan could raise it. Blocking there would be friction with no
  // honesty to buy.
  assert.equal(
    fixAcceptLimit({
      ...APPROVED,
      confirmedRedirectCount: 579034,
      approvedRuleImpact: null
    }),
    "none"
  );
});

test("measured rule reach is clamped to the scope", () => {
  // The impact scan and the pattern total are separate requests, so a stale pair
  // is possible. Over-reporting is the direction that lies.
  assert.equal(
    fixAcceptCount({ ...APPROVED, approvedRuleImpact: 999999999 }),
    579034
  );
});

test("rules and confirmed destinations are MAXed, not summed", () => {
  // The rewrite resolves each <loc> by precedence, so its reach is a union whose
  // overlap nothing measures. 1,150 confirmed + 27,000 per-shape against a rule
  // measured at 10 must report the larger term, not 28,160.
  assert.equal(
    fixAcceptCount({
      ...APPROVED,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 27000,
      approvedRuleImpact: 10
    }),
    28150
  );
  assert.equal(
    fixAcceptLimit({
      ...APPROVED,
      confirmedRedirectCount: 1150,
      shapeExtrapolatedCount: 27000,
      approvedRuleImpact: 10
    }),
    "confirmed"
  );
});

test("a rules-derived count reports no measured/inferred split", () => {
  // That pair names the halves of the confirmed + per-shape number. Printing it
  // beside a count the rules produced would explain the button with figures that
  // do not add up to it.
  assert.equal(
    fixAcceptBreakdown({
      ...APPROVED,
      shapeExtrapolatedCount: 5,
      approvedRuleImpact: 40000
    }),
    null
  );
});

test("ticking a rule swaps the amber banner for the one about rules", () => {
  // "scope-limited" says "verify more of the pattern to widen it", which answers
  // a different question than the one an operator holding a partial rule asks.
  assert.equal(
    fixModalBanner({ ...APPROVED, approvedRuleImpact: 10 }),
    "scope-rules"
  );
  assert.equal(
    fixModalBanner({ ...APPROVED, approvedRuleCount: 0 }),
    "scope-limited"
  );
  // And neither is ever the indigo one, which claims the whole pattern.
  assert.notEqual(fixModalBanner({ ...APPROVED, approvedRuleImpact: 10 }), "scope");
});
