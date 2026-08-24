import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  STRATIFIED_WORTH_IT,
  verifyAdviceFor,
  verifyAdviceLabel
} from "./verify-advice";

// The regression: the Fix modal told operators to run a full HTTP probe of every
// URL to raise "9 of 28,000 have a confirmed destination". On the reported
// session that meant a 320,876-URL run that was still going hours later, while
// the shape check that finishes the same work in ~1,150 requests was never
// mentioned.

test("a wide scope is advised to check by shape", () => {
  assert.equal(verifyAdviceFor(320876), "shape");
  assert.equal(verifyAdviceFor(579034), "shape");
  // The reported pattern from the second report, 28,000 URLs in one structure.
  assert.equal(verifyAdviceFor(28000), "shape");
});

test("a small scope still gets the full run", () => {
  // Below the threshold the full check IS the quick option, and recommending a
  // sampled one would trade a complete answer for nothing.
  assert.equal(verifyAdviceFor(500), "full");
  assert.equal(verifyAdviceFor(0), "full");
});

test("the boundary matches the button the panel actually renders", () => {
  // PatternVerifyPanel renders the shape button at >= STRATIFIED_WORTH_IT. The
  // modal must not name a control that is not on screen, so the two share this
  // number rather than each holding their own copy.
  assert.equal(verifyAdviceFor(STRATIFIED_WORTH_IT - 1), "full");
  assert.equal(verifyAdviceFor(STRATIFIED_WORTH_IT), "shape");
});

test("the labels are the buttons' exact text", () => {
  // Advice that names a button whose label differs is advice an operator cannot
  // follow — this is the string they will be looking for.
  assert.equal(verifyAdviceLabel("shape"), "Check by shape");
  assert.equal(verifyAdviceLabel("full"), "Verify all in this pattern");
});

test("advice never depends on anything but size", () => {
  // Stated as a property because the failure mode here is a second condition
  // creeping in (a rule, a status filter, a structure scope) and quietly
  // returning "full" for a population nobody can probe.
  for (const scopeTotal of [0, 1, 19999, 20000, 1_300_000]) {
    assert.equal(
      verifyAdviceFor(scopeTotal),
      scopeTotal >= STRATIFIED_WORTH_IT ? "shape" : "full",
      `size alone must decide at ${scopeTotal}`
    );
  }
});
