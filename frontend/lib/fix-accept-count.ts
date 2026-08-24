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
//
// AN APPROVED RULE IS NOT A PATTERN-WIDE RULE (v1.76, correcting v1.71).
//
// v1.71 let a ticked shortlist rule return the pattern total, reasoning that "a
// rule is a pure per-URL transform, so it reaches every matching URL exactly as a
// derived one does". True, and the wrong claim: it reaches every URL it MATCHES,
// and nothing says it matches the pattern. These candidates are literal edits
// distilled from single confirmed pairs, so one can be as specific as
//   replace "/product/safety/rfq/scott-safety/200130-01/9u694/"
// and match exactly one URL.
//
// Production, on the reported 579,034-URL pattern: the button said 579,034, the
// apply — correct as of v1.75, reading all 187 files — rewrote 10, and the
// modal's own rule-impact scan had already measured those 10 two inches above the
// button. Same shape as the v1.66 → v1.68 reversal, so the same rule applies: a
// number goes on that button only if something MEASURED it.
//
// Which is why the reach of ticked rules arrives here as a measurement
// (approvedRuleImpact, from redirect-rule-impact's population scan) or as null,
// and never as an assumption. Null is not treated as zero-with-a-shrug: it makes
// fixAcceptLimit report "rules-uncounted", and the modal blocks Accept on it.
//
// The DERIVED-rule case (inferredWithoutRule === false, the server distilled one
// rule that reproduces every confirmed pair) is deliberately left as v1.53 wrote
// it — it can overclaim the same way and is not yet measured. That is a known gap,
// not an oversight.

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
  // Shortlist rules the operator ticked (v1.76). Needed as its own input because
  // "ticked but not counted yet" and "nothing ticked" produce the same
  // approvedRuleImpact and must not produce the same button.
  approvedRuleCount?: number;
  // MEASURED URLs those ticked rules would rewrite across the in-scope
  // population, from redirect-rule-impact. null = not counted yet — an unknown,
  // which is what fixAcceptLimit reports and the modal refuses to accept on.
  approvedRuleImpact?: number | null;
};

// Have ticked rules been measured? Ticking is the operator's intent; only the
// population scan turns it into a number, and only a number may reach the button.
function approvedRuleReach(input: ScopeInput): number | null {
  if ((input.approvedRuleCount ?? 0) === 0) {
    return 0;
  }

  return input.approvedRuleImpact ?? null;
}

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

  // Pressed. With a DERIVED rule — one the server distilled from every confirmed
  // pair — the transform is taken to reach every occurrence in scope; with no
  // rule it reaches exactly the URLs whose destination is confirmed, plus
  // whatever a measured rule or per-shape rule adds below. Capped at the scope
  // total for the defensive case where a separately-fetched number exceeds it
  // (over-reporting is the direction that lies).
  if (!input.inferredWithoutRule) {
    return input.fixPatternTotal;
  }

  // No whole-pattern rule. Measured URLs plus whatever a trusted per-shape rule
  // reaches — both real, and both clamped to the scope for the defensive case
  // where separately-fetched numbers disagree. Over-reporting is the direction
  // that lies, so it is the one that gets clamped.
  const withoutRules =
    input.confirmedRedirectCount + (input.shapeExtrapolatedCount ?? 0);
  // MAX, not a sum (v1.76). The rewrite resolves each <loc> by precedence —
  // exclusion, then a confirmed destination, then the ticked rules, then a
  // per-shape rule — so its true reach is a UNION whose overlap nothing here
  // measures. Each term is a real lower bound on that union; adding them would
  // over-report by however much they overlap, which is the direction this module
  // exists to prevent. An uncounted tick contributes nothing rather than a guess.
  const reachable = Math.max(withoutRules, approvedRuleReach(input) ?? 0);

  return Math.min(reachable, input.fixPatternTotal);
}

// WHY the Accept count falls short of the scope, for the caption under the toggle
// and for the gate on the button itself.
//
//   "none"            → the count already is the whole scope; nothing to qualify.
//   "confirmed"       → only URLs with a fetched destination can be rewritten.
//                       Verifying more of the pattern raises the count.
//   "rules"           → the ticked rules were measured and they change part of
//                       the scope. Ticking more rules raises the count.
//   "rules-uncounted" → rules are ticked and NOBODY KNOWS how many URLs they
//                       reach. The modal blocks Accept on this: the whole lesson
//                       of v1.68 and v1.76 is that this state must not be
//                       rendered as a number.
export type FixAcceptLimit = "none" | "confirmed" | "rules" | "rules-uncounted";

export function fixAcceptLimit(
  input: ScopeInput & { fixCount: number }
): FixAcceptLimit {
  // A released toggle only ever touches the rows on screen, so its count is the
  // selection and there is no shortfall to explain.
  if (!appliesPatternWide(input) || !input.inferredWithoutRule) {
    return "none";
  }

  // Checked before the uncounted gate: when every URL in the scope already has a
  // fetched destination the button is fully honest whatever the ticked rules add,
  // and blocking on a scan that cannot change the number would be pure friction.
  if (fixAcceptCount(input) >= input.fixPatternTotal) {
    return "none";
  }

  const reach = approvedRuleReach(input);

  if (reach === null) {
    return "rules-uncounted";
  }

  // Which fact to state is decided by which term the count came from — the same
  // max() the count uses, so the caption can never explain a number the button
  // did not print. A TIE goes to the rules: a rule distilled from the confirmed
  // pairs often matches exactly them, and "tick more rules, or verify more" is
  // the more complete of the two next steps.
  const withoutRules =
    input.confirmedRedirectCount + (input.shapeExtrapolatedCount ?? 0);

  return (input.approvedRuleCount ?? 0) > 0 && reach >= withoutRules
    ? "rules"
    : "confirmed";
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

  // And not when the count came from the ticked rules (v1.76): this pair names
  // the confirmed/per-shape halves of a DIFFERENT number, and printing it beside
  // a rules-derived count would explain the button with figures that do not add
  // up to it — the exact class of contradiction this module was extracted to end.
  const limit = fixAcceptLimit(input);

  if (limit === "rules" || limit === "rules-uncounted") {
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
//   "scope-rules"   → amber: accept targets the whole pattern and the operator's
//                     ticked rules rewrite part of it. Distinct from
//                     "scope-limited" because that banner's advice ("verify more
//                     of the pattern") answers a different question than the one
//                     an operator holding a partial rule is asking. (v1.76)
//   "scope-limited" → amber: accept targets the whole pattern, but no single
//                     rule could be inferred, so only the reviewed rows can be
//                     rewritten yet. States both facts instead of picking one.
//   "no-rule"       → amber: the toggle is released, so only the reviewed rows
//                     are listed and only they are targeted.
//   null            → nothing to qualify.
export type FixModalBanner =
  | "scope"
  | "scope-rules"
  | "scope-limited"
  | "no-rule"
  | null;

export function fixModalBanner(input: ScopeInput): FixModalBanner {
  if (appliesPatternWide(input)) {
    if (!input.inferredWithoutRule) {
      return "scope";
    }

    return (input.approvedRuleCount ?? 0) > 0 ? "scope-rules" : "scope-limited";
  }

  return input.inferredWithoutRule ? "no-rule" : null;
}
