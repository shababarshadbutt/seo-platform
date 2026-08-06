import assert from "node:assert/strict";
import { test } from "node:test";

import { pathMatchesTemplate } from "./rewriteLocs.js";

// pathMatchesTemplate must agree with buildPatternTemplateRewriter's matching
// (same tokenisation, same {param} rule) — the verifier classifies each <loc>
// with it, and a URL it claims belongs to a pattern must be one the rewriters
// would also touch.

test("exact static path matches its own template", () => {
  assert.equal(pathMatchesTemplate("/aviation/manufacturer", "/aviation/manufacturer"), true);
});

test("static segment mismatch does not match", () => {
  assert.equal(pathMatchesTemplate("/aviation/manufacturer", "/aviation/supplier"), false);
});

test("{param} slot matches any segment value", () => {
  assert.equal(pathMatchesTemplate("/manufacturer/jamco-parts", "/manufacturer/{param}"), true);
  assert.equal(pathMatchesTemplate("/manufacturer/other-co", "/manufacturer/{param}"), true);
});

test("{param} between statics still requires the statics to match", () => {
  assert.equal(pathMatchesTemplate("/category/widgets/parts", "/category/{param}/parts"), true);
  assert.equal(pathMatchesTemplate("/category/widgets/specs", "/category/{param}/parts"), false);
});

test("segment count gates the match", () => {
  assert.equal(pathMatchesTemplate("/manufacturer", "/manufacturer/{param}"), false);
  assert.equal(pathMatchesTemplate("/manufacturer/a/b", "/manufacturer/{param}"), false);
});

test("trailing slash on the path is tolerated (filter(Boolean) tokenisation)", () => {
  // Same tolerance as the rewriters: a trailing "/" never creates a phantom
  // empty segment on either side.
  assert.equal(pathMatchesTemplate("/manufacturer/jamco-parts/", "/manufacturer/{param}"), true);
});

test("trailing slash on the template is tolerated (v1.22 regression shape)", () => {
  // The trailing-slash fix leaves patterns.template ending in "/" — that must
  // not stop its own URLs from matching (the v1.22 silent no-op bug).
  assert.equal(pathMatchesTemplate("/manufacturer/jamco-parts", "/manufacturer/{param}/"), true);
  assert.equal(pathMatchesTemplate("/manufacturer/jamco-parts/", "/manufacturer/{param}/"), true);
});

test("double slashes collapse rather than mint empty segments", () => {
  assert.equal(pathMatchesTemplate("/manufacturer//jamco-parts", "/manufacturer/{param}"), true);
});

test("root path matches only an empty template", () => {
  assert.equal(pathMatchesTemplate("/", "/"), true);
  assert.equal(pathMatchesTemplate("/", "/{param}"), false);
});
