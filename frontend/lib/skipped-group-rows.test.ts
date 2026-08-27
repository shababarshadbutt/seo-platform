import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBlockedReason,
  buildSkippedGroupRows,
  describeApplyScope,
  describeReach,
  describeRule,
  describeUnmatchedRule,
  partitionSkippedGroupRows,
  selectedReach,
  unresolvedSummary,
  type ShapeRuleState
} from "./skipped-group-rows";

const shape = (over: Partial<Parameters<typeof buildSkippedGroupRows>[0][0]> = {}) => ({
  shape: "/a/a-9999/",
  count: 285851,
  example: "https://x.test/rfq/boeing-aircraft/3925812-2/",
  examples: [
    "https://x.test/rfq/boeing-aircraft/3925812-2/",
    "https://x.test/rfq/boeing-aircraft/432-0104-002/"
  ],
  files: 42,
  ...over
});

const noRules = new Map<string, ShapeRuleState>();

test("a group with no rule cannot be applied", () => {
  // The reported state: the report names the group and nothing can act on it.
  const [row] = buildSkippedGroupRows([shape()], noRules);

  assert.equal(row.rule.kind, "none");
  assert.equal(row.applicable, false);
  assert.equal(row.urls, 285851);
  assert.equal(row.files, 42);
});

test("measured and operator rules stay distinguishable", () => {
  // Migration 051 spent two releases restoring the difference between fetched,
  // inferred and asserted. Rendering the last two identically would undo it.
  const rows = buildSkippedGroupRows(
    [shape(), shape({ shape: "/b/b-99/" })],
    new Map<string, ShapeRuleState>([
      ["/a/a-9999/", { kind: "measured", summary: 'replace "x" with "y"' }],
      ["/b/b-99/", { kind: "operator", summary: 'replace "p" with "q"' }]
    ])
  );

  assert.equal(rows[0].rule.kind, "measured");
  assert.equal(rows[1].rule.kind, "operator");
  assert.ok(rows.every((row) => row.applicable));
});

test("reach names the files, because that is the blast radius", () => {
  assert.equal(
    describeReach(buildSkippedGroupRows([shape()], noRules)[0]),
    "285,851 URLs · 42 files"
  );
  // Singulars read like English, not like a template.
  assert.equal(
    describeReach(
      buildSkippedGroupRows([shape({ count: 1, files: 1 })], noRules)[0]
    ),
    "1 URL · 1 file"
  );
});

test("a backend that sends no file count claims nothing", () => {
  // Rather than printing "· 0 files", which would read as a real measurement.
  const [row] = buildSkippedGroupRows(
    [shape({ files: undefined })],
    noRules
  );

  assert.equal(row.files, null);
  assert.equal(describeReach(row), "285,851 URLs");
});

test("examples fall back to the single example when the list is absent", () => {
  const [row] = buildSkippedGroupRows(
    [shape({ examples: undefined })],
    noRules
  );

  assert.deepEqual(row.examples, [
    "https://x.test/rfq/boeing-aircraft/3925812-2/"
  ]);
});

test("Apply is blocked only when NOTHING is resolved, and says why", () => {
  // THE DEAD END THIS REPLACES. The first version blocked while any TICKED group
  // was unresolved, so ticking all 24 groups just to look at them disabled the
  // button — and the message told the operator to go and resolve 23 more, even
  // though one was ready to apply.
  const nothingResolved = buildSkippedGroupRows(
    [shape(), shape({ shape: "/b/b-99/" })],
    noRules
  );

  assert.match(applyBlockedReason(nothingResolved)!, /No group has a rule yet/);

  const oneResolved = buildSkippedGroupRows(
    [shape(), shape({ shape: "/b/b-99/" })],
    new Map<string, ShapeRuleState>([
      ["/b/b-99/", { kind: "operator", summary: "x" }]
    ])
  );

  // One group resolved is enough — selection has nothing to do with it.
  assert.equal(applyBlockedReason(oneResolved), null);
});

test("the footer counts what the apply covers, not what is ticked", () => {
  // The apply picks up every agreed rule for the pattern, so a footer that
  // counted the ticked rows would under- or over-state what is about to change.
  const rows = buildSkippedGroupRows(
    [shape({ count: 40050 }), shape({ shape: "/b/b-99/", count: 13615 })],
    new Map<string, ShapeRuleState>([
      ["/a/a-9999/", { kind: "operator", summary: "x" }]
    ])
  );

  assert.equal(describeApplyScope(rows), "Will fix 40,050 URLs across 1 group.");

  const both = buildSkippedGroupRows(
    [shape({ count: 40050 }), shape({ shape: "/b/b-99/", count: 13615 })],
    new Map<string, ShapeRuleState>([
      ["/a/a-9999/", { kind: "operator", summary: "x" }],
      ["/b/b-99/", { kind: "operator", summary: "x" }]
    ])
  );

  assert.equal(describeApplyScope(both), "Will fix 53,665 URLs across 2 groups.");
});

test("selected reach sums groups, which are disjoint by construction", () => {
  // valueShape puts every URL in exactly one shape, so these add up. Per-RULE
  // counts do not, which is what the impact endpoint's `overlapping` is for.
  const rows = buildSkippedGroupRows(
    [shape({ count: 10 }), shape({ shape: "/b/b-99/", count: 5 })],
    noRules
  );

  assert.equal(selectedReach(rows, new Set(["/a/a-9999/"])), 10);
  assert.equal(selectedReach(rows, new Set(["/a/a-9999/", "/b/b-99/"])), 15);
  assert.equal(selectedReach(rows, new Set()), 0);
});

test("rule wording matches the Fix modal's existing phrasing", () => {
  assert.equal(
    describeRule({ kind: "replace", find: "-", replace: "/" }),
    'replace "-" with "/"'
  );
  assert.equal(
    describeRule({ kind: "insert", prefix: "/rfq", insert: "/parts" }),
    'insert "/parts" after "/rfq"'
  );
});


// ---------------------------------------------------------------------------
// The remainder view (v1.86)
// ---------------------------------------------------------------------------

test("answered groups are separated from the ones still outstanding", () => {
  // The whole point of the second pass. Before this, both came back in one flat
  // list and an operator could not tell which groups they had already resolved.
  const rows = buildSkippedGroupRows(
    [shape({ count: 40050 }), shape({ shape: "/b/b-99/", count: 13615 })],
    new Map<string, ShapeRuleState>([
      ["/a/a-9999/", { kind: "operator", summary: "x" }]
    ])
  );

  const { unresolved, resolved } = partitionSkippedGroupRows(rows);

  assert.deepEqual(
    resolved.map((row) => row.shape),
    ["/a/a-9999/"]
  );
  assert.deepEqual(
    unresolved.map((row) => row.shape),
    ["/b/b-99/"]
  );
});

test("the partition agrees with what the Apply footer counts", () => {
  // Two predicates that must not drift: `applicable` decides both whether a row
  // contributes to the apply and which side of this split it lands on.
  const rows = buildSkippedGroupRows(
    [shape(), shape({ shape: "/b/b-99/" })],
    new Map<string, ShapeRuleState>([
      ["/b/b-99/", { kind: "measured", summary: "x" }]
    ])
  );
  const { resolved } = partitionSkippedGroupRows(rows);

  assert.equal(
    resolved.length,
    rows.filter((row) => row.applicable).length
  );
});

test("a measured-but-unagreed group counts as unanswered", () => {
  // buildSkippedGroupRows only ever sees agreed rules — the dialog drops the rest
  // before building rows — so a group with no usable rule must sit on the
  // outstanding side however much is known about it. The apply skips unagreed
  // rows, and a row the apply will skip is not an answer.
  const rows = buildSkippedGroupRows([shape()], noRules);
  const { unresolved, resolved } = partitionSkippedGroupRows(rows);

  assert.equal(unresolved.length, 1);
  assert.equal(resolved.length, 0);
});

test("the header states the remainder from the apply, not from the rows", () => {
  // The backend caps the histogram at its 25 biggest groups, so summing the rows
  // would under-report the shortfall and imply the list is exhaustive — the exact
  // claim v1.81 exists to stop making.
  const rows = buildSkippedGroupRows([shape({ count: 2836 })], noRules);

  assert.equal(
    unresolvedSummary({ skippedInScope: 10363824, rows }),
    "10,363,824 URLs in this pattern are still unfixed. The one group the last fix could not reach is listed below."
  );
});

test("the header says so when there are more groups than could be listed", () => {
  const rows = buildSkippedGroupRows(
    [shape(), shape({ shape: "/b/b-99/" })],
    noRules
  );

  assert.equal(
    unresolvedSummary({
      skippedInScope: 10363824,
      rows,
      shapesTruncated: true
    }),
    "10,363,824 URLs in this pattern are still unfixed. The 2 biggest groups the last fix could not reach are listed below, and there are more groups than could be listed."
  );
});

test("an unmeasured remainder makes no claim about how many URLs are left", () => {
  // Reopened from the persisted histogram, which carries the groups without a
  // trustworthy total. No number beats a wrong one.
  const rows = buildSkippedGroupRows([shape()], noRules);

  assert.equal(
    unresolvedSummary({ skippedInScope: null, rows }),
    "The one group the last fix could not reach is listed below."
  );
});

const ruledRow = (authoredAt: string | null) =>
  buildSkippedGroupRows(
    [shape()],
    new Map<string, ShapeRuleState>([
      ["/a/a-9999/", { kind: "operator", summary: "x", authoredAt }]
    ])
  )[0];

test("a rule that predates the fix, on a group that came back, says it may not fit", () => {
  // The save endpoint's documented trade-off, finally visible. It stores a rule
  // for every shape asked for without checking it transforms each one, so a group
  // it cannot match reappears with its count intact — and an operator who cannot
  // see that retypes the same failing rule forever.
  assert.match(
    describeUnmatchedRule(
      ruledRow("2026-08-27T10:00:00Z"),
      "2026-08-27T11:00:00Z"
    ) ?? "",
    /did not change these/
  );
});

test("a rule saved SINCE the fix makes no such claim", () => {
  // The false-positive that matters. A rule saved a moment ago moves its row
  // straight into "already answered", and telling the operator right then that
  // the last fix did not change these would be untrue — and would send them back
  // to re-edit a rule that is probably correct. That is the same wasted loop from
  // the other direction.
  assert.equal(
    describeUnmatchedRule(
      ruledRow("2026-08-27T11:30:00Z"),
      "2026-08-27T11:00:00Z"
    ),
    null
  );
});

test("with either timestamp missing, nothing is claimed about which came first", () => {
  // An unfalsifiable claim is exactly what should not go on screen. A sampled rule
  // has no authored_at, and a shortfall reopened from a row that was never stamped
  // has no measurement time.
  assert.equal(
    describeUnmatchedRule(ruledRow(null), "2026-08-27T11:00:00Z"),
    null
  );
  assert.equal(describeUnmatchedRule(ruledRow("2026-08-27T10:00:00Z"), null), null);
  assert.equal(
    describeUnmatchedRule(ruledRow("nonsense"), "2026-08-27T11:00:00Z"),
    null
  );
});

test("a group nobody has answered has no rule to doubt", () => {
  // There is nothing to caveat, and the row already reads "Nothing yet".
  const [unansweredRow] = buildSkippedGroupRows([shape()], noRules);

  assert.equal(
    describeUnmatchedRule(unansweredRow, "2026-08-27T11:00:00Z"),
    null
  );
});


// ---------------------------------------------------------------------------
// "These URLs are already correct — leave them" (v1.87)
// ---------------------------------------------------------------------------

const markedRows = (extra: Parameters<typeof buildSkippedGroupRows>[0] = []) =>
  buildSkippedGroupRows(
    [shape({ count: 30 }), ...extra],
    new Map<string, ShapeRuleState>([
      ["/a/a-9999/", { kind: "no-change", authoredAt: "2026-08-27T10:00:00Z" }]
    ])
  );

test("a group marked leave-as-it-is is answered, but not applicable", () => {
  // Both halves matter. Answered, so it stops sitting under "still needs an
  // answer" pass after pass — the complaint. Not applicable, so nothing counts it
  // into what Apply will fix, because the answer is that nothing should happen.
  const [row] = markedRows();

  assert.equal(row.rule.kind, "no-change");
  assert.equal(row.applicable, false);
});

test("it lands in its own pile, not with the answered or the outstanding", () => {
  const rows = markedRows([shape({ shape: "/b/b-99/", count: 5 })]);
  const { unresolved, resolved, leftAsIs } = partitionSkippedGroupRows(rows);

  assert.deepEqual(leftAsIs.map((row) => row.shape), ["/a/a-9999/"]);
  assert.deepEqual(unresolved.map((row) => row.shape), ["/b/b-99/"]);
  assert.deepEqual(resolved, []);
});

test("Apply ignores it: no URLs, no groups, and still blocked if it is all there is", () => {
  // THE ASSERTION THAT MATTERS MOST. If a marked group leaked into the apply
  // scope, the footer would promise to fix URLs that nobody asked to be touched —
  // the v1.68 overreach this whole area exists to prevent.
  const rows = markedRows();

  assert.equal(describeApplyScope(rows), "Will fix 0 URLs across 0 groups.");
  assert.equal(
    applyBlockedReason(rows),
    "No group has a rule yet — set the result for one from its examples."
  );
});

test("select-all does not tick a group that has been left as it is", () => {
  // Selection chooses what the next edit is saved for, and a settled group has no
  // next edit. Leaving it ticked would quietly fold it into the following bulk
  // save and overwrite the decision.
  const rows = markedRows([shape({ shape: "/b/b-99/", count: 5 })]);
  const { unresolved } = partitionSkippedGroupRows(rows);

  assert.deepEqual(unresolved.map((row) => row.shape), ["/b/b-99/"]);
});

test("a deliberately unchanged group is never accused of a rule that did not fit", () => {
  // It came back unfixed because somebody asked for it to. Reporting the intended
  // outcome as a problem would be the caveat firing on exactly the wrong row.
  const [row] = markedRows();

  assert.equal(describeUnmatchedRule(row, "2026-08-27T11:00:00Z"), null);
});

test("the header keeps the real shortfall and says how much of it is on purpose", () => {
  // The count is NOT reduced: those URLs genuinely were not rewritten, and
  // shrinking the number to look better is the flattering arithmetic v1.81 exists
  // to prevent. It is qualified instead.
  const rows = markedRows([shape({ shape: "/b/b-99/", count: 15 })]);

  assert.equal(
    unresolvedSummary({ skippedInScope: 45, rows }),
    "45 URLs in this pattern are still unfixed. 30 of them are in groups you marked as already correct. The 2 biggest groups the last fix could not reach are listed below."
  );
});

test("with nothing marked the header says nothing about marking", () => {
  const rows = buildSkippedGroupRows([shape({ count: 45 })], noRules);

  assert.equal(
    unresolvedSummary({ skippedInScope: 45, rows }),
    "45 URLs in this pattern are still unfixed. The one group the last fix could not reach is listed below."
  );
});
