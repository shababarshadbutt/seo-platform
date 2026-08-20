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
// WHY THE !inferredWithoutRule GUARD WAS RELAXED (v1.54). It used to suppress
// the pattern-wide number outright: accepting applies a single inferred rewrite
// rule to every matching URL on disk, so with no rule to infer there is nothing
// to apply beyond the reviewed rows and the big number overstated the click.
// That reasoning still holds — what changed is where the caveat lives. The
// header control is now an explicit "Set all to Fix" toggle, pressed by default,
// and a toggle whose number does not move when you press it is exactly the
// control users could not read. So the button now states the scope the toggle
// ASKS FOR, and the shortfall is stated in words: fixModalBanner() below picks a
// banner that names both the target and the reviewable subset, and the success
// toast reports the server's authoritative rewritten_loc_count afterwards.
// inferredWithoutRule therefore no longer gates the count — it only picks the
// banner.
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
  return appliesPatternWide(input) ? input.fixPatternTotal : input.fixCount;
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
