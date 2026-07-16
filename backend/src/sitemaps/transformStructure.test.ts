import assert from "node:assert/strict";
import { test } from "node:test";

import {
  StructureSyntaxError,
  parseStructure,
  structureParamNames,
  transformUrl,
  validateStructures
} from "./transformStructure.js";

// --- parseStructure -------------------------------------------------------

test("parseStructure reads static + plain param segments", () => {
  const parsed = parseStructure("/manufacturer/{A}/{B}");

  assert.equal(parsed.trailingSlash, false);
  assert.deepEqual(parsed.segments, [
    { type: "static", value: "manufacturer" },
    { type: "param", name: "A", transform: { kind: "none" } },
    { type: "param", name: "B", transform: { kind: "none" } }
  ]);
});

test("parseStructure captures a trailing slash", () => {
  assert.equal(parseStructure("/manufacturer/{A}/{B}/").trailingSlash, true);
  assert.equal(parseStructure("/manufacturer/{A}/{B}").trailingSlash, false);
});

test("parseStructure parses the strip form {A|text|}", () => {
  const [, rule] = parseStructure("/x/{A|-parts-catalog|}").segments;
  assert.deepEqual(rule, {
    type: "param",
    name: "A",
    transform: { kind: "replace", find: "-parts-catalog", replace: "" }
  });
});

test("parseStructure parses the replace form {A|old|new|}", () => {
  const [, rule] = parseStructure("/x/{A|catalog|list|}").segments;
  assert.deepEqual(rule, {
    type: "param",
    name: "A",
    transform: { kind: "replace", find: "catalog", replace: "list" }
  });
});

test("parseStructure parses upper/lower directives", () => {
  assert.deepEqual(parseStructure("/{A|upper|}").segments[0], {
    type: "param",
    name: "A",
    transform: { kind: "upper" }
  });
  assert.deepEqual(parseStructure("/{A|lower|}").segments[0], {
    type: "param",
    name: "A",
    transform: { kind: "lower" }
  });
});

test("parseStructure rejects malformed tokens", () => {
  assert.throws(() => parseStructure("/{}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/{A|}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/{A||}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/{A|a|b|c|}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/man{A}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/{1A}"), StructureSyntaxError);
});

// --- transformUrl: the SEO team's real examples ---------------------------

const CURRENT = parseStructure("/manufacturer/{A}/{B}");
const NEXT = parseStructure("/manufacturer/{A|-parts-catalog|}/{B}/");

test("transformUrl strips -parts-catalog and adds a trailing slash", () => {
  const cases: Array<[string, string]> = [
    [
      "https://www.industrialsdelivery.com/manufacturer/square-d-parts-catalog/page-18",
      "https://www.industrialsdelivery.com/manufacturer/square-d/page-18/"
    ],
    [
      "https://example.com/manufacturer/honeywell-parts-catalog/page-5",
      "https://example.com/manufacturer/honeywell/page-5/"
    ],
    [
      "https://example.com/manufacturer/siemens-parts-catalog/page-100",
      "https://example.com/manufacturer/siemens/page-100/"
    ]
  ];

  for (const [input, expected] of cases) {
    assert.equal(transformUrl(input, CURRENT, NEXT), expected);
  }
});

test("transformUrl preserves the query string and host", () => {
  assert.equal(
    transformUrl(
      "https://shop.example.com/manufacturer/abb-parts-catalog/page-2?ref=nav",
      CURRENT,
      NEXT
    ),
    "https://shop.example.com/manufacturer/abb/page-2/?ref=nav"
  );
});

test("transformUrl applies upper/lower and replace", () => {
  assert.equal(
    transformUrl(
      "https://e.com/manufacturer/square-d/page-1",
      CURRENT,
      parseStructure("/manufacturer/{A|upper|}/{B}")
    ),
    "https://e.com/manufacturer/SQUARE-D/page-1"
  );
  assert.equal(
    transformUrl(
      "https://e.com/manufacturer/SQUARE-D/page-1",
      CURRENT,
      parseStructure("/manufacturer/{A|lower|}/{B}")
    ),
    "https://e.com/manufacturer/square-d/page-1"
  );
  assert.equal(
    transformUrl(
      "https://e.com/manufacturer/square-d-parts-catalog/page-1",
      CURRENT,
      parseStructure("/manufacturer/{A|-parts-catalog|-parts-list|}/{B}")
    ),
    "https://e.com/manufacturer/square-d-parts-list/page-1"
  );
});

test("transformUrl can add and reorder static segments", () => {
  assert.equal(
    transformUrl(
      "https://e.com/manufacturer/square-d/page-1",
      CURRENT,
      parseStructure("/catalog/manufacturer/{A}/{B}")
    ),
    "https://e.com/catalog/manufacturer/square-d/page-1"
  );
});

test("transformUrl returns null for non-matching URLs", () => {
  // Wrong segment count.
  assert.equal(
    transformUrl("https://e.com/manufacturer/square-d", CURRENT, NEXT),
    null
  );
  // Static segment differs.
  assert.equal(
    transformUrl("https://e.com/vendor/square-d/page-1", CURRENT, NEXT),
    null
  );
  // Not a URL.
  assert.equal(transformUrl("not a url", CURRENT, NEXT), null);
});

test("transformUrl returns null when the result is unchanged", () => {
  const identity = parseStructure("/manufacturer/{A}/{B}");
  assert.equal(
    transformUrl("https://e.com/manufacturer/square-d/page-1", CURRENT, identity),
    null
  );
});

// --- validateStructures ---------------------------------------------------

test("validateStructures accepts a well-formed pair", () => {
  assert.equal(validateStructures(CURRENT, NEXT, 2), null);
});

test("validateStructures rejects a param-count mismatch with the pattern", () => {
  assert.match(
    validateStructures(CURRENT, NEXT, 3) ?? "",
    /2 params but the pattern has 3/
  );
});

test("validateStructures rejects dropping a param", () => {
  assert.match(
    validateStructures(CURRENT, parseStructure("/manufacturer/{A}"), 2) ?? "",
    /drops \{B\}/
  );
});

test("validateStructures rejects a new param not in the current structure", () => {
  assert.match(
    validateStructures(
      CURRENT,
      parseStructure("/manufacturer/{A}/{B}/{C}"),
      2
    ) ?? "",
    /\{C\}.*not defined/
  );
});

test("validateStructures rejects duplicate names in the current structure", () => {
  assert.match(
    validateStructures(
      parseStructure("/manufacturer/{A}/{A}"),
      parseStructure("/manufacturer/{A}/{A}"),
      2
    ) ?? "",
    /repeats a param name/
  );
});

test("structureParamNames lists params in order", () => {
  assert.deepEqual(structureParamNames(parseStructure("/x/{A}/y/{B}")), [
    "A",
    "B"
  ]);
});
