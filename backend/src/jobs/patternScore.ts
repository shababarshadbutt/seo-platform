import type { SampleCheckResult } from "./sampleUrlCheck.js";

// Pure scoring for a pattern's sampled URLs: confidence, redirect share, status.
//
// Deliberately its OWN module with only a TYPE import, for the same reason
// sampleHttpStatus.ts is: samplePatternsJob transitively pulls in
// sessionCompletion -> preGenerateZipQueue, which opens a BullMQ/Redis connection
// at module load, so importing the job from a unit test hangs the test process
// forever. `import type` is erased at compile time and loads nothing at runtime,
// so this stays testable without standing up Redis.

// PENDING is the patterns.status enum's existing "not yet scored" value and the
// column DEFAULT (migration 001). The enum accepts exactly
// PENDING | GOOD | WARNING | BAD, so a new "UNKNOWN" literal would fail the
// insert and adding one would need a migration for a state that already has a
// value. The frontend's normalizeStatus() maps anything outside
// GOOD/WARNING/BAD to UNKNOWN, which statusLabels renders as "Not scored" — so
// PENDING already produces the intended cell.
export type PatternStatus = "PENDING" | "GOOD" | "WARNING" | "BAD";

export function patternStatusForConfidence(confidencePct: number): PatternStatus {
  if (confidencePct >= 80) {
    return "GOOD";
  }

  if (confidencePct >= 50) {
    return "WARNING";
  }

  return "BAD";
}

export function calculatePatternScore(results: SampleCheckResult[]) {
  // NEVER SCORED IS NOT BROKEN. This branch used to return BAD, which put "we
  // checked and it failed" and "we checked nothing" in the same cell — a set of
  // single-URL zero-param patterns (/contact-us, /nsn, /featured-parts) rendered
  // as Status "Broken", Confidence 0%, Redirect 0% while the URLs were fine when
  // visited manually. BAD is a measurement; zero samples means there was no
  // measurement, and reporting one is how a display bug becomes a data bug —
  // downstream consumers key off status (the Fix button's visibility rule in
  // lib/fix-visibility.ts treats BAD as fixable).
  //
  // Confidence and redirect stay 0 because there is genuinely nothing to average;
  // the status just no longer asserts a verdict the data does not support.
  // A BLOCKED sample is not a data point. The site's security answered instead of
  // the page, so its status says nothing about whether the URL works — averaging
  // it in as a zero would report a working site as broken, which is exactly the
  // lie the "blocked" category exists to stop. Filtered out BEFORE any maths.
  const measurable = results.filter(
    (result) => result.httpStatusCategory !== "blocked"
  );

  // Nothing measurable — either no samples at all, or every one was blocked. Both
  // mean the same thing at the status level: we have no measurement. Falls through
  // to the SAME PENDING branch rather than duplicating it, so "never checked" and
  // "checked but fully blocked" agree on the status and are distinguished by the
  // sampled_urls rows instead (which is what the dialog copy reads).
  if (measurable.length === 0) {
    return {
      confidencePct: 0,
      redirectPct: 0,
      status: "PENDING" as const
    };
  }

  const scoreTotal = measurable.reduce(
    (total, result) => total + result.scoreWeight,
    0
  );
  const redirectTotal = measurable.filter((result) => result.redirectCount > 0)
    .length;
  const confidencePct = Number(
    ((scoreTotal / measurable.length) * 100).toFixed(2)
  );
  const redirectPct = Number(
    ((redirectTotal / measurable.length) * 100).toFixed(2)
  );

  return {
    confidencePct,
    redirectPct,
    status: patternStatusForConfidence(confidencePct)
  };
}
