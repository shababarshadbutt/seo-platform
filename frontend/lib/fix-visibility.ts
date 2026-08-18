// Visibility rule for the pattern table's Fix button.
//
// The button keys off the pattern's STATUS alone, not off whether a redirect
// happened to land in the ≤ sample_size sampled URLs: a Broken pattern whose
// tiny sample is all 404s (e.g. total_urls = 1) still needs its Fix entry
// point, and a Healthy pattern hides Fix even when its sample contains a
// redirect — per the SEO team's spec, only Broken/Warning are fixable.
export type PatternStatus = "GOOD" | "WARNING" | "BAD" | "UNKNOWN";

export function showFixButton(row: { status: PatternStatus }): boolean {
  return row.status === "BAD" || row.status === "WARNING";
}

// Visibility rule for the pattern table's CHECK button — the entry point for a
// pattern nothing is known about yet.
//
// Deliberately a SECOND function rather than a mode flag on showFixButton. The
// two answer different questions and must not be collapsed: Fix means "a problem
// is confirmed, act on it" (BAD/WARNING), Check means "we have no measurement,
// go get one" (UNKNOWN). Conflating those two states is exactly how the original
// bug happened — samplePatternsJob wrote BAD for a pattern it had never sampled,
// so "confirmed broken" and "never checked" became indistinguishable.
//
// UNKNOWN is what the backend's PENDING status normalises to on the frontend
// (normalizeStatus maps anything outside GOOD/WARNING/BAD to UNKNOWN), so this
// covers never-scored patterns without the frontend needing to know the enum.
//
// GOOD is deliberately excluded, matching the note above: a healthy, already-
// verified pattern has neither a problem to fix nor an unknown to resolve, so it
// correctly shows no button at all.
export function showCheckButton(row: { status: PatternStatus }): boolean {
  return row.status === "UNKNOWN";
}

// What the pattern table's action cell shows, as ONE answer instead of two
// independent booleans.
//
// WHAT WAS WRONG. The two predicates above are exhaustive over status, and
// neither of them has a state for "this one is done". A successful fix rewrites
// the sampled rows in place (url becomes final_url, category becomes 'success' —
// applyRedirectsJob) and the row is rescored, so a fixed pattern lands on GOOD
// and its button disappears. That is indistinguishable from a pattern that was
// healthy all along, and on a table of hundreds of rows it left reviewers
// reopening patterns to find out whether they had already dealt with them.
//
// "fixed" therefore OUTRANKS both — it is a fact about what was done to the
// pattern, not a reading of its current measurement, and it stays true whatever
// a later re-check decides. A pattern that was fixed and has since gone Broken
// again still shows "fixed": the useful thing to know at a glance is that a fix
// was already attempted here, and the row's own Status cell is what reports the
// current verdict. Conflating the two is what this whole state exists to stop.
export type FixButtonState = "fix" | "fixed" | "check" | "none";

export function fixButtonState(row: {
  status: PatternStatus;
  redirectsAppliedAt?: string | null;
}): FixButtonState {
  if (row.redirectsAppliedAt) {
    return "fixed";
  }

  if (showFixButton(row)) {
    return "fix";
  }

  return showCheckButton(row) ? "check" : "none";
}
