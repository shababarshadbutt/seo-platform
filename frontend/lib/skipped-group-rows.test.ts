import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBlockedReason,
  buildSkippedGroupRows,
  describeReach,
  describeRule,
  selectedReach,
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

test("the disabled Apply button explains itself", () => {
  // A dialog that will not act and will not say why is what this replaces.
  const rows = buildSkippedGroupRows(
    [shape(), shape({ shape: "/b/b-99/" })],
    new Map<string, ShapeRuleState>([
      ["/b/b-99/", { kind: "operator", summary: "x" }]
    ])
  );

  assert.equal(applyBlockedReason(rows, new Set()), "Tick a group to apply it.");
  assert.match(
    applyBlockedReason(rows, new Set(["/a/a-9999/"]))!,
    /One selected group has no rule yet/
  );
  assert.equal(applyBlockedReason(rows, new Set(["/b/b-99/"])), null);
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
