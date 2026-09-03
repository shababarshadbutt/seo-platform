import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasPaddedToken,
  normalizationVariants,
  normalizeDigitsPath
} from "./digitNormalization.js";

// THE COST GUARD, first in the file. A URL with no zero padding must generate no
// variants at all, because a variant is a live HTTP request against a site that is
// often capped at 5 requests/second. If this ever regresses, every sampled URL in
// every pattern doubles its request cost for nothing.
test("a path with no zero-padded token generates no variants", () => {
  for (const path of [
    "/page-4-17/",
    "/parts/abc-def/",
    "/page-0/", // a bare "0" is not padding
    "/",
    "/parts/12345/"
  ]) {
    assert.deepEqual(normalizationVariants(path), [], path);
    assert.equal(hasPaddedToken(path), false, path);
  }
});

// The two worked examples, which is the whole reason this module exists. Note they
// behave DIFFERENTLY: one yields two readings, the other only one.
test("page-3-00 offers both readings, because they disagree", () => {
  assert.deepEqual(normalizationVariants("/page-3-00/"), [
    { kind: "strip", path: "/page-3-0/" },
    { kind: "stripDropZero", path: "/page-3/" }
  ]);
});

test("page-1-003 offers one reading, because both agree", () => {
  // "003" has no zero VALUE, so dropping zero tokens changes nothing and the
  // duplicate is collapsed — one extra request instead of two.
  assert.deepEqual(normalizationVariants("/page-1-003/"), [
    { kind: "strip", path: "/page-1-3/" }
  ]);
});

test("normalizeDigitsPath strips leading zeros from every token in the path", () => {
  assert.equal(
    normalizeDigitsPath("/cat-007/page-1-003/", false),
    "/cat-7/page-1-3/"
  );
  assert.equal(normalizeDigitsPath("/a_09_b/", false), "/a_9_b/");
});

test("dropZeroTokens removes a zero-valued token and one adjacent separator", () => {
  // Trailing: the separator BEFORE it goes.
  assert.equal(normalizeDigitsPath("/page-3-00/", true), "/page-3/");
  // Leading: the separator AFTER it goes.
  assert.equal(normalizeDigitsPath("/00-page/", true), "/page/");
  // Middle: exactly one separator goes, never both.
  assert.equal(normalizeDigitsPath("/a-00-b/", true), "/a-b/");
});

// Emptying a segment would change the path's shape, not just its spelling — "//"
// is a different URL. The non-dropping reading is used instead, so a token always
// survives.
test("dropZeroTokens never empties a whole path segment", () => {
  assert.equal(normalizeDigitsPath("/00/", true), "/0/");
  assert.equal(normalizeDigitsPath("/parts/000/x/", true), "/parts/0/x/");
});

test("trailing slash, query and fragment are preserved", () => {
  assert.equal(normalizeDigitsPath("/page-003", false), "/page-3");
  assert.equal(normalizeDigitsPath("/page-003/", false), "/page-3/");
  assert.equal(normalizeDigitsPath("/page-003/?a=1", false), "/page-3/?a=1");
  assert.equal(normalizeDigitsPath("/page-003/#frag", false), "/page-3/#frag");
  // A padded number inside the QUERY is a different question and is left alone.
  assert.equal(normalizeDigitsPath("/page-003/?id=007", false), "/page-3/?id=007");
});

// "." is not a separator here. Version strings and file extensions are spelled
// with dots, and "v1.03" -> "v1.3" is a claim this module is not making.
//
// The consequence, pinned deliberately: a token carrying an extension is not
// all-digits, so it does not qualify and the whole URL generates no variant.
// "/sitemap-003.xml" stays as it is. That is the conservative outcome — the tool
// simply offers no fix for such a URL rather than inventing one — and it matches
// rewriteLocs, which already skips a last segment that looks like a file.
test("dots are not treated as token separators", () => {
  assert.equal(normalizeDigitsPath("/v1.03/", false), "/v1.03/");
  assert.equal(normalizeDigitsPath("/sitemap-003.xml", false), "/sitemap-003.xml");
  assert.deepEqual(normalizationVariants("/sitemap-003.xml"), []);
});

// Applying the rule twice must equal applying it once, or a re-run of the same
// redirect fix would keep moving URLs.
test("normalization is idempotent", () => {
  for (const path of ["/page-3-00/", "/page-1-003/", "/cat-007/page-0-00/"]) {
    for (const drop of [false, true]) {
      const once = normalizeDigitsPath(path, drop);

      assert.equal(normalizeDigitsPath(once, drop), once, `${path} drop=${drop}`);
    }
  }
});

// A padded token can be the entire segment, and that must still normalize rather
// than being skipped for want of a separator.
test("a segment that is a single padded token still normalizes", () => {
  assert.equal(normalizeDigitsPath("/parts/007/", false), "/parts/7/");
  assert.deepEqual(normalizationVariants("/parts/007/"), [
    { kind: "strip", path: "/parts/7/" }
  ]);
});
