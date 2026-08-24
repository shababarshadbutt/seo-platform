import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  looksLikeSegmentReorder,
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

// --- segment-move detection (v1.78) -----------------------------------------
// The reported pattern's redirects moved a segment to the front. No rule route
// can express that, so the modal has to name the structure transform instead of
// offering counting and verifying, which cannot converge on it.

const REORDERED = [
  {
    source:
      "https://www.io.com/product/safety/rfq/scott-safety/200130-01/9u694/",
    destination:
      "https://www.io.com/rfq/product/safety/scott-safety/200130-01/9u694/"
  },
  {
    source: "https://www.io.com/product/fasteners/rfq/fabory/u01200-050/",
    destination: "https://www.io.com/rfq/product/fasteners/fabory/u01200-050/"
  }
];

test("the reported redirects are recognised as a segment move", () => {
  assert.equal(looksLikeSegmentReorder(REORDERED), true);
});

test("an ordinary rewrite is not a move", () => {
  // Same position, different value — a literal rule handles this and the
  // transform advice would be a distraction.
  assert.equal(
    looksLikeSegmentReorder([
      {
        source: "https://x.com/product/old-name/",
        destination: "https://x.com/product/new-name/"
      }
    ]),
    false
  );
});

test("one coincidental anagram among ordinary redirects is not a move", () => {
  // The strictness that matters: recommending a whole-pattern structural rewrite
  // off a single accidental match would be worse than saying nothing.
  assert.equal(
    looksLikeSegmentReorder([
      ...REORDERED,
      {
        source: "https://x.com/product/widget/",
        destination: "https://x.com/catalogue/widget/thing/"
      }
    ]),
    false
  );
});

test("an unchanged path is not a move", () => {
  assert.equal(
    looksLikeSegmentReorder([
      { source: "https://x.com/a/b/", destination: "https://x.com/a/b/" }
    ]),
    false
  );
});

test("rows with no destination cannot suggest anything", () => {
  // 404s in the list carry final_url = null. They are not evidence either way.
  assert.equal(
    looksLikeSegmentReorder([
      { source: "https://x.com/a/b/", destination: null }
    ]),
    false
  );
  assert.equal(looksLikeSegmentReorder([]), false);
});

test("a malformed URL is not read as a move", () => {
  assert.equal(
    looksLikeSegmentReorder([
      { source: "not a url", destination: "https://x.com/a/b/" }
    ]),
    false
  );
});
