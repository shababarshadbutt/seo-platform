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

// IS THIS CHANGE A SEGMENT MOVE? (v1.78)
//
// WHY IT MATTERS ENOUGH TO DETECT. The reported site's redirects were
//   /product/{cat}/rfq/{mfr}/{pn}/{id}  ->  /rfq/product/{cat}/{mfr}/{pn}/{id}
// on a pattern of 579,034 URLs. Nothing in the redirect-fix route can express
// that: rule candidates are literal find/replace, so each one is derived from a
// single pair and matches almost nothing (measured: 10 of 579,034), and per-shape
// rules use the same literal derivation inside a valueShape bucket where every
// category collapses to the same shape, so their samples disagree and the shape
// is reported unagreed. Verifying more URLs cannot help either — the destinations
// were already confirmed; there was simply no rule able to carry them.
//
// The Update Pattern structure transform CAN do it, deterministically and with no
// probing at all, because it substitutes params by name. So when the confirmed
// pairs look like a move, the modal's job is to say so and name that route rather
// than offer counting and verifying, which cannot converge here.
//
// Detected from the pairs already on screen: same multiset of path segments, in a
// different order. Deliberately strict — EVERY pair must agree, because one
// coincidental anagram among a hundred ordinary redirects is not a pattern-wide
// move and recommending a whole-pattern rewrite off it would be worse than
// saying nothing.
export function looksLikeSegmentReorder(
  pairs: Array<{ source: string; destination: string | null }>
): boolean {
  const usable = pairs.filter(
    (pair): pair is { source: string; destination: string } =>
      typeof pair.destination === "string" && pair.destination.length > 0
  );

  if (usable.length === 0) {
    return false;
  }

  return usable.every((pair) => {
    const before = pathSegmentsOf(pair.source);
    const after = pathSegmentsOf(pair.destination);

    if (before === null || after === null) {
      return false;
    }

    if (before.length !== after.length || before.length === 0) {
      return false;
    }

    // Same parts, different order. Equal order is not a move — it is either no
    // change at all or an edit inside a segment, both of which the ordinary rule
    // routes handle.
    if (before.join("/") === after.join("/")) {
      return false;
    }

    const sortedBefore = [...before].sort();
    const sortedAfter = [...after].sort();

    return sortedBefore.every((value, index) => value === sortedAfter[index]);
  });
}

function pathSegmentsOf(rawUrl: string): string[] | null {
  try {
    return new URL(rawUrl).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}
