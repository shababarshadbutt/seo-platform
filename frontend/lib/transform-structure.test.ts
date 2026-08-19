import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  candidateTransforms,
  captureStructureValues,
  formatStructure,
  inferNewStructure,
  convertParamToABC,
  StructureSyntaxError,
  countTemplateParams,
  parseStructure,
  structureParamNames,
  transformUrl,
  validateStructures
} from "./transform-structure";

// This module is a deliberate mirror of backend/src/sitemaps/transformStructure.ts
// ("KEEP IN SYNC with the backend module"). The Update Pattern modal validates
// locally to enable/disable Preview; the backend re-validates the same pair on
// apply. A wording drift between them means the user is told one thing in the
// modal and another by the API, so validateStructures itself is compared
// byte-for-byte at the bottom of this file.

// --- the nsnstocks screenshot -----------------------------------------------
// Pattern /nsn/{param}, scoped to niin-parts-{var}, user typed the literal
// "/nsn/niin-parts-567/" over the pre-filled "/nsn/{A}".

const SCREENSHOT_TEMPLATE = "/nsn/{param}";
const SCREENSHOT_TYPED = "/nsn/niin-parts-567/";

test("the typed literal parses to zero params against a 1-param pattern", () => {
  const typed = parseStructure(SCREENSHOT_TYPED);

  assert.equal(structureParamNames(typed).length, 0);
  assert.equal(countTemplateParams(SCREENSHOT_TEMPLATE), 1);
});

test("the screenshot input is rejected WITH a recovery instruction", () => {
  const message =
    validateStructures(
      parseStructure(SCREENSHOT_TYPED),
      parseStructure("/nsn/{A}"),
      countTemplateParams(SCREENSHOT_TEMPLATE)
    ) ?? "";

  // The diagnostic the screenshot showed is kept — it is accurate.
  assert.match(message, /current structure defines 0 params but the pattern has 1/);
  // ...and now says what to type instead, which is what was missing.
  assert.match(message, /put \{A\} where the URL varies instead of a literal value/);
});

test("the structure the modal pre-fills is valid for its own template", () => {
  // The recovery affordance offers exactly convertParamToABC(template), so this
  // is the property that makes the button safe: valid BY CONSTRUCTION, for any
  // template, without the user knowing the {A} syntax.
  for (const template of [
    "/nsn/{param}",
    "/manufacturer/{param}/{param}/",
    "/rfq/{param}/{param}/{param}/{param}/",
    "/about-us/"
  ]) {
    const starter = convertParamToABC(template);
    const parsed = parseStructure(starter);

    assert.equal(
      validateStructures(parsed, parsed, countTemplateParams(template)),
      null,
      `${template} -> ${starter} should validate`
    );
  }
});

test("convertParamToABC names positions in order and keeps static segments", () => {
  assert.equal(convertParamToABC("/nsn/{param}"), "/nsn/{A}");
  assert.equal(
    convertParamToABC("/manufacturer/{param}/{param}/"),
    "/manufacturer/{A}/{B}/"
  );
  assert.equal(
    convertParamToABC("/rfq/{param}/{param}/{param}/{param}/"),
    "/rfq/{A}/{B}/{C}/{D}/"
  );
  // No params: unchanged, and still a legal static-only structure.
  assert.equal(convertParamToABC("/about-us/"), "/about-us/");
});

// --- scope independence -----------------------------------------------------
// Selecting a structure in "Limit this edit to" narrows WHICH URLs are edited;
// it does not change the SHAPE the structure fields must describe. So the
// pre-fill is deliberately scope-independent, and the generic starter must work
// on a URL from inside a scope.

test("the generic starter transforms a scoped niin-parts URL", () => {
  assert.equal(
    transformUrl(
      "https://nsnstocks.com/nsn/niin-parts-567/",
      parseStructure("/nsn/{A}"),
      parseStructure("/nsn/{A|niin-parts-|}/")
    ),
    "https://nsnstocks.com/nsn/567/"
  );
});

test("a literal current structure matches only the one URL it names", () => {
  // Why no scope-aware pre-fill of a literal could ever be right.
  const literal = parseStructure(SCREENSHOT_TYPED);

  assert.equal(
    transformUrl(
      "https://nsnstocks.com/nsn/niin-parts-568/",
      literal,
      parseStructure("/nsn/{A}")
    ),
    null
  );
});

// --- 0-param pattern is not this error --------------------------------------

test("a 0-param structure against a 0-param pattern still validates", () => {
  assert.equal(
    validateStructures(parseStructure("/about-us/"), parseStructure("/about/"), 0),
    null
  );
});

// --- frontend/backend sync guard --------------------------------------------

// Every function listed here is duplicated verbatim between the two modules.
// The list is the guard: the modal infers and previews a rule locally while the
// API re-infers and applies it, so any drift means the modal shows the user
// something the server will not write.
//
// THE PRIVATE HELPERS ARE ON THIS LIST ON PURPOSE. Listing only the exported
// entry points looks sufficient and is not: candidateTransforms and
// inferNewStructure are thin over transformQuality / replaceOffsets /
// alignSegments, so changing which reading of an example wins is a one-line
// edit inside a helper that leaves every exported body byte-identical. Verified
// by making that edit — the guard passed, and the modal would then have inferred
// a different rule from the one the API applies.
const MIRRORED = [
  "validateStructures",
  "formatSegmentRule",
  "formatStructure",
  "transformQuality",
  "replaceOffsets",
  "candidateTransforms",
  "alignSegments",
  "inferNewStructure"
];

test("the mirrored functions are byte-identical to the backend copies", () => {
  const extract = (file: string, name: string) => {
    // Normalise EOLs before comparing: this repo pins line endings via
    // .gitattributes and checks out CRLF on Windows, which is not the kind of
    // drift this guard is for — the message text is.
    const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    // Exported or not: a mirrored helper is mirrored either way, and the
    // non-exported ones are where the interesting drift hides.
    const exported = source.indexOf("export function " + name);
    const start =
      exported === -1 ? source.indexOf("\nfunction " + name) : exported;

    assert.notEqual(start, -1, name + " not found in " + file);

    const end = source.indexOf("\n}\n", start);

    assert.notEqual(end, -1, "unterminated " + name + " in " + file);

    return source.slice(start, end + 3);
  };

  const here = path.join(__dirname, "transform-structure.ts");
  const backend = path.join(
    __dirname,
    "..",
    "..",
    "backend",
    "src",
    "sitemaps",
    "transformStructure.ts"
  );

  for (const name of MIRRORED) {
    assert.equal(
      extract(here, name),
      extract(backend, name),
      name +
        " drifted between the frontend and backend copies — the modal would " +
        "tell the user something the API does not"
    );
  }
});

// --- captureStructureValues -------------------------------------------------
// Exposes the values transformUrl already derives internally, so the
// duplicate-segment warning does not re-implement the segment walk.

test("captureStructureValues returns each param's real value", () => {
  const values = captureStructureValues(
    "https://nsnstocks.com/nsn/niin-parts-503/",
    parseStructure("/nsn/{A}")
  );

  assert.deepEqual(Array.from(values ?? new Map()), [["A", "niin-parts-503"]]);
});

test("captureStructureValues is null on the same conditions transformUrl is", () => {
  const current = parseStructure("/nsn/{A}");

  // Wrong segment count, differing static segment, and an unparseable URL — the
  // three ways transformUrl declines to rewrite.
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
