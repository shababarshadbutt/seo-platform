import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyShapeFilterToRewriter,
  parseShapeFilter,
  urlMatchesShapeFilter
} from "./shapeFilter.js";

const FIVE = "https://www.nsngamut.com/nsn/nsn-parts-12191/";
const FOUR = "https://www.nsngamut.com/nsn/nsn-parts-6492/";
const PAGE = "https://www.nsngamut.com/nsn/page-1-34/";

// Shapes of the three above, as valueShape renders them.
const SHAPE_FIVE = "/a/a-a-99999/";
const SHAPE_FOUR = "/a/a-a-9999/";

const shout: (url: string) => string | null = (url) => url + "#rewritten";

test("only the selected shapes reach the rewriter", () => {
  // The reported case: a rule meant for the 5-digit values must leave the
  // 4-digit ones and the page-N-N ones byte-identical.
  const scoped = applyShapeFilterToRewriter(shout, [SHAPE_FIVE]);

  assert.equal(scoped(FIVE), FIVE + "#rewritten");
  assert.equal(scoped(FOUR), null);
  assert.equal(scoped(PAGE), null);
});

test("several shapes can be selected at once", () => {
  const scoped = applyShapeFilterToRewriter(shout, [SHAPE_FIVE, SHAPE_FOUR]);

  assert.equal(scoped(FIVE), FIVE + "#rewritten");
  assert.equal(scoped(FOUR), FOUR + "#rewritten");
  assert.equal(scoped(PAGE), null);
});

test("an empty selection is UNSCOPED, not scoped-to-nothing", () => {
  // Same convention as applyStructureFilterToRewriter. Every caller passes its
  // filter list through unconditionally, so [] has to mean "no scope" or an
  // unscoped transform would rewrite zero URLs and look like a silent failure.
  for (const shapes of [[], null]) {
    const scoped = applyShapeFilterToRewriter(shout, shapes);

    assert.equal(scoped(FIVE), FIVE + "#rewritten");
    assert.equal(scoped(PAGE), PAGE + "#rewritten");
  }
});

test("an unparseable loc is left alone rather than rewritten", () => {
  const scoped = applyShapeFilterToRewriter(shout, [SHAPE_FIVE]);

  assert.equal(scoped("not a url"), null);
});

test("digit LENGTH separates shapes — the whole point", () => {
  // valueShape keeps the run length (9x5 vs 9x4), which is exactly the
  // distinction a token-boundary structure filter cannot express and why this
  // is a separate dimension rather than an extension of that one.
  assert.equal(urlMatchesShapeFilter(FIVE, [SHAPE_FOUR]), false);
  assert.equal(urlMatchesShapeFilter(FOUR, [SHAPE_FOUR]), true);
});

test("parseShapeFilter: absent, empty, and junk", () => {
  assert.deepEqual(parseShapeFilter(undefined), []);
  assert.deepEqual(parseShapeFilter(null), []);
  assert.deepEqual(parseShapeFilter([]), []);
  assert.deepEqual(parseShapeFilter([SHAPE_FIVE]), [SHAPE_FIVE]);
  // Malformed is null, not silently dropped: a body that half-parses would
  // narrow or widen the edit without saying so.
  assert.equal(parseShapeFilter("nope"), null);
  assert.equal(parseShapeFilter([1]), null);
  assert.equal(parseShapeFilter([""]), null);
  assert.equal(parseShapeFilter(["x".repeat(513)]), null);
});
