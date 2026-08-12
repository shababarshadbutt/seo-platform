import type { PatternStatus } from "./fix-visibility";

// WHY a pattern has no score — the missing half of "Not scored".
//
// THE PROBLEM IT SOLVES. "Not scored" is the honest verdict for situations that
// are nothing like each other and need opposite actions:
//   * the site's security answered instead of the pages, so nothing could be
//     measured -> the checker needs allowlisting at that edge, and the URLs may be
//     perfectly fine;
//   * no URLs were sampled at all -> press Check, or re-run the analysis.
// The pattern table rendered both as the identical grey cell, which is how a fleet
// of blocked sites read as an unfinished check for a week. patternScore.ts is right
// to give them the same STATUS (neither is a measurement); the table is wrong to
// give them the same explanation.
//
// A SEPARATE, PURE MODULE for the same reason fix-visibility.ts is: the rule is
// worth testing on its own, and page.tsx cannot be imported by a test.
//
// Derived from samples the results page ALREADY loads for every pattern, so this
// costs no request and cannot disagree with the drawer under the same row.

export type UnscoredReason = "blocked" | "not-sampled";

// HAS THE ANALYSIS FINISHED PRODUCING SCORES? Nothing here may present an unscored
// row as a finding until it has.
//
// While a session is still extracting or sampling, unscored is "not yet" — the most
// ordinary state there is. Saying "no URLs were sampled", or worse pointing at an
// allowlist request to a third party, about a run that is still going would be a
// guess with an expensive call to action attached.
export function analysisSettled(status: string | undefined): boolean {
  return (
    status === "COMPLETE" ||
    status === "COMPLETED" ||
    status === "FAILED" ||
    status === "CANCELLED"
  );
}

// Only the fields the rule reads, so callers can pass their own row/sample shapes.
type CategorisedSample = {
  http_status_category: string | null;
};

export function unscoredReasonFor(
  status: PatternStatus,
  sourceRole: "current" | "legacy",
  samples: CategorisedSample[],
  settled: boolean
): UnscoredReason | null {
  // A scored pattern has nothing to explain.
  //
  // Legacy (old-sitemap) patterns are never sampled BY DESIGN — they exist only to
  // be compared against the current set — so "no URLs sampled" would be true and
  // meaningless on every one of them.
  if (status !== "UNKNOWN" || sourceRole !== "current") {
    return null;
  }

  if (samples.length === 0) {
    // ONLY once the run is over. Mid-run this row is waiting its turn, and "no URLs
    // sampled" reads as a verdict.
    return settled ? "not-sampled" : null;
  }

  // The RAW category, not the soft-404-aware one: the question is "was this
  // measurement a block", and a blocked response never carries a soft-404 verdict
  // anyway (that sniff needs a 200 body to read).
  //
  // Returns null on a MIX of blocked and real results. Such a pattern is not
  // unscored in the first place — patternScore scores it off the measurable rows —
  // so if one ever arrives here its status is stale, and inventing an explanation
  // for it would be a guess.
  //
  // NOT gated on `settled`: unlike "no URLs sampled", this is a measurement that
  // already happened. A sample that came back blocked came back blocked whether or
  // not the rest of the run has finished.
  return samples.every((sample) => sample.http_status_category === "blocked")
    ? "blocked"
    : null;
}

export function unscoredReasonLabel(
  reason: UnscoredReason,
  sampledCount: number
): string {
  if (reason === "blocked") {
    // "refused", matching the verb the refused-host banner and the verify panel
    // already use for this. One vocabulary for one phenomenon.
    return `site refused all ${sampledCount.toLocaleString("en-US")} check${
      sampledCount === 1 ? "" : "s"
    }`;
  }

  return "no URLs sampled";
}
