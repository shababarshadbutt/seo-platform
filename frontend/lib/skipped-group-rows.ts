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
  | { kind: "measured"; summary: string }
  // Asserted by a human. Deliberately a SEPARATE kind rather than a flag on
  // "measured": migration 051 spent two releases restoring the difference
  // between fetched, inferred, and — since v1.84 — asserted, and a UI that
  // renders all three the same way would quietly undo that.
  | { kind: "operator"; summary: string };

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
  applicable: boolean;
};

// The house phrasing for a rule, matching what the Fix modal's candidate list
// already shows so the same rule never reads two ways in one session.
export function describeRule(rule: {
  kind: string;
  find?: string;
  replace?: string;
  prefix?: string;
  insert?: string;
}): string {
  return rule.kind === "replace"
    ? `replace "${rule.find}" with "${rule.replace}"`
    : `insert "${rule.insert}" after "${rule.prefix}"`;
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
      applicable: rule.kind !== "none"
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

// Why "Apply selected" is disabled, in words, or null when it is enabled.
//
// A DISABLED BUTTON THAT DOES NOT SAY WHY is the thing this replaces: the
// operator in the reported session was already looking at a dialog that would
// not act and would not explain itself.
export function applyBlockedReason(
  rows: readonly SkippedGroupRow[],
  selected: ReadonlySet<string>
): string | null {
  if (selected.size === 0) {
    return "Tick a group to apply it.";
  }

  const unresolved = rows.filter(
    (row) => selected.has(row.shape) && !row.applicable
  );

  if (unresolved.length === 0) {
    return null;
  }

  return unresolved.length === 1
    ? "One selected group has no rule yet — check it, or set the result from its examples."
    : `${unresolved.length} selected groups have no rule yet — check them, or set the result from their examples.`;
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
