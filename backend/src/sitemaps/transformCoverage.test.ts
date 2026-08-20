import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseStructure } from "./transformStructure.js";
import {
  isLowCoverage,
  LOW_COVERAGE_RATIO,
  lowCoverageMessage,
  measureTransformCoverage
} from "./transformCoverage.js";

const CURRENT = parseStructure("/nsn/{A}/");

const POOL = [
  "nsn-parts-10004",
  "nsn-parts-10007",
  "nsn-parts-1004",
  "nsn-parts-10062",
  "nsn-parts-10154",
  "nsn-parts-10195",
  "nsn-parts-10285"
].map((value) => `https://www.asap-distribution.com/nsn/${value}/`);

// The server half of the gate. The client warns as the user types; this refuses
// the write, because the endpoint re-infers and applies on its own and a warning
// nobody enforces is decoration.

test("the reported rule is refused", () => {
  // Exactly what inferNewStructure produces from the single example
  // nsn-parts-10004 -> nsn-parts/page-1-4: a needle carrying the example's own
  // digits, so five of seven URLs keep their value AND gain the new segment.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-1000|page-1-|}/");
  const verdict = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(verdict.matched, 7);
  assert.equal(verdict.transformed, 2);
  assert.equal(verdict.untransformed, 5);
  assert.equal(isLowCoverage(verdict), true);
  // The message has to quote a real output, or "2 of 7" is an abstraction.
  assert.match(
    lowCoverageMessage(verdict),
    /nsn-parts\/nsn-parts-1004/,
    lowCoverageMessage(verdict)
  );
  assert.match(lowCoverageMessage(verdict), /force_low_coverage/);
});

test("a rule that generalises is allowed", () => {
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-|}/");
  const verdict = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(verdict.transformed, 7);
  assert.equal(isLowCoverage(verdict), false);
});

test("a pure re-parent is allowed", () => {
  // /nsn/{A}/ -> /nsn/nsn-parts/{A}/ changes no value BY DESIGN. Refusing it
  // would block a valid, common edit, which is the false positive that matters
  // most here — this gate returns 400, it does not merely warn.
  const next = parseStructure("/nsn/nsn-parts/{A}/");
  const verdict = measureTransformCoverage(POOL, CURRENT, next);

  assert.equal(verdict.expectsValueChange, false);
  assert.equal(isLowCoverage(verdict), false);
});

test("an empty pool cannot refuse an apply", () => {
  // A pattern whose pool failed to load must not become unfixable.
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-|}/");

  assert.equal(
    isLowCoverage(measureTransformCoverage([], CURRENT, next)),
    false
  );
});

test("URLs of another shape neither help nor hurt", () => {
  const next = parseStructure("/nsn/nsn-parts/{A|nsn-parts-|}/");
  const verdict = measureTransformCoverage(
    [...POOL, "https://www.asap-distribution.com/other/a/b/"],
    CURRENT,
    next
  );

  assert.equal(verdict.matched, 7);
  assert.equal(verdict.transformed, 7);
});

test("the client and server thresholds agree", () => {
  // Both halves must draw the line in the same place. A rule the modal shows as
  // acceptable and the API then rejects is a dead end with no explanation on
  // screen; a rule the modal blocks and the API accepts makes the warning a lie.
  //
  // Compared by reading the FRONTEND SOURCE rather than by asserting a literal
  // here: a literal only pins this copy, and the drift that matters is between
  // the two. Same approach as the transform-structure mirror guard.
  // ESM here, so __dirname does not exist (the frontend's copy of this trick
  // runs under a CJS-flavoured transform and can use it directly).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const frontendSource = readFileSync(
    path.join(
      here,
      "..",
      "..",
      "..",
      "frontend",
      "lib",
      "transform-coverage.ts"
    ),
    "utf8"
  );
  const match = frontendSource.match(
    /export const LOW_COVERAGE_RATIO = ([0-9.]+);/
  );

  assert.ok(match, "LOW_COVERAGE_RATIO not found in the frontend copy");
  assert.equal(
    Number(match![1]),
    LOW_COVERAGE_RATIO,
    "frontend and backend coverage thresholds have drifted"
  );
});
