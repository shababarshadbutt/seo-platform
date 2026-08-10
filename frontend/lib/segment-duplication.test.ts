import { strict as assert } from "node:assert";
import { test } from "node:test";

import { findSegmentDuplication } from "./segment-duplication";
import { parseStructure } from "./transform-structure";

// ---- the reported repro ----------------------------------------------------
// Pattern /nsn/{param}, real values like "niin-parts-503", edited to add a
// "niin-parts" static segment -> ".../nsn/niin-parts/niin-parts-503/".

test("detects the nsn/niin-parts duplication from the screenshot", () => {
  const found = findSegmentDuplication(
    ["https://nsnstocks.com/nsn/niin-parts-503/"],
    parseStructure("/nsn/{A}"),
    parseStructure("/nsn/niin-parts/{A}/")
  );

  assert.ok(found, "the duplication must be detected");
  assert.equal(found.segmentValue, "niin-parts");
  assert.equal(found.paramName, "A");
  assert.equal(found.capturedValue, "niin-parts-503");
  assert.equal(found.anchor, "prefix");
  // Actionable: the separator is swallowed so stripping leaves "503", not "-503".
  assert.equal(found.suggestedParamToken, "{A|niin-parts-|}");
});

test("detects a suffix-anchored duplication too", () => {
  const found = findSegmentDuplication(
    ["https://e.com/manufacturer/square-d-parts-catalog/"],
    parseStructure("/manufacturer/{A}"),
    parseStructure("/manufacturer/{A}/parts-catalog")
  );

  assert.ok(found);
  assert.equal(found.anchor, "suffix");
  assert.equal(found.paramName, "A");
  // Leading separator swallowed: stripping leaves "square-d".
  assert.equal(found.suggestedParamToken, "{A|-parts-catalog|}");
});

// ---- the false-positive constraints ----------------------------------------
// A warning that fires on ordinary edits gets ignored, which makes it worse than
// no warning. These are the cases that must stay silent.

test("silent on an ordinary edit that shares nothing", () => {
  assert.equal(
    findSegmentDuplication(
      ["https://e.com/manufacturer/square-d/page-1"],
      parseStructure("/manufacturer/{A}/{B}"),
      parseStructure("/catalog/{A}/{B}/")
    ),
    null
  );
});

test("silent on a MID-STRING coincidence — anchored, not 'contains'", () => {
  // "parts" appears inside "spare-parts-list" but neither starts nor ends it, so
  // this is a coincidence rather than a repeated prefix/suffix.
  assert.equal(
    findSegmentDuplication(
      ["https://e.com/catalog/spare-parts-list/"],
      parseStructure("/catalog/{A}"),
      parseStructure("/catalog/parts/{A}/")
    ),
    null
  );
});

test("silent on a static shorter than the minimum length", () => {
  // "v2" prefixes "v2-widget" but two characters collide by chance far too often
  // to be evidence of a duplicated segment.
  assert.equal(
    findSegmentDuplication(
      ["https://e.com/catalog/v2-widget/"],
      parseStructure("/catalog/{A}"),
      parseStructure("/catalog/v2/{A}/")
    ),
    null
  );
});

test("silent when the static is NOT adjacent to the param it would repeat", () => {
  // "niin-parts" sits two positions from {A}, so it does not land next to the
  // value it echoes and the "duplicated text" reading does not hold.
  assert.equal(
    findSegmentDuplication(
      ["https://nsnstocks.com/nsn/niin-parts-503/"],
      parseStructure("/nsn/{A}"),
      parseStructure("/niin-parts/nsn/{A}/")
    ),
    null
  );
});

test("silent when the captured value EQUALS the static segment", () => {
  // The value IS the segment — a different situation from a literal repeated
  // inside a longer value, and stripping it would empty the param entirely.
  assert.equal(
    findSegmentDuplication(
      ["https://e.com/catalog/niin-parts/"],
      parseStructure("/catalog/{A}"),
      parseStructure("/catalog/niin-parts/{A}/")
    ),
    null
  );
});

test("silent when no URL matches the current structure", () => {
  // Wrong segment count: captureStructureValues returns null and there is nothing
  // to compare, so the scan must not invent a warning.
  assert.equal(
    findSegmentDuplication(
      ["https://e.com/nsn/a/b/c/"],
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/niin-parts/{A}/")
    ),
    null
  );
});

test("an unparseable URL is skipped rather than crashing the scan", () => {
  const found = findSegmentDuplication(
    ["not a url", "https://nsnstocks.com/nsn/niin-parts-503/"],
    parseStructure("/nsn/{A}"),
    parseStructure("/nsn/niin-parts/{A}/")
  );

  assert.ok(found, "the good URL after the bad one must still be scanned");
  assert.equal(found.paramName, "A");
});
