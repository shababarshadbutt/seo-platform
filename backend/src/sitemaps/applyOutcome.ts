// Why a redirect fix changed nothing — and, since v1.81, why it changed only
// part of what the operator was looking at.
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
//
// THE SAME BUG ONE STEP OVER (v1.81). Every non-zero count was "applied", so an
// apply that rewrote 12 of 579,034 URLs reported success in the same words as one
// that rewrote all of them, and stamped the same full Fixed chip. That is not a
// rare edge: a URL is only rewritten when a confirmed destination or an agreed
// rewrite rule covers it (see buildRedirectApplyRewriter), and on a pattern that
// mixes several URL families most of the population is covered by neither. The
// reported sessions were exactly this — "it fixed one pattern and missed the
// rest", and "it fixed some URLs and skipped their neighbours" — and in both the
// rewrite did what it is built to do while the report hid the shortfall.

export type ApplyOutcome =
  | "applied"
  // Real work landed, but URLs belonging to this pattern were left unchanged
  // because nothing in the apply covered them (v1.81).
  | "partially-applied"
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
  // <loc>s that matched this pattern's template (and its structure scope) and
  // were left unchanged — MEASURED by applyCoverage during the same streaming
  // pass, not derived from patterns.total_urls (v1.81).
  //
  // WHY MEASURED AND NOT patterns.total_urls, which is the obvious denominator.
  // That column is a weighted extrapolation from the first 500 locs of each file
  // (extractPatternsJob) and it describes the PRE-fix files, so comparing a real
  // rewrite count against it produces a shortfall on a complete apply and hides
  // one on an incomplete apply. The tally counts the same <loc>s the rewriter
  // saw, in the same pass, so "rewrote 12, left 579,022" is two halves of one
  // measurement rather than a measurement divided by an estimate.
  //
  // undefined/null = not measured (an older payload, or a path that does not
  // tally), and the outcome then reads exactly as it did before this existed.
  skippedInScope?: number | null;
}): ApplyOutcome {
  if (input.rewrittenLocCount > 0) {
    // A shortfall is only reportable when it was actually counted. Absent a
    // tally this stays "applied" — silence is what every caller predating v1.81
    // expects, and inventing a denominator here is the mistake the comment on
    // skippedInScope exists to prevent.
    return (input.skippedInScope ?? 0) > 0 ? "partially-applied" : "applied";
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

// Did this apply leave part of its pattern untouched? The one predicate the UI
// and the DB stamp both ask, so "Partly fixed" on the chip and the sentence in
// the toast can never disagree about what partial means.
export function isPartialApply(outcome: ApplyOutcome): boolean {
  return outcome === "partially-applied";
}

// The sentence the operator reads. Written here so the wording travels with the
// classification instead of being rebuilt per call site.
//
// `skipped` is only read for "partially-applied" — the count of URLs this apply
// left alone. Optional so every existing two-argument call keeps compiling and
// keeps its exact wording.
export function applyOutcomeMessage(
  outcome: ApplyOutcome,
  changed: number,
  skipped = 0
): string {
  switch (outcome) {
    case "applied":
      return `${changed.toLocaleString("en-US")} URL${
        changed === 1 ? "" : "s"
      } updated to their redirect destinations`;
    case "partially-applied":
      // Both numbers, and WHY the second one exists. "12 updated" on its own is
      // the sentence that made a 12-of-579,034 apply look finished; the second
      // half is the whole point of the outcome.
      return `${changed.toLocaleString("en-US")} of ${(
        changed + skipped
      ).toLocaleString("en-US")} URLs in this pattern were updated. The other ${skipped.toLocaleString(
        "en-US"
      )} were left unchanged because no confirmed destination and no agreed rewrite rule covers them — see the URL shapes listed below.`;
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
