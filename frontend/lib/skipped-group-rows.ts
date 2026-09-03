// The Review-unfixed-groups dialog, as data (v1.84).
//
// WHAT THIS IS FOR. v1.81 taught the fix report to say WHICH URLs it left
// behind: on the reported session, "8 of 10,427,507 URLs updated" followed by
// the biggest untouched groups. It then offered the operator nothing but
// Dismiss. This module turns those groups into rows that can be selected,
// explained, and resolved — the state and the wording, kept out of the JSX so
// both are testable and so the dialog and the toast cannot drift apart.
//
// WRITTEN FOR SEO OPERATORS, NOT ENGINEERS. Two consequences run through the
// whole file:
//
//   * the EXAMPLE PAIR is the explanation. Someone confirms a rewrite by
//     reading "this URL now → this URL after" on a URL they recognise, never by
//     reading {kind:'replace',find:'-',replace:'/'}. The rule text exists, but
//     it is secondary and it is phrased the way the rest of the app already
//     phrases it;
//   * nothing here asks anyone to type a rule. They edit the examples; the
//     server distils the rule from the pairs with the same deriveRedirectRule a
//     probe would use. The Advanced escape hatch stays for whoever wants it.
import type { SkippedShape } from "./api";

export type ShapeRuleState =
  | { kind: "none" }
  // Distilled from a stratified probe of this group.
  | { kind: "measured"; summary: string; authoredAt?: string | null }
  // Asserted by a human. Deliberately a SEPARATE kind rather than a flag on
  // "measured": migration 051 spent two releases restoring the difference
  // between fetched, inferred, and — since v1.84 — asserted, and a UI that
  // renders all three the same way would quietly undo that.
  //
  // authoredAt is WHEN, and it is load-bearing rather than decorative: it is the
  // only way to tell a rule that an apply has already tried and failed to match
  // from one saved thirty seconds ago that nothing has run against yet. See
  // describeUnmatchedRule.
  | { kind: "operator"; summary: string; authoredAt?: string | null }
  // Asserted by a human that this group needs NO rewrite — its URLs are already
  // correct (v1.87). A FOURTH kind for the same reason there are three: it is not
  // "none" (somebody looked, and decided), and it is not a rule (there is nothing
  // to apply). Collapsing it into either is what left an already-correct group
  // sitting under "still needs an answer" pass after pass.
  | { kind: "no-change"; authoredAt?: string | null };

export type SkippedGroupRow = {
  shape: string;
  urls: number;
  files: number | null;
  // Real URLs of this group, for the editor. Never empty in practice; empty is
  // tolerated so a response from an older backend still renders a row.
  examples: string[];
  rule: ShapeRuleState;
  // Can this row be included in "Apply selected"? Only with a rule behind it —
  // applying a group nobody has resolved would rewrite nothing and report
  // success, which is the failure v1.81 exists to make impossible.
  //
  // A "no-change" group is therefore NOT applicable (v1.87), and that is the
  // point: it has been answered, but the answer is "do nothing". Everything
  // keyed on `applicable` — the Apply footer, the blocked reason — then treats it
  // correctly with no changes of their own.
  applicable: boolean;
};

// The house phrasing for a rule, matching what the Fix modal's candidate list
// already shows so the same rule never reads two ways in one session.
//
// IT IS A SWITCH, NOT A TERNARY, AND THAT MATTERS. Both this function and the Fix
// modal's candidate list used to read `kind === "replace" ? ... : insert ...`,
// which treats "anything that is not replace" as an insert. When the
// normalizeDigits kind was added, that made both render
// `insert "undefined" after "undefined"` — an operator ticking a checkbox whose
// description was silently wrong about what it would do to their sitemap. A
// switch with an explicit default forces the next kind to be handled too.
export function describeRule(rule: {
  kind: string;
  find?: string;
  replace?: string;
  prefix?: string;
  insert?: string;
  dropZeroTokens?: boolean;
}): string {
  switch (rule.kind) {
    case "replace":
      return `replace "${rule.find}" with "${rule.replace}"`;
    case "insert":
      return `insert "${rule.insert}" after "${rule.prefix}"`;
    case "normalizeDigits":
      // Said in the operator's terms, not the code's. "leading zeros" is the
      // phrase the SEO team already uses for this migration.
      return rule.dropZeroTokens
        ? 'remove leading zeros from numbers, and drop a number left as "0"'
        : "remove leading zeros from numbers";
    default:
      return rule.kind;
  }
}

export function buildSkippedGroupRows(
  shapes: readonly SkippedShape[],
  rulesByShape: ReadonlyMap<string, ShapeRuleState>
): SkippedGroupRow[] {
  return shapes.map((shape) => {
    const rule = rulesByShape.get(shape.shape) ?? { kind: "none" as const };

    return {
      shape: shape.shape,
      urls: shape.count,
      // null, not 0: an older backend that does not send this must show nothing
      // rather than claim the group spans no files at all.
      files: typeof shape.files === "number" ? shape.files : null,
      examples:
        shape.examples && shape.examples.length > 0
          ? shape.examples
          : shape.example
            ? [shape.example]
            : [],
      rule,
      applicable: rule.kind === "measured" || rule.kind === "operator"
    };
  });
}

// What the row says under "Affects". Plain, and it never hides the files number
// behind a hover: the URL count alone does not convey what approving a wrong
// rule would cost.
export function describeReach(row: SkippedGroupRow): string {
  const urls = `${row.urls.toLocaleString("en-US")} URL${row.urls === 1 ? "" : "s"}`;

  if (row.files === null) {
    return urls;
  }

  return `${urls} · ${row.files.toLocaleString("en-US")} file${
    row.files === 1 ? "" : "s"
  }`;
}

// Why Apply is disabled, in words, or null when it is enabled.
//
// A DISABLED BUTTON THAT DOES NOT SAY WHY is the thing this replaces: the
// operator in the reported session was looking at a dialog that would not act
// and would not explain itself.
//
// IT KEYS ON WHAT THE APPLY ACTUALLY COVERS (v1.85), which is every group that
// has a rule — not the ticked ones. The first version blocked while any TICKED
// group was unresolved, so ticking all 24 to look at them disabled the button
// even though one group was ready to go, and the message told the operator to
// resolve 23 more. Selection chooses what an edit is SAVED for; the apply then
// rewrites everything resolved, and the footer below says so rather than leaving
// it to be discovered.
// A PATTERN-WIDE RULE IS ALSO A REASON APPLY IS READY (v1.90). It covers every
// URL of the pattern that no group's own answer covers, which is strictly more
// than any single group — so blocking on "no group has a rule" while one is set
// would disable the button on the one state that can finish the pattern.
export function applyBlockedReason(
  rows: readonly SkippedGroupRow[],
  hasPatternRule = false
): string | null {
  return hasPatternRule || rows.some((row) => row.applicable)
    ? null
    : "No group has a rule yet — set the result for one from its examples.";
}

// What Apply will do, for the footer. Counts every RESOLVED group, because that
// is what the apply covers.
//
// WITH A PATTERN-WIDE RULE SET, THE GROUP ARITHMETIC IS THE WRONG ANSWER (v1.90).
// The rule reaches every URL of the pattern nothing else covers — including the
// thousands of groups that were never listed — so summing the rows on screen
// would quote a number an order of magnitude below what the apply is about to do.
// `skippedInScope` is the last full scan's own count of what is left, which is
// exactly the population that rule is aimed at, so that is the number reported.
//
// Null when unknown (an older backend, or a queued apply not yet landed): then
// the sentence drops the figure rather than inventing one.
export function describeApplyScope(
  rows: readonly SkippedGroupRow[],
  hasPatternRule = false,
  skippedInScope: number | null = null
): string {
  if (hasPatternRule) {
    return skippedInScope === null
      ? "Will fix every remaining URL in this pattern."
      : `Will fix all ${skippedInScope.toLocaleString("en-US")} remaining URL${
          skippedInScope === 1 ? "" : "s"
        } in this pattern.`;
  }

  const resolved = rows.filter((row) => row.applicable);
  const urls = resolved.reduce((total, row) => total + row.urls, 0);

  return `Will fix ${urls.toLocaleString("en-US")} URL${
    urls === 1 ? "" : "s"
  } across ${resolved.length} group${resolved.length === 1 ? "" : "s"}.`;
}

// STILL OUTSTANDING vs ALREADY ANSWERED (v1.86).
//
// WHAT WAS WRONG. Every group the last apply declined came back as one flat list
// with no memory of what had been said about it, because nothing read the saved
// rules back. So the second pass looked exactly like the first: the operator could
// not see which groups they had already resolved, "select every group" ticked the
// answered ones too, and a bulk save then overwrote answers that were already
// right.
//
// It is worse than redundant work, because of the trade-off the save endpoint
// documents: a rule is stored for every shape asked for WITHOUT checking that it
// transforms each one, so a group the rule cannot match REAPPEARS in the next
// coverage report with its count intact. Indistinguishable from an unanswered
// group, that is a loop — retype the rule, apply, see the group again, retype it.
// Splitting the two is what makes a second pass about the remainder.
//
// STILL TWO PILES, and a "leave it alone" mark belongs in the second (v1.89).
// v1.87 gave such a group a third pile of its own; the operator asked for the two
// they already had. It is an ANSWER — somebody looked and decided — so "already
// answered" is where it goes, and the dialog needs no new section to say so.
//
// THE ONE THING THAT MUST NOT FOLLOW FROM THAT: it is answered but NOT applicable.
// `applicable` is what the Apply footer and its blocked reason key on, so a marked
// group is still never counted into "Will fix N URLs" and never rewritten. Whether
// a group has been dealt with and whether the next apply should touch it are two
// questions, and this function is deliberately the only place that maps one to the
// other.
export function partitionSkippedGroupRows(rows: readonly SkippedGroupRow[]): {
  unresolved: SkippedGroupRow[];
  answered: SkippedGroupRow[];
} {
  const unresolved: SkippedGroupRow[] = [];
  const answered: SkippedGroupRow[] = [];

  for (const row of rows) {
    if (row.applicable || row.rule.kind === "no-change") {
      answered.push(row);
    } else {
      unresolved.push(row);
    }
  }

  return { unresolved, answered };
}

// The header line: how much is STILL unfixed, and whether this list is all of it.
//
// The count comes from the apply's own skippedInScope rather than from summing the
// rows, and the difference matters: the backend caps the histogram at the 25
// biggest groups (SKIPPED_SHAPE_LIMIT), so adding up what is on screen would
// under-report the remainder and quietly imply the list is exhaustive. That is the
// class of claim v1.81 exists to stop making.
export function unresolvedSummary(input: {
  skippedInScope: number | null;
  rows: readonly SkippedGroupRow[];
  shapesTruncated?: boolean;
}): string {
  const listed = `The ${input.rows.length === 1 ? "one group" : `${input.rows.length} biggest groups`} the last fix could not reach ${input.rows.length === 1 ? "is" : "are"} listed below`;
  const truncated = input.shapesTruncated
    ? ", and there are more groups than could be listed"
    : "";

  // ONE SENTENCE, and no arithmetic about what was marked (v1.89). v1.87 appended
  // "N of them are in groups you marked as already correct"; the operator asked for
  // the plain v1.86 line back. The count itself was always honest and still is —
  // those URLs genuinely were not rewritten, and shrinking the number to look
  // better is the flattering arithmetic v1.81 exists to prevent.
  if (input.skippedInScope === null) {
    return `${listed}${truncated}.`;
  }

  return `${input.skippedInScope.toLocaleString("en-US")} URL${
    input.skippedInScope === 1 ? "" : "s"
  } in this pattern are still unfixed. ${listed}${truncated}.`;
}

// The caveat for a group that HAS a rule and came back unfixed ANYWAY.
//
// This is the save endpoint's documented trade-off finally saying so on screen. It
// stores a rule for every shape requested without checking it matches each one, on
// the grounds that the next coverage report will catch it — which is true, and
// useless to an operator who cannot see that the group they are looking at is the
// one that already failed. Naming it turns a silent loop into an instruction.
//
// IT MUST NOT FIRE ON A RULE NOTHING HAS RUN AGAINST YET, which is why this takes
// a time and not just a row. A rule saved a moment ago moves the row straight into
// "already answered", and telling the operator right then that "the last fix did
// not change these" would be false — and worse than merely noisy, because it would
// send them back to re-edit a rule that is very likely correct. That is the same
// wasted loop from the other direction.
//
// So the claim is only made when the rule PREDATES the measurement in front of us:
// the rule existed, an apply ran, and the group still came back. `measuredAt` is
// when the residue on screen was measured — the moment of the apply that produced
// it. With either timestamp missing this says nothing, because an unfalsifiable
// claim about which came first is exactly what should not be put on screen.
//
// A "LEAVE AS IT IS" GROUP IS EXCLUDED TOO (v1.87), by the `applicable` guard
// below rather than by a clause of its own. Such a group came back unfixed because
// somebody asked for it to, so telling them "the last fix did not change these"
// would be reporting the intended outcome as a problem. Noting it here because the
// exclusion is a consequence of that predicate rather than something visible on
// the line itself.
export function describeUnmatchedRule(
  row: SkippedGroupRow,
  measuredAt?: string | null,
  // A pattern-wide rule saved AFTER the measurement means every group on screen
  // is about to be re-attempted by something that did not exist when this residue
  // was measured (v1.90). Telling the operator their group rule "may not fit"
  // then sends them to re-edit a rule whose failure is no longer the live
  // question — the same wasted loop this caveat was written to end, from the
  // other direction. Handled by the same authored-vs-measured test, because the
  // claim being made is the same one: did anything actually run against this yet.
  patternRuleAuthoredAt?: string | null
): string | null {
  if (!row.applicable || row.rule.kind === "none") {
    return null;
  }

  const authoredAt = row.rule.authoredAt;

  if (!authoredAt || !measuredAt) {
    return null;
  }

  const authored = Date.parse(authoredAt);
  const measured = Date.parse(measuredAt);

  if (Number.isNaN(authored) || Number.isNaN(measured) || authored >= measured) {
    return null;
  }

  if (patternRuleAuthoredAt) {
    const patternAuthored = Date.parse(patternRuleAuthoredAt);

    if (!Number.isNaN(patternAuthored) && patternAuthored >= measured) {
      return null;
    }
  }

  return "A rule is set, but the last fix did not change these — it may not fit this group. Edit the examples to match what these URLs should become.";
}

// Total URLs the current selection would cover.
//
// Summed from the groups' own counts, which are disjoint by construction:
// valueShape puts every URL in exactly one shape. That is why this can be added
// up while the rule-impact endpoint's per-rule counts cannot — two RULES may
// both match a URL, which is what its `overlapping` field is for.
export function selectedReach(
  rows: readonly SkippedGroupRow[],
  selected: ReadonlySet<string>
): number {
  return rows
    .filter((row) => selected.has(row.shape))
    .reduce((total, row) => total + row.urls, 0);
}
