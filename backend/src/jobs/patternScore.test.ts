import assert from "node:assert/strict";
import { test } from "node:test";

import {
  calculatePatternScore,
  patternStatusForConfidence
} from "./patternScore.js";
import type { SampleCheckResult } from "./sampleUrlCheck.js";

// Minimal stand-in: calculatePatternScore reads only scoreWeight and
// redirectCount.
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
