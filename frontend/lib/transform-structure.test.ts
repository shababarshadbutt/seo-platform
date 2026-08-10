import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  convertParamToABC,
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

test("validateStructures is byte-identical to the backend copy", () => {
  const extract = (file: string) => {
    // Normalise EOLs before comparing: this repo pins line endings via
    // .gitattributes and checks out CRLF on Windows, which is not the kind of
    // drift this guard is for — the message text is.
    const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf("export function validateStructures");

    assert.notEqual(start, -1, `validateStructures not found in ${file}`);

    const end = source.indexOf("\n}\n", start);

    assert.notEqual(end, -1, `unterminated validateStructures in ${file}`);

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

  assert.equal(
    extract(here),
    extract(backend),
    "validateStructures drifted between the frontend and backend copies — " +
      "the modal would tell the user something the API does not"
  );
});
