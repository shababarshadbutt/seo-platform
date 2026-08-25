import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOutcomeMessage,
  classifyApplyOutcome,
  isPartialApply
} from "./applyOutcome.js";

const BASE = {
  rewrittenLocCount: 0,
  replacementCount: 0,
  widened: false,
  filesScanned: 3,
  previouslyFixed: false
};

test("real work is just 'applied'", () => {
  assert.equal(
    classifyApplyOutcome({ ...BASE, rewrittenLocCount: 27365 }),
    "applied"
  );
});

test("real work that left pattern members behind is 'partially applied'", () => {
  // The v1.81 case. This is what a 12-of-579,034 apply looked like before:
  // indistinguishable from a complete one, under a success tick and a full Fixed
  // chip, which is why the reported session read as "it fixed one pattern and
  // missed the rest".
  assert.equal(
    classifyApplyOutcome({
      ...BASE,
      rewrittenLocCount: 12,
      skippedInScope: 579022
    }),
    "partially-applied"
  );
});

test("a complete apply is not downgraded by a zero tally", () => {
  assert.equal(
    classifyApplyOutcome({
      ...BASE,
      rewrittenLocCount: 27365,
      skippedInScope: 0
    }),
    "applied"
  );
});

test("no tally means no claim: a path that does not measure reads as before", () => {
  // Absent a measurement there is no honest denominator, and inventing one from
  // patterns.total_urls — an extrapolation describing the PRE-fix files — would
  // report a shortfall on a complete apply.
  assert.equal(
    classifyApplyOutcome({
      ...BASE,
      rewrittenLocCount: 27365,
      skippedInScope: null
    }),
    "applied"
  );
});

test("skipped URLs cannot rescue an apply that changed nothing", () => {
  // Zero rewritten is still one of the four zero verdicts; "partial" describes
  // work that landed, not work that did not.
  assert.equal(
    classifyApplyOutcome({ ...BASE, skippedInScope: 400 }),
    "nothing-to-apply"
  );
});

test("the reported case: a rule matched nothing on an already-fixed pattern", () => {
  // This is what produced "0 URLs updated" with a success tick. The pattern's
  // stored URL list still describes the pre-fix files, so the rule swept them and
  // found nothing — which is the expected END STATE, not a failure.
  assert.equal(
    classifyApplyOutcome({ ...BASE, widened: true, previouslyFixed: true }),
    "already-rewritten"
  );
});

test("the same zero on a NEVER-fixed pattern means something else entirely", () => {
  // Same rewrittenLocCount, same rule, opposite conclusion: here the rule is
  // wrong for these URLs. Collapsing this with the case above is what made one
  // message serve two situations that need opposite next steps.
  assert.equal(
    classifyApplyOutcome({ ...BASE, widened: true, previouslyFixed: false }),
    "rule-matched-nothing"
  );
});

test("no destinations and no rule is 'nothing to apply'", () => {
  // Not a failure either — there was never anything to do. The operator needs to
  // verify URLs or approve a rule, which is a different instruction again.
  assert.equal(classifyApplyOutcome(BASE), "nothing-to-apply");
});

test("confirmed pairs that rewrote nothing are not 'nothing to apply'", () => {
  // There WAS something to apply; it just did not land. Reported as the rule case
  // rather than pretending the apply had no input.
  assert.equal(
    classifyApplyOutcome({ ...BASE, replacementCount: 12 }),
    "rule-matched-nothing"
  );
});

test("unread files outrank every rule verdict", () => {
  // A rule that never got to read a file has told us nothing about whether it
  // matches, so "no source files" has to be checked first or it would be
  // misreported as a bad rule.
  assert.equal(
    classifyApplyOutcome({
      ...BASE,
      widened: true,
      previouslyFixed: true,
      filesScanned: 0
    }),
    "no-source-files"
  );
});

test("every outcome has a message, and the zero ones explain what to do next", () => {
  assert.match(applyOutcomeMessage("applied", 27365), /27,365 URLs updated/);
  assert.match(applyOutcomeMessage("applied", 1), /1 URL updated/);
  // The point of the whole module: each zero says WHY and what to do, rather than
  // reporting a success tick over the number 0.
  assert.match(applyOutcomeMessage("nothing-to-apply", 0), /Verify some/);
  assert.match(applyOutcomeMessage("already-rewritten", 0), /re-analyse/i);
  assert.match(applyOutcomeMessage("rule-matched-nothing", 0), /Check the rule/);
  assert.match(applyOutcomeMessage("no-source-files", 0), /renamed or removed/);
});

test("the partial message states both halves of the measurement", () => {
  const message = applyOutcomeMessage("partially-applied", 12, 579022);

  // The number that landed, the number it was out of, and the number left — the
  // three figures whose absence made a partial apply read as a finished one.
  assert.match(message, /12 of 579,034 URLs/);
  assert.match(message, /579,022 were left unchanged/);
  // And a route to the detail, so this is not just a more precise dead end.
  assert.match(message, /URL shapes listed below/);
});

test("isPartialApply is the single predicate the chip and the toast share", () => {
  assert.equal(isPartialApply("partially-applied"), true);
  assert.equal(isPartialApply("applied"), false);
  assert.equal(isPartialApply("already-rewritten"), false);
});
