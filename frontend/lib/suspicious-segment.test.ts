import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  buildSuspiciousStripSuggestion,
  findSuspiciousPosition
} from "./suspicious-segment";

// The exact repro: pattern /nsn/{param} flagged "nsn" as the group's suspicious
// segment, but this pattern's own samples are all niin-parts-* values, none of
// which contain the substring "nsn" (niin-parts-10011 has no "nsn" run of
// characters). The modal used to fall back to position 0 and show 'Auto-added
// a strip for "-nsn" ... couldn't pinpoint the segment, so edit if this is
// incorrect' — a suggestion the tool itself flagged as unreliable, applied
// anyway.
test("findSuspiciousPosition returns null when the segment appears in none of the samples", () => {
  const position = findSuspiciousPosition("/nsn/{param}", "nsn", [
    "https://www.nsnstocks.com/nsn/niin-parts-10011/",
    "https://www.nsnstocks.com/nsn/niin-parts-24/"
  ]);

  assert.equal(position, null);
});

test("buildSuspiciousStripSuggestion returns nothing (no guess, no note) when unverified", () => {
  const suggestion = buildSuspiciousStripSuggestion(
    "/nsn/{A}",
    "/nsn/{param}",
    "nsn",
    [
      "https://www.nsnstocks.com/nsn/niin-parts-10011/",
      "https://www.nsnstocks.com/nsn/niin-parts-24/"
    ]
  );

  assert.equal(suggestion, null);
});

// The positive case must keep working: when the family actually present in the
// samples IS the flagged segment, the strip is placed and the note is the
// confident one (no "couldn't pinpoint" hedge).
test("buildSuspiciousStripSuggestion places a verified strip on the matching position", () => {
  const suggestion = buildSuspiciousStripSuggestion(
    "/nsn/{A}",
    "/nsn/{param}",
    "nsn",
    ["https://www.nsnstocks.com/nsn/nsn-parts-620/"]
  );

  assert.deepEqual(suggestion, {
    newStructure: "/nsn/{A|-nsn|}",
    note: 'Auto-detected: "-nsn" appears in segment A. Edit if this is incorrect.'
  });
});

// Multi-position templates: the segment shows up at the SECOND {param}, so the
// strip must land on {B}, not {A}.
test("buildSuspiciousStripSuggestion finds a later position correctly", () => {
  const suggestion = buildSuspiciousStripSuggestion(
    "/rfq/{A}/{B}/",
    "/rfq/{param}/{param}/",
    "catalog",
    ["https://example.com/rfq/acme/parts-catalog/"]
  );

  assert.deepEqual(suggestion, {
    newStructure: "/rfq/{A}/{B|-catalog|}/",
    note: 'Auto-detected: "-catalog" appears in segment B. Edit if this is incorrect.'
  });
});

// A malformed sampled URL must not throw and must not be mistaken for a match —
// scanning continues to the next sample.
test("an unparsable sampled URL is skipped rather than crashing the scan", () => {
  const suggestion = buildSuspiciousStripSuggestion(
    "/nsn/{A}",
    "/nsn/{param}",
    "nsn",
    ["not a url", "https://www.nsnstocks.com/nsn/nsn-parts-620/"]
  );

  assert.equal(suggestion?.newStructure, "/nsn/{A|-nsn|}");
});
