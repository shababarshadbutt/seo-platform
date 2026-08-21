// Why a redirect fix changed nothing.
//
// WHAT WAS WRONG. An apply that rewrote zero URLs reported "0 URLs updated to
// their redirect destinations" with a success tick, and the pattern was stamped
// as Fixed anyway. Two different situations produced that identical message and
// they need opposite next steps from the operator:
//
//   * nothing had a known destination yet -> go and verify some URLs;
//   * a rule ran but matched nothing, because an EARLIER fix already rewrote
//     these URLs and the pattern's stored URL list still describes the old ones
//     -> re-analyse, there is nothing left here to fix.
//
// Collapsing those into one number is what made the tool look broken rather than
// finished. Pure function because routes/sessions.ts is only reachable by
// DB-backed integration tests, and this classification is the part with the
// reasoning in it.

export type ApplyOutcome =
  | "applied"
  // Nothing was rewritten and nothing could have been: no confirmed destination
  // and no rule to infer one.
  | "nothing-to-apply"
  // A rule ran over the files and matched no <loc>. On a pattern that was fixed
  // before, that is the expected end state, not a failure.
  | "already-rewritten"
  // A rule ran and matched nothing on a pattern that was never fixed — the rule
  // is wrong for these URLs, or the URLs are not where the pattern says.
  | "rule-matched-nothing"
  // No file was read at all.
  | "no-source-files";

export function classifyApplyOutcome(input: {
  // <loc> entries actually rewritten on disk.
  rewrittenLocCount: number;
  // Confirmed exact source->destination pairs the apply had.
  replacementCount: number;
  // Whether a rule (derived or human-approved) was applied across the files.
  widened: boolean;
  // Files the rewrite scanned.
  filesScanned: number;
  // Was this pattern fixed before this run?
  previouslyFixed: boolean;
}): ApplyOutcome {
  if (input.rewrittenLocCount > 0) {
    return "applied";
  }

  // Checked before the rule cases: a rule that never got to read a file has not
  // told us anything about whether it matches.
  if (input.filesScanned === 0) {
    return "no-source-files";
  }

  if (!input.widened && input.replacementCount === 0) {
    return "nothing-to-apply";
  }

  // A rule swept the files and found nothing. Whether that is expected turns
  // entirely on whether this pattern was already fixed, which is why
  // previouslyFixed is an input rather than something the message hedges about.
  return input.previouslyFixed ? "already-rewritten" : "rule-matched-nothing";
}

// The sentence the operator reads. Written here so the wording travels with the
// classification instead of being rebuilt per call site.
export function applyOutcomeMessage(
  outcome: ApplyOutcome,
  changed: number
): string {
  switch (outcome) {
    case "applied":
      return `${changed.toLocaleString("en-US")} URL${
        changed === 1 ? "" : "s"
      } updated to their redirect destinations`;
    case "nothing-to-apply":
      return "Nothing was changed: none of these URLs has a confirmed destination yet, and no single rewrite rule could be derived. Verify some of the pattern first, or approve a rule.";
    case "already-rewritten":
      return "Nothing was changed: these URLs were already rewritten by an earlier fix, so none of them matched. The counts on this pattern are from before that fix — re-analyse the session to see the current URLs.";
    case "rule-matched-nothing":
      return "Nothing was changed: the rule matched no URL in this pattern's files. Check the rule against the confirmed redirects before applying it again.";
    case "no-source-files":
      return "Nothing was changed: no source file for this pattern could be read. It may have been renamed or removed since the pattern was extracted.";
  }
}
