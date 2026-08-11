import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculatePatternScore,
  patternStatusForConfidence
} from "./patternScore.js";
import type { SampleCheckResult } from "./sampleUrlCheck.js";

// Minimal stand-in: calculatePatternScore reads only scoreWeight and
// redirectCount.
function blocked(): SampleCheckResult {
  return {
    ...result(0),
    httpStatus: 405,
    isHit: false,
    httpStatusCategory: "blocked"
  };
}

function result(scoreWeight: number, redirectCount = 0): SampleCheckResult {
  return {
    url: "https://e.com/x",
    httpStatus: 200,
    responseMs: 10,
    isHit: true,
    isSoft404: false,
    finalUrl: null,
    redirectCount,
    httpStatusCategory: "success",
    scoreWeight,
    timedOut: false,
    errorReason: null
  };
}

// ---- THE REPORTED BUG ------------------------------------------------------
// A set of single-URL, zero-param patterns (/contact-us, /nsn, /featured-parts,
// /nsn/cage-code-lookup) showed Status "Broken", Confidence 0%, Redirect 0% while
// those URLs were fine when visited manually. The zero-results branch returned
// BAD, so "checked and failed" and "checked nothing" landed in the same cell.

test("zero samples does NOT score as BAD", () => {
  assert.notEqual(calculatePatternScore([]).status, "BAD");
});

test("zero samples scores as PENDING, which the UI renders as 'Not scored'", () => {
  // PENDING is the pattern_status enum's existing not-yet-scored value (migration
  // 001, and the column DEFAULT). The frontend's normalizeStatus() maps anything
  // outside GOOD/WARNING/BAD to UNKNOWN, which statusLabels renders as
  // "Not scored" — so this value needs no enum migration to display correctly.
  assert.deepEqual(calculatePatternScore([]), {
    confidencePct: 0,
    redirectPct: 0,
    status: "PENDING"
  });
});

test("PENDING is a value the patterns.status enum accepts", () => {
  // Guards against reintroducing a literal the column would reject at insert
  // time. The enum is exactly these four (migration 001).
  assert.ok(
    ["PENDING", "GOOD", "WARNING", "BAD"].includes(
      calculatePatternScore([]).status
    )
  );
});

// ---- real samples still score exactly as before ----------------------------
// The fix must not move any threshold: only the no-data case changed.

test("a fully healthy sample is GOOD at 100% confidence", () => {
  const score = calculatePatternScore([result(1), result(1), result(1)]);

  assert.equal(score.confidencePct, 100);
  assert.equal(score.redirectPct, 0);
  assert.equal(score.status, "GOOD");
});

test("a genuinely failing sample is still BAD", () => {
  // This is what BAD is FOR — a measured failure, not an absence of measurement.
  const score = calculatePatternScore([result(0), result(0)]);

  assert.equal(score.confidencePct, 0);
  assert.equal(score.status, "BAD");
});

test("redirect share is counted per sampled URL", () => {
  const score = calculatePatternScore([
    result(0.5, 1),
    result(0.5, 1),
    result(1, 0),
    result(1, 0)
  ]);

  assert.equal(score.redirectPct, 50);
  assert.equal(score.confidencePct, 75);
  assert.equal(score.status, "WARNING");
});

test("the confidence thresholds are unchanged", () => {
  assert.equal(patternStatusForConfidence(100), "GOOD");
  assert.equal(patternStatusForConfidence(80), "GOOD");
  assert.equal(patternStatusForConfidence(79.99), "WARNING");
  assert.equal(patternStatusForConfidence(50), "WARNING");
  assert.equal(patternStatusForConfidence(49.99), "BAD");
  assert.equal(patternStatusForConfidence(0), "BAD");
});

test("this module loads without standing up Redis", () => {
  // The point of extracting it: importing samplePatternsJob transitively opens a
  // BullMQ/Redis connection at module load and hangs the test process. Reaching
  // this assertion at all proves the import chain stayed clean (the SampleCheckResult
  // import above is type-only and erased at compile time).
  assert.equal(typeof calculatePatternScore, "function");
});

// --- blocked samples are excluded from scoring ------------------------------
// A blocked row is the site's security answering, not the page. Averaging it in
// as a zero is what reported a working site as Broken.

test("all-blocked scores PENDING, not BAD", () => {
  const score = calculatePatternScore([blocked(), blocked(), blocked()]);

  assert.equal(score.status, "PENDING");
  assert.equal(score.confidencePct, 0);
  assert.equal(score.redirectPct, 0);
});

test("all-blocked is reached through the FILTER, not the empty-results check", () => {
  // Distinguishes the two PENDING paths: this input is non-empty, so if the
  // filter were missing it would divide by 3 and score 0% -> BAD. Passing here
  // proves the filter ran rather than the zero-length branch coincidentally
  // catching it.
  const input = [blocked(), blocked(), blocked()];

  assert.equal(input.length, 3, "premise: the input is NOT empty");
  assert.equal(calculatePatternScore(input).status, "PENDING");
  // And the zero-sample path still behaves identically.
  assert.equal(calculatePatternScore([]).status, "PENDING");
});

test("a MIX scores only off the measurable results", () => {
  // Two healthy + two blocked must read 100% confident, not 50%. Under the old
  // maths the blocked pair dragged this to 50% -> WARNING.
  const score = calculatePatternScore([
    result(1),
    result(1),
    blocked(),
    blocked()
  ]);

  assert.equal(score.confidencePct, 100);
  assert.equal(score.status, "GOOD");
});

test("a mix of blocked and genuinely failing still reports BAD off the real ones", () => {
  // The filter must not rescue a pattern that really is broken.
  const score = calculatePatternScore([result(0), result(0), blocked()]);

  assert.equal(score.confidencePct, 0);
  assert.equal(score.status, "BAD");
});

test("redirect share is computed against measurable rows only", () => {
  // One redirect out of two measurable = 50%, not 1-in-4 = 25%.
  const score = calculatePatternScore([
    result(0.5, 1),
    result(1, 0),
    blocked(),
    blocked()
  ]);

  assert.equal(score.redirectPct, 50);
});
