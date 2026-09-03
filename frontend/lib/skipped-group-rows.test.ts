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

  const { unresolved, answered } = partitionSkippedGroupRows(rows);

  assert.deepEqual(
    answered.map((row) => row.shape),
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
  const { answered } = partitionSkippedGroupRows(rows);

  assert.equal(
    answered.length,
    rows.filter((row) => row.applicable).length
  );
});

test("a measured-but-unagreed group counts as unanswered", () => {
  // buildSkippedGroupRows only ever sees agreed rules — the dialog drops the rest
  // before building rows — so a group with no usable rule must sit on the
  // outstanding side however much is known about it. The apply skips unagreed
  // rows, and a row the apply will skip is not an answer.
  const rows = buildSkippedGroupRows([shape()], noRules);
  const { unresolved, answered } = partitionSkippedGroupRows(rows);

  assert.equal(unresolved.length, 1);
  assert.equal(answered.length, 0);
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

test("it counts as ANSWERED, alongside the groups that carry a rule", () => {
  // v1.87 gave it a third pile; v1.89 folds it into "already answered", which is
  // the section the dialog already had. Somebody looked and decided, so it is an
  // answer — the answer just happens to be that nothing should happen.
  const rows = markedRows([shape({ shape: "/b/b-99/", count: 5 })]);
  const { unresolved, answered } = partitionSkippedGroupRows(rows);

  assert.deepEqual(answered.map((row) => row.shape), ["/a/a-9999/"]);
  assert.deepEqual(unresolved.map((row) => row.shape), ["/b/b-99/"]);
});

test("but it is still NOT applicable, so Apply leaves it alone", () => {
  // THE LOAD-BEARING DISTINCTION, and the reason folding the piles is safe.
  // "Answered" is a display grouping; `applicable` is what the apply acts on. If
  // merging the two piles had merged these two questions, a group somebody marked
  // as already-correct would have been counted into "Will fix N URLs" and then
  // rewritten — approving a change nobody asked for.
  const rows = markedRows([shape({ shape: "/b/b-99/", count: 5 })]);
  const { answered } = partitionSkippedGroupRows(rows);

  assert.equal(answered[0].rule.kind, "no-change");
  assert.equal(answered[0].applicable, false);
  assert.equal(describeApplyScope(rows), "Will fix 0 URLs across 0 groups.");
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

test("the header says nothing extra about what was marked", () => {
  // v1.87 appended "30 of them are in groups you marked as already correct"; v1.89
  // takes that back out. The count was always honest and still is — those URLs
  // genuinely were not rewritten — it just is not annotated.
  const rows = markedRows([shape({ shape: "/b/b-99/", count: 15 })]);
  const summary = unresolvedSummary({ skippedInScope: 45, rows });

  assert.equal(
    summary,
    "45 URLs in this pattern are still unfixed. The 2 biggest groups the last fix could not reach are listed below."
  );
  assert.ok(!summary.includes("marked"));
});

test("and the singular form reads correctly", () => {
  const rows = buildSkippedGroupRows([shape({ count: 45 })], noRules);

  assert.equal(
    unresolvedSummary({ skippedInScope: 45, rows }),
    "45 URLs in this pattern are still unfixed. The one group the last fix could not reach is listed below."
  );
});


// ---------------------------------------------------------------------------
// Seeded from the Fix modal's unagreed groups, before any apply (v1.88)
// ---------------------------------------------------------------------------
//
// The dialog's other door hands it an apply's shortfall report. This one hands it
// `unagreed_shapes` from the redirect-candidates endpoint, which is what makes the
// review reachable on a pattern where Accept is disabled and no apply can run at
// all. That payload knows a group's population and one example, and knows nothing
// about file counts or a pattern-wide total — so these pin that the row model says
// nothing it was not told.

const fromUnagreed = (population: number, example: string | null) =>
  buildSkippedGroupRows(
    [
      {
        shape: "/a/a-9999/",
        count: population,
        example: example ?? "/a/a-9999/",
        examples: example ? [example] : [],
        files: undefined
      }
    ],
    noRules
  );

test("with no file count known, reach reports URLs alone", () => {
  // files is absent from unagreed_shapes. buildSkippedGroupRows maps that to null
  // rather than 0 precisely so nothing claims the group spans no files.
  const [row] = fromUnagreed(40050, "https://x.test/a/b-1/");

  assert.equal(row.files, null);
  assert.equal(describeReach(row), "40,050 URLs");
});

test("with no pattern-wide total, the header claims no total", () => {
  // skippedInScope is null from this door: these are the unagreed groups, not the
  // whole shortfall an apply would report. Summing the rows to fill the gap would
  // invent a number and imply the list is exhaustive.
  const rows = fromUnagreed(40050, "https://x.test/a/b-1/");

  const summary = unresolvedSummary({ skippedInScope: null, rows });

  assert.equal(
    summary,
    "The one group the last fix could not reach is listed below."
  );
  assert.ok(!summary.includes("40,050"));
});

test("a group can still be left as it is with only one example", () => {
  // The point of this door. Marking derives no rule and needs no examples, so the
  // thin payload is no obstacle — which is why "Leave as it is" is fully usable
  // here even though "Set the result" has a single pair to reason from.
  const rows = buildSkippedGroupRows(
    [
      {
        shape: "/a/a-9999/",
        count: 40050,
        example: "https://x.test/a/b-1/",
        examples: ["https://x.test/a/b-1/"]
      }
    ],
    new Map<string, ShapeRuleState>([["/a/a-9999/", { kind: "no-change" }]])
  );
  const { unresolved, answered } = partitionSkippedGroupRows(rows);

  assert.deepEqual(unresolved, []);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].applicable, false);
});

test("a group with no example at all still renders from its shape", () => {
  // `example` is null when no row on the review page happened to carry that shape.
  // The shape is the only honest fallback, and a row that cannot render is worse
  // than one identified by its pattern.
  const [row] = fromUnagreed(12, null);

  // buildSkippedGroupRows falls back to `example` when `examples` is empty, and
  // the caller sets `example` to the shape in that case — so the editor still has
  // one line to work from rather than none, and the row is identified by its
  // pattern instead of blank.
  assert.deepEqual(row.examples, ["/a/a-9999/"]);
  assert.equal(describeReach(row), "12 URLs");
});

// THE PATTERN-WIDE ANSWER, IN WORDS (v1.90).
//
// WHY THE COPY NEEDED CHANGING AT ALL. The footer counts the resolved groups on
// screen, which was the honest answer while a group was the only thing anyone
// could answer. A pattern-wide rule reaches every URL of the pattern nothing else
// covers — including the thousands of groups a 25-row report never listed — so the
// group arithmetic would quote 74,329 for an apply about to reach 8,034,847.
// Under-quoting a button this wide is the same class of wrong as over-quoting it,
// and it is the failure this feature keeps having to fix.

test("with a pattern rule the footer counts the pattern, not the rows", () => {
  const rows = buildSkippedGroupRows(
    [{ shape: "/a/a-9/", count: 3088, example: "https://x.test/a/a-1/" }],
    new Map()
  );

  assert.equal(
    describeApplyScope(rows, true, 8_034_847),
    "Will fix all 8,034,847 remaining URLs in this pattern."
  );
});

test("without a pattern rule the footer is unchanged", () => {
  // The pre-v1.90 sentence, pinned: the new arguments default to "no pattern
  // rule", so every existing caller keeps the answer it had.
  const rows = buildSkippedGroupRows(
    [
      { shape: "/a/a-9/", count: 100, example: "https://x.test/a/a-1/" },
      { shape: "/a/a-99/", count: 20, example: "https://x.test/a/a-11/" }
    ],
    new Map([["/a/a-9/", { kind: "operator", summary: "replace" } as const]])
  );

  assert.equal(describeApplyScope(rows), "Will fix 100 URLs across 1 group.");
});

test("an unknown remainder drops the figure rather than inventing one", () => {
  // skippedInScope is null on an older backend and while a queued apply is still
  // running. Quoting 0, or summing the rows instead, would both be claims nothing
  // measured — which is precisely what v1.81 exists to stop.
  assert.equal(
    describeApplyScope([], true, null),
    "Will fix every remaining URL in this pattern."
  );
});

test("a pattern rule alone is enough to enable Apply", () => {
  // The groups on screen may all be unanswered and the apply still has the widest
  // instruction it can be given. Blocking here would disable the button on the one
  // state that can finish the pattern.
  const rows = buildSkippedGroupRows(
    [{ shape: "/a/a-9/", count: 3088, example: "https://x.test/a/a-1/" }],
    new Map()
  );

  assert.equal(applyBlockedReason(rows), "No group has a rule yet — set the result for one from its examples.");
  assert.equal(applyBlockedReason(rows, true), null);
});

test("a fresh pattern rule silences the per-group may-not-fit caveat", () => {
  // That caveat means "a rule was in place, an apply ran, and this group came back
  // anyway". A pattern rule saved AFTER the residue was measured means nothing has
  // run against the group's real situation yet, so repeating the caveat would send
  // the operator to re-edit a rule whose failure is no longer the live question —
  // the same wasted loop the caveat was written to end, from the other side.
  const row = buildSkippedGroupRows(
    [{ shape: "/a/a-9/", count: 10, example: "https://x.test/a/a-1/" }],
    new Map([
      [
        "/a/a-9/",
        {
          kind: "operator",
          summary: "replace",
          authoredAt: "2026-08-31T10:00:00.000Z"
        } as const
      ]
    ])
  )[0];
  const measuredAt = "2026-08-31T11:00:00.000Z";

  // Rule predates the measurement, no pattern rule: the caveat stands.
  assert.ok(describeUnmatchedRule(row, measuredAt));
  // A pattern rule saved after the measurement: nothing has been tried with it.
  assert.equal(
    describeUnmatchedRule(row, measuredAt, "2026-08-31T11:30:00.000Z"),
    null
  );
  // A pattern rule that ALSO predates the measurement has had its chance, so the
  // caveat is still the honest thing to say.
  assert.ok(describeUnmatchedRule(row, measuredAt, "2026-08-31T09:00:00.000Z"));
});

// --- describeRule across every kind ----------------------------------------

// THE REGRESSION THIS FILE EXISTS TO PREVENT. describeRule used to be
// `kind === "replace" ? ... : insert ...`, so any kind that was not "replace" was
// described as an insert. Adding normalizeDigits made it render
// `insert "undefined" after "undefined"` beside the checkbox that applies the rule
// — a wrong description of a real sitemap edit. Every kind is asserted here so the
// next one added cannot slip through the same gap.
test("describeRule words every rule kind, and never falls through to insert", () => {
  assert.equal(
    describeRule({ kind: "replace", find: "-catalog", replace: "" }),
    'replace "-catalog" with ""'
  );
  assert.equal(
    describeRule({ kind: "insert", prefix: "https://s.com/", insert: "aviation/" }),
    'insert "aviation/" after "https://s.com/"'
  );
  assert.equal(
    describeRule({ kind: "normalizeDigits", dropZeroTokens: false }),
    "remove leading zeros from numbers"
  );
  assert.equal(
    describeRule({ kind: "normalizeDigits", dropZeroTokens: true }),
    'remove leading zeros from numbers, and drop a number left as "0"'
  );
});

// An unknown kind must not be described as an insert either. Echoing the kind is
// unhelpful but honest; claiming it inserts something is not.
test("an unrecognised rule kind is not described as an insert", () => {
  const described = describeRule({ kind: "somethingNew" });

  assert.ok(!described.includes("undefined"), described);
  assert.ok(!described.startsWith("insert"), described);
});
