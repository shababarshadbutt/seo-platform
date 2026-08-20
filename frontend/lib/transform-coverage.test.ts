import { strict as assert } from "node:assert";
import { test } from "node:test";

import { parseStructure } from "./transform-structure";
import {
  isLowCoverage,
  measureTransformCoverage
} from "./transform-coverage";

const CURRENT = parseStructure("/nsn/{A}/");

function urls(...values: string[]) {
  return values.map(
    (value) => `https://www.asap-distribution.com/nsn/${value}/`
  );
}

// The reported pool, verbatim from the screenshot.
const POOL = urls(
  "nsn-parts-10004",
  "nsn-parts-10007",
  "nsn-parts-1004",
  "nsn-parts-10062",
  "nsn-parts-10154",
  "nsn-parts-10195",
  "nsn-parts-10285"
);

test("the reported bug: a needle carrying the example's own digits", () => {
  // This is the exact structure inferNewStructure produces from the single
  // example nsn-parts-10004 -> nsn-parts/page-1-4. Only values beginning
  // "nsn-parts-1000" transform; the rest keep their value AND gain the new
  // static segment, which is the duplication that was reported.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-1000|page-1-|}/");
  const coverage = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(coverage.matched, 7);
  assert.equal(coverage.transformed, 2);
  assert.equal(coverage.untransformed, 5);
  assert.equal(isLowCoverage(coverage), true);
  // The example quotes the OUTPUT, because the duplicated shape is the thing
  // that makes this alarming.
  assert.ok(
    coverage.examples[0].includes("/nsn/nsn-parts/nsn-parts-1004/"),
    `expected a duplicated-segment example, got ${coverage.examples[0]}`
  );
});

test("a rule that generalises is not flagged", () => {
  // Strip the shared prefix instead of an example-specific one: every value in
  // the pool starts "nsn-parts-", so every one transforms.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-|}/");
  const coverage = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(coverage.matched, 7);
  assert.equal(coverage.transformed, 7);
  assert.equal(coverage.untransformed, 0);
  assert.equal(isLowCoverage(coverage), false);
});

test("a pure re-parent is NEVER flagged", () => {
  // /nsn/{A}/ -> /nsn/nsn-parts/{A}/ deliberately changes no value: it only
  // moves the segment. Every URL would report "untransformed" on a naive
  // measurement, so this is the false positive that would have made the gate
  // block a valid, common edit.
  const next = parseStructure("/nsn/nsn-parts/{A}/");
  const coverage = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(coverage.expectsValueChange, false);
  assert.equal(isLowCoverage(coverage), false);
});

test("URLs outside the pattern's shape are not counted against the rule", () => {
  // A rule cannot be blamed for URLs it was never going to match. They must not
  // dilute the ratio in either direction.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-|}/");
  const coverage = measureTransformCoverage(
    [
      ...urls("nsn-parts-10004"),
      "https://www.asap-distribution.com/other/deeper/path/",
      "not even a url"
    ],
    CURRENT,
    next
  );

  assert.equal(coverage.matched, 1);
  assert.equal(coverage.transformed, 1);
  assert.equal(coverage.untransformed, 0);
});

test("an empty pool cannot be low coverage", () => {
  // Nothing measured is not evidence of a bad rule — it would block every edit
  // on a pattern whose pool failed to load.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-|}/");
  const coverage = measureTransformCoverage([], CURRENT, next);

  assert.equal(coverage.matched, 0);
  assert.equal(isLowCoverage(coverage), false);
});

test("one transforming param is enough in a multi-param structure", () => {
  // /a/{A}/{B}/ where only {A} is edited: {B} carrying through untouched is the
  // rule working as written, not a failure.
  const current = parseStructure("/a/{A}/{B}/");
  const next = parseStructure("/a/{A|old|new|}/{B}/");
  const coverage = measureTransformCoverage(
    ["https://site.com/a/old-1/keep-me/"],
    current,
    next
  );

  assert.equal(coverage.transformed, 1);
  assert.equal(coverage.untransformed, 0);
  assert.equal(isLowCoverage(coverage), false);
});

test("a majority-failing rule is flagged even when some succeed", () => {
  // The threshold is a ratio, not "any failure": 1 of 7 transforming means six
  // URLs get a duplicated segment, which is the defect however small the pool.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-10004|page-1-4|}/");
  const coverage = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(coverage.transformed, 1);
  assert.equal(isLowCoverage(coverage), true);
});
