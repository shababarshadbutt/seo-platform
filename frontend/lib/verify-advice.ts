// WHICH verification to send an operator to, when the Fix modal has to admit it
// cannot rewrite most of a pattern.
//
// THE PROBLEM THIS FIXES. A URL is only rewritable when its destination is
// known, so the modal regularly has to say "9 of 28,000 have a confirmed
// destination". Every version of that sentence ended with "use 'Verify all in
// this pattern' above to raise this" — a full HTTP probe of every URL. On the
// reported session that advice was followed literally: a 320,876-URL run, which
// at the rate the checker actually achieves is most of a day, and it is the run
// that was still going when the operator asked why nothing was fixed. Across the
// session ~5,740,380 URLs were waiting behind advice that could never clear them.
//
// The fast path already existed and was never mentioned here. "Check by shape"
// (v1.69) probes ~50 URLs per URL SHAPE — roughly 1,150 requests for 579,034
// URLs — and distils a rule per shape into pattern_shape_rules, which
// apply-redirects then sweeps across every matching <loc>. Minutes, and it
// reaches URLs a full run would not have finished measuring for days.
//
// So this module answers one question — which button should the copy name — and
// it lives here rather than in the JSX for the same reason fix-accept-count.ts
// does: results/page.tsx has no component test harness, so a decision left in
// the markup is a decision nothing can assert. It is also the reason the
// threshold moved out of pattern-verify-panel.tsx: the panel and the modal were
// free to disagree about which button exists, and the modal was recommending the
// one that is not offered on a wide pattern.

// The population past which sampling by shape beats probing everything by enough
// to matter. Below it a full run is already quick and the extra choice is noise —
// which is exactly why PatternVerifyPanel only RENDERS the shape button above
// this number, and why the modal must not recommend it below.
export const STRATIFIED_WORTH_IT = 20000;

export type VerifyAdvice = "shape" | "full";

// Which verification the copy should name for a scope of this size.
//
// Takes the scope total, not the pattern total: the Fix modal's numbers describe
// the structure the edit has been limited to (v1.66), and a 613-URL structure
// inside a 579,034-URL pattern should be advised on its own size.
export function verifyAdviceFor(scopeTotal: number): VerifyAdvice {
  return scopeTotal >= STRATIFIED_WORTH_IT ? "shape" : "full";
}

// The button's exact label, so the copy names a control the operator can find.
// Returned from here rather than written inline at each site because the two
// sites drifted from the panel once already.
export function verifyAdviceLabel(advice: VerifyAdvice): string {
  return advice === "shape" ? "Check by shape" : "Verify all in this pattern";
}
