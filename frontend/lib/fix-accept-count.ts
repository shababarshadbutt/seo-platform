// The number on the Fix modal's "Accept Selected Changes" button, and which
// scope banner sits above it.
//
// THE BUG THIS FIXES. The modal already told the truth in a banner — "accepting
// applies the confirmed rule to all {fixPatternTotal} matching URLs across this
// pattern's files" — while the button two hundred lines below it counted only
// the reviewed sample rows toggled to Fix. On a pattern with 1,000 sampled rows
// out of 92,643 occurrences, the banner said 92,643 and the button said 1,000,
// on the same screen. The button was the one users read before clicking.
//
// Extracted as a pure function rather than inlined in the JSX for the same
// reason fix-visibility.ts and fix-status-filter.ts are: results/page.tsx has no
// test file, so logic left in the component is logic nothing can assert.
//
// WHY THE COUNT IS NOT THE PATTERN TOTAL (v1.68, reversing v1.66).
//
// v1.66 made this report the scope the "Set all to Fix" toggle ASKS FOR, on the
// reasoning that a toggle whose number does not move when pressed is a toggle
// users cannot read. The caveat went into a banner and the toast.
//
// That was wrong, and production showed exactly how: the button said 28,546, the
// click succeeded, the toast said 10, and ten <loc> entries changed. A number
// that needs a banner next to it explaining that it will not happen is not a
// label, it is a promise the code cannot keep. The toggle still moves the
// number — just between two numbers that are both true.
//
// A URL can only be rewritten if its destination is KNOWN. Two ways to know it:
//
//   * a derived rule — a pure per-URL transform, so it reaches every occurrence
//     on disk and the total genuinely is the answer;
//   * a confirmed final_url, from verified_urls or the sampled preview. That
//     count is what redirect-candidates now returns as confirmed_redirect_count,
//     and it climbs as the user verifies more of the pattern.
//
// ONE SOURCE OF TRUTH, deliberately. These conditions drive things that sit
// inches apart in the modal: the scope banner, the caption under the toggle, and
// the count on the Accept button. They were written out separately and drifted —
// the banner claimed pattern-wide scope while the button counted only reviewed
// rows. Fixing the button alone then left the banner overclaiming in the no-rule
// case, i.e. the same bug moved one element up. Anything that needs to know "is
// this pattern-wide?" calls this.

type ScopeInput = {
  // Real pattern-wide occurrence count on disk.
  fixPatternTotal: number;
  // How many rows are in the reviewed sample.
  fixCandidateCount: number;
  // True when the confirmed redirects were too varied to infer one rule.
  inferredWithoutRule: boolean;
  // The header "Set all to Fix" toggle. Pressed means the user is targeting
  // every URL in the pattern; released means only the rows they selected.
  allInPattern: boolean;
  // URLs with a confirmed destination in the current scope, from the server
  // (confirmed_redirect_count). The ceiling on what an accept can rewrite when
  // no rule could be derived.
  confirmedRedirectCount: number;
  // Additional URLs a PER-SHAPE rule would reach (v1.69), from a stratified
  // verification. Inference, not measurement — kept as its own input so the two
  // can be named separately and never silently summed.
  shapeExtrapolatedCount?: number;
};

// Does accepting target more than the rows on screen?
export function appliesPatternWide(input: ScopeInput): boolean {
  return input.allInPattern && input.fixPatternTotal > input.fixCandidateCount;
}

export function fixAcceptCount(
  input: ScopeInput & {
    // Reviewed sample rows currently toggled to "Fix".
    fixCount: number;
  }
): number {
  if (!appliesPatternWide(input)) {
    return input.fixCount;
  }

  // Pressed. With a rule the transform reaches every occurrence in scope; with
  // no rule it reaches exactly the URLs whose destination is confirmed. Capped
  // at the scope total for the defensive case where the confirmed set somehow
  // exceeds it (both numbers are fetched separately, so a stale one is possible
  // and over-reporting is the direction that lies).
  if (!input.inferredWithoutRule) {
    return input.fixPatternTotal;
  }

  // No whole-pattern rule. Measured URLs plus whatever a trusted per-shape rule
  // reaches — both real, and both clamped to the scope for the defensive case
  // where separately-fetched numbers disagree. Over-reporting is the direction
  // that lies, so it is the one that gets clamped.
  const reachable =
    input.confirmedRedirectCount + (input.shapeExtrapolatedCount ?? 0);

  return Math.min(reachable, input.fixPatternTotal);
}

// The measured/inferred split behind the Accept count, for the line under the
// button. Returned as a pair rather than a single total because v1.68's lesson
// was "never state a number the backend will not deliver" — a per-shape rule DOES
// deliver, so the number is honest, but the modal still has to be able to say
// which half was fetched and which was inferred. Summing them in here would
// remove that possibility permanently.
export function fixAcceptBreakdown(
  input: ScopeInput & { fixCount: number }
): { measured: number; extrapolated: number } | null {
  // Only meaningful for a pattern-wide accept with no single rule: with a rule
  // the whole scope is reached by one transform and there is no split to show,
  // and a released toggle only ever touches selected rows.
  if (!appliesPatternWide(input) || !input.inferredWithoutRule) {
    return null;
  }

  const extrapolated = input.shapeExtrapolatedCount ?? 0;

  if (extrapolated === 0) {
    return null;
  }

  const measured = Math.min(
    input.confirmedRedirectCount,
    input.fixPatternTotal
  );

  return {
    measured,
    // Never let the pair exceed the scope, and never report a negative.
    extrapolated: Math.max(0, Math.min(extrapolated, input.fixPatternTotal - measured))
  };
}

// The "of N" half of "Accept Selected Changes (10 of 28,546)". Null when there
// is nothing extra to say — the count already IS the whole scope, so printing
// "28,546 of 28,546" would only add noise.
export function fixAcceptContextTotal(
  input: ScopeInput & { fixCount: number }
): number | null {
  const count = fixAcceptCount(input);

  return count < input.fixPatternTotal ? input.fixPatternTotal : null;
}

// Which banner the modal shows above the URL list. One function rather than two
// independent `? :` gates in the JSX, because the previous two gates could both
// be true at once and then contradicted each other on screen.
//
//   "scope"         → indigo: one rule covers the whole pattern, accept is wide.
//   "scope-limited" → amber: accept targets the whole pattern, but no single
//                     rule could be inferred, so only the reviewed rows can be
//                     rewritten yet. States both facts instead of picking one.
//   "no-rule"       → amber: the toggle is released, so only the reviewed rows
//                     are listed and only they are targeted.
//   null            → nothing to qualify.
export type FixModalBanner = "scope" | "scope-limited" | "no-rule" | null;

export function fixModalBanner(input: ScopeInput): FixModalBanner {
  if (appliesPatternWide(input)) {
    return input.inferredWithoutRule ? "scope-limited" : "scope";
  }

  return input.inferredWithoutRule ? "no-rule" : null;
}
