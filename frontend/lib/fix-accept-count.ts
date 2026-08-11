// The number on the Fix modal's "Accept Selected Changes" button.
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
// WHY THE !inferredWithoutRule GUARD. Accepting applies a single inferred
// rewrite rule to every matching URL on disk. When the confirmed redirects were
// too varied to infer one rule, there is no rule to apply beyond the reviewed
// rows, so the pattern-wide number would overstate what the click actually does
// — the opposite error, and a worse one, since it would promise changes that
// never happen.
// Does accepting apply a single inferred rule to the WHOLE pattern, beyond the
// rows on screen?
//
// ONE SOURCE OF TRUTH, deliberately. This condition drives two things that sit
// inches apart in the modal: the indigo "accepting applies the confirmed rule to
// all N matching URLs" banner, and the count on the Accept button. They were
// written out separately and drifted — the banner claimed pattern-wide scope
// while the button counted only reviewed rows. Fixing the button alone then left
// the banner overclaiming in the no-rule case, i.e. the same bug moved one
// element up. Anything that needs to know "is this pattern-wide?" calls this.
export function appliesPatternWide(input: {
  // Real pattern-wide occurrence count on disk.
  fixPatternTotal: number;
  // How many rows are in the reviewed sample.
  fixCandidateCount: number;
  // True when the confirmed redirects were too varied to infer one rule.
  inferredWithoutRule: boolean;
}): boolean {
  return (
    input.fixPatternTotal > input.fixCandidateCount && !input.inferredWithoutRule
  );
}

export function fixAcceptCount(input: {
  // Reviewed sample rows currently toggled to "Fix".
  fixCount: number;
  // Real pattern-wide occurrence count on disk.
  fixPatternTotal: number;
  // How many rows are in the reviewed sample.
  fixCandidateCount: number;
  // True when the confirmed redirects were too varied to infer one rule.
  inferredWithoutRule: boolean;
}): number {
  return appliesPatternWide(input) ? input.fixPatternTotal : input.fixCount;
}
