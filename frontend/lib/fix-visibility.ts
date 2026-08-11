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
