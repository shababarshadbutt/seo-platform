import assert from "node:assert/strict";
import { test } from "node:test";

import {
  candidateTransforms,
  captureStructureValues,
  formatStructure,
  inferNewStructure,
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

// The nsnstocks screenshot: a /nsn/{param} pattern with a literal example URL
// typed into "Current URL structure" instead of the {A} syntax. Rejecting it is
// correct — a literal matches only the one URL it names — but the bare count
// mismatch left Preview disabled with no way out, so this case carries the
// instruction. (v1.52)
test("validateStructures tells a 0-param current structure what to do instead", () => {
  const typedLiteral = parseStructure("/nsn/niin-parts-567/");
  const message = validateStructures(typedLiteral, parseStructure("/nsn/{A}"), 1) ?? "";

  assert.match(message, /0 params but the pattern has 1/);
  assert.match(message, /put \{A\} where the URL varies/);
  assert.doesNotMatch(message, /\{B\}/);
});

test("validateStructures pluralises the placeholder hint past one param", () => {
  const message =
    validateStructures(parseStructure("/rfq/a/b"), parseStructure("/rfq/{A}/{B}"), 2) ?? "";

  assert.match(message, /0 params but the pattern has 2/);
  assert.match(message, /put \{A\}, \{B\}… where the URL varies/);
});

// A 0-param structure against a 0-param pattern is not this error — it is a
// legitimate static-only rewrite, and must keep validating.
test("validateStructures accepts a 0-param pair when the pattern has none", () => {
  assert.equal(
    validateStructures(parseStructure("/about-us/"), parseStructure("/about/"), 0),
    null
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

// --- captureStructureValues -------------------------------------------------
// Mirror of the frontend helper. Only validateStructures is byte-compared
// between the two files, so these assert equivalent BEHAVIOUR rather than
// identical text.

test("captureStructureValues returns each param's real value", () => {
  const values = captureStructureValues(
    "https://nsnstocks.com/nsn/niin-parts-503/",
    parseStructure("/nsn/{A}")
  );

  assert.deepEqual(Array.from(values ?? new Map()), [["A", "niin-parts-503"]]);
});

test("captureStructureValues is null on the same conditions transformUrl is", () => {
  const current = parseStructure("/nsn/{A}");

  assert.equal(captureStructureValues("https://e.com/nsn/a/b", current), null);
  assert.equal(captureStructureValues("https://e.com/other/a", current), null);
  assert.equal(captureStructureValues("not a url", current), null);
});

test("captureStructureValues captures multiple params in order", () => {
  const values = captureStructureValues(
    "https://e.com/manufacturer/square-d/page-18",
    parseStructure("/manufacturer/{A}/{B}")
  );

  assert.equal(values?.get("A"), "square-d");
  assert.equal(values?.get("B"), "page-18");
});

// --- {A|split|N|sep|} : insert a separator at a position -------------------

test("split inserts the separator at the given position (24 -> 2-4)", () => {
  assert.equal(
    transformUrl(
      "https://e.com/nsn/24",
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/{A|split|1|-|}")
    ),
    "https://e.com/nsn/2-4"
  );
});

test("split position past the value length clamps to the end, no throw", () => {
  assert.equal(
    transformUrl(
      "https://e.com/nsn/24",
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/{A|split|99|-|}")
    ),
    "https://e.com/nsn/24-"
  );
});

test("split position 0 prepends", () => {
  assert.equal(
    transformUrl(
      "https://e.com/nsn/24",
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/{A|split|0|x|}")
    ),
    "https://e.com/nsn/x24"
  );
});

test("split rejects a non-numeric or negative position", () => {
  // Digits only. Number.parseInt alone would accept these as 1 and silently
  // apply a transform nobody wrote.
  assert.throws(() => parseStructure("/nsn/{A|split|abc|-|}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/nsn/{A|split|-1|-|}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/nsn/{A|split|1.5|-|}"), StructureSyntaxError);
  assert.throws(() => parseStructure("/nsn/{A|split||-|}"), StructureSyntaxError);
  assert.match(
    (() => {
      try {
        parseStructure("/nsn/{A|split|abc|-|}");
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })(),
    /invalid split position "abc"/
  );
});

test("split with an EMPTY separator is a documented no-op, not an error", () => {
  const parsed = parseStructure("/nsn/{A|split|1||}");

  assert.deepEqual(parsed.segments[1], {
    type: "param",
    name: "A",
    transform: { kind: "insertAt", position: 1, separator: "" }
  });
  // Inserting nothing leaves the value identical, and transformUrl returns null
  // for an unchanged result — so it is a no-op end to end, not a crash.
  assert.equal(
    transformUrl(
      "https://e.com/nsn/24",
      parseStructure("/nsn/{A}"),
      parsed
    ),
    null
  );
});

test("a 5-part token that is not 'split' is still rejected", () => {
  assert.throws(() => parseStructure("/nsn/{A|a|b|c|}"), StructureSyntaxError);
});

test("the not-a-valid-transform message lists the split form", () => {
  try {
    parseStructure("/nsn/{A|a|b|c|}");
    assert.fail("should have thrown");
  } catch (error) {
    assert.match((error as Error).message, /\{A\|split\|N\|sep\|\}/);
  }
});

// --- the existing replace operator already covers single-character swaps ----
// Confirming rather than assuming, because it is easy to reach for split here.

test("replace still swaps a lone hyphen for another character", () => {
  assert.equal(
    transformUrl(
      "https://e.com/nsn/page-4/",
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/{A|-|_|}/")
    ),
    "https://e.com/nsn/page_4/"
  );
});

test("replace hits EVERY occurrence — which is why split exists", () => {
  // Both hyphens go, so replace cannot target one of several identical chars.
  assert.equal(
    transformUrl(
      "https://e.com/nsn/niin-parts-24/",
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/{A|-|_|}/")
    ),
    "https://e.com/nsn/niin_parts_24/"
  );
});

test("a slash cannot be a separator in ANY token — verified limitation", () => {
  // parseStructure splits on "/" before tokens are parsed, so the token arrives
  // as the fragment "{A|-|" and is rejected as brace-mixed. Applies equally to
  // {A|split|1|/|}: a real slash inside one path segment is not expressible.
  assert.throws(() => parseStructure("/nsn/{A|-|/|}/"), StructureSyntaxError);
  assert.throws(() => parseStructure("/nsn/{A|split|1|/|}/"), StructureSyntaxError);
});

test("a backslash separator silently becomes a slash — verified limitation", () => {
  // It parses, but transformUrl assigns to url.pathname and the WHATWG parser
  // normalises "\" to "/" for special schemes, so it splits the segment instead
  // of staying inside it. Documented so nobody offers it as a workaround.
  const BACKSLASH = String.fromCharCode(92);

  assert.equal(
    transformUrl(
      "https://e.com/nsn/24",
      parseStructure("/nsn/{A}"),
      parseStructure(`/nsn/{A|split|1|${BACKSLASH}|}`)
    ),
    "https://e.com/nsn/2/4"
  );
});

// --- inferNewStructure ------------------------------------------------------
// By-example inference: the user retypes a real URL and the rule is derived.

// The two examples the feature was requested for, verbatim.

test("infers a positional split from /nspart/part-720/ to /nsnpart/part-7-20/", () => {
  const current = parseStructure("/nspart/{A}/");
  const result = inferNewStructure(
    "https://nsnstocks.com/nspart/part-720/",
    "https://nsnstocks.com/nsnpart/part-7-20/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.ok && result.structure,
    "/nsnpart/{A|split|6|-|}/"
  );
});

test("infers an added static segment alongside the split", () => {
  const current = parseStructure("/nspart/{A}/");
  const result = inferNewStructure(
    "https://nsnstocks.com/nspart/part-720/",
    "https://nsnstocks.com/nsnpart/niinpart/part-7-20/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.ok && result.structure,
    "/nsnpart/niinpart/{A|split|6|-|}/"
  );
});

// The ambiguity that matters at scale.

test("prefers the positional split over a replace that also fits the example", () => {
  // "part-720" -> "part-7-20" is equally explained by {A|split|6|-|} and by
  // {A|7|7-|}. The second changes MORE urls, and turns "part-777" into
  // "part-7-7-7-", so "more general" must not win.
  const current = parseStructure("/nspart/{A}/");
  const result = inferNewStructure(
    "https://x.com/nspart/part-720/",
    "https://x.com/nspart/part-7-20/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/nspart/{A|split|6|-|}/");
  // The replace reading is still offered, so a user who wants it can say so.
  assert.ok(
    result.ok &&
      result.alternatives.some((entry) => entry.segment === "{A|7|7-|}"),
    "the replace reading should be offered as an alternative"
  );
});

test("a replace candidate that would fire twice is not offered", () => {
  // Every reading of "a-b" -> "a-b-b" that uses `replace` hits both halves or
  // fails to reproduce the example, so only the positional one survives.
  const current = parseStructure("/p/{A}/");
  const result = inferNewStructure(
    "https://x.com/p/a-b/",
    "https://x.com/p/a-b-b/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/p/{A|split|3|-b|}/");
});

// Alignment, not greedy matching.

test("a new static segment that prefixes the param value does not steal it", () => {
  // Greedy left-to-right binds {A} to "niin-parts" as {A|-503|} and leaves the
  // real value as a literal — correct for this one URL, wrong for every other.
  const current = parseStructure("/nsn/{A}/");
  const result = inferNewStructure(
    "https://nsnstocks.com/nsn/niin-parts-503/",
    "https://nsnstocks.com/nsn/niin-parts/niin-parts-503/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/nsn/niin-parts/{A}/");
});

test("keeps two params in order across an inserted static segment", () => {
  const current = parseStructure("/a/{A}/{B}/");
  const result = inferNewStructure(
    "https://x.com/a/one/two/",
    "https://x.com/a/one/mid/two/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/a/{A}/mid/{B}/");
});

// The other operators.

test("infers a strip", () => {
  const current = parseStructure("/manufacturer/{A}/");
  const result = inferNewStructure(
    "https://x.com/manufacturer/acme-parts-catalog/",
    "https://x.com/manufacturer/acme/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(
    result.ok && result.structure,
    "/manufacturer/{A|-parts-catalog|}/"
  );
});

test("infers lowercasing", () => {
  const current = parseStructure("/p/{A}/");
  const result = inferNewStructure(
    "https://x.com/p/ACME/",
    "https://x.com/p/acme/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/p/{A|lower|}/");
});

test("infers a dropped trailing slash", () => {
  const current = parseStructure("/p/{A}/");
  const result = inferNewStructure(
    "https://x.com/p/acme/",
    "https://x.com/p/acme",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/p/{A}");
});

test("accepts a bare path as the new URL and inherits the host", () => {
  const current = parseStructure("/nspart/{A}/");
  const result = inferNewStructure(
    "https://nsnstocks.com/nspart/part-720/",
    "/nsnpart/part-7-20/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/nsnpart/{A|split|6|-|}/");
});

// Refusals. Each of these must fail rather than guess, because the rule is
// about to be applied to every URL in the pattern.

test("refuses when the new URL drops the varying part entirely", () => {
  const current = parseStructure("/nspart/{A}/");
  const result = inferNewStructure(
    "https://x.com/nspart/part-720/",
    "https://x.com/nsnpart/fixed/",
    current
  );

  assert.equal(result.ok, false);
  assert.match(
    (result.ok ? "" : result.error) as string,
    /collapse to the same literal/
  );
});

test("refuses when the new URL reorders the params", () => {
  const current = parseStructure("/a/{A}/{B}/");
  const result = inferNewStructure(
    "https://x.com/a/one/two/",
    "https://x.com/a/two/one/",
    current
  );

  assert.equal(result.ok, false);
});

test("refuses when nothing changed", () => {
  const current = parseStructure("/p/{A}/");
  const result = inferNewStructure(
    "https://x.com/p/acme/",
    "https://x.com/p/acme/",
    current
  );

  assert.equal(result.ok, false);
  assert.match((result.ok ? "" : result.error) as string, /identical/);
});

test("refuses when the example does not match the current structure", () => {
  const current = parseStructure("/other/{A}/");
  const result = inferNewStructure(
    "https://x.com/nspart/part-720/",
    "https://x.com/nsnpart/part-7-20/",
    current
  );

  assert.equal(result.ok, false);
  assert.match(
    (result.ok ? "" : result.error) as string,
    /does not match the current structure/
  );
});

test("warns, but still infers, when the host differs", () => {
  const current = parseStructure("/nspart/{A}/");
  const result = inferNewStructure(
    "https://nsnstocks.com/nspart/part-720/",
    "https://elsewhere.com/nsnpart/part-7-20/",
    current
  );

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.structure, "/nsnpart/{A|split|6|-|}/");
  assert.ok(
    result.ok && result.warnings.some((note) => /host/.test(note)),
    "a host change should be called out"
  );
});

// Whatever the inference returns must survive the round trip through the same
// gates a hand-typed structure goes through — that is the property the apply
// path depends on.

test("every inferred structure re-parses and reproduces the example", () => {
  const cases: Array<[string, string, string]> = [
    ["/nspart/{A}/", "https://x.com/nspart/part-720/", "https://x.com/nsnpart/part-7-20/"],
    ["/nspart/{A}/", "https://x.com/nspart/part-720/", "https://x.com/a/b/part-7-20/"],
    ["/nsn/{A}/", "https://x.com/nsn/niin-parts-503/", "https://x.com/nsn/niin-parts/niin-parts-503/"],
    ["/m/{A}/", "https://x.com/m/acme-parts-catalog/", "https://x.com/m/acme"],
    ["/a/{A}/{B}/", "https://x.com/a/one/two/", "https://x.com/a/one/mid/two/"]
  ];

  for (const [currentRaw, oldUrl, newUrl] of cases) {
    const current = parseStructure(currentRaw);
    const result = inferNewStructure(oldUrl, newUrl, current);

    assert.equal(result.ok, true, `${oldUrl} -> ${newUrl} should infer`);

    if (!result.ok) {
      continue;
    }

    const next = parseStructure(result.structure);

    assert.equal(
      validateStructures(current, next, structureParamNames(current).length),
      null,
      `${result.structure} should validate`
    );
    assert.equal(
      new URL(transformUrl(oldUrl, current, next) as string).pathname,
      new URL(newUrl, oldUrl).pathname,
      `${result.structure} should reproduce the example`
    );
  }
});

// --- candidateTransforms ----------------------------------------------------

test("candidateTransforms returns an exact match alone", () => {
  assert.deepEqual(candidateTransforms("acme", "acme"), [{ kind: "none" }]);
});

test("candidateTransforms offers nothing for an unrelated literal", () => {
  // No shared material at either end: the user typed a static segment, not a
  // transform of the value.
  assert.deepEqual(candidateTransforms("part-720", "nsnpart"), []);
});

test("candidateTransforms puts the positional reading first", () => {
  const candidates = candidateTransforms("part-720", "part-7-20");

  assert.deepEqual(candidates[0], {
    kind: "insertAt",
    position: 6,
    separator: "-"
  });
});

// --- formatStructure --------------------------------------------------------

test("formatStructure is the inverse of parseStructure", () => {
  for (const raw of [
    "/nsnpart/{A|split|6|-|}/",
    "/manufacturer/{A|-parts-catalog|}/{B}",
    "/p/{A|upper|}/",
    "/p/{A|old|new|}/",
    "/a/b/c/"
  ]) {
    const parsed = parseStructure(raw);

    assert.equal(formatStructure(parsed.segments, parsed.trailingSlash), raw);
  }
});
