import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyRedirectRule,
  deriveRedirectRule,
  type RedirectRule
} from "./redirectRule.js";

test("derives a strip/replace rule from a removed segment", () => {
  const rule = deriveRedirectRule([
    {
      source: "https://site.com/products-parts-catalog/widget",
      dest: "https://site.com/products/widget"
    },
    {
      source: "https://site.com/products-parts-catalog/gadget",
      dest: "https://site.com/products/gadget"
    }
  ]);

  assert.deepEqual(rule, { kind: "replace", find: "-parts-catalog", replace: "" });
  assert.equal(
    applyRedirectRule("https://site.com/products-parts-catalog/thingy", rule as RedirectRule),
    "https://site.com/products/thingy"
  );
});

// Reproduces the real-world case reported after v1.42/1.43: a redirect that
// only ADDS a static segment (e.g. "/rfq/x" -> "/aviation/rfq/x") with nothing
// removed. Before this fix, diffPair's prefix/suffix peel consumed the entire
// source as "common suffix" (since source is literally a suffix of dest),
// leaving find === "" — which the old code treated as "cannot generalise" and
// returned null, so the "Fix" modal only ever offered the handful of
// HTTP-sampled URLs and the other tens of thousands of matching URLs in the
// pattern were silently never rewritten.
test("derives an insert rule from a pure segment insertion (no removal)", () => {
  const rule = deriveRedirectRule([
    {
      source: "https://www.purchasingmatrix.com/rfq/airbus-helicopter/c642a0300103",
      dest: "https://www.purchasingmatrix.com/aviation/rfq/airbus-helicopter/c642a0300103"
    },
    {
      source: "https://www.purchasingmatrix.com/rfq/airbus-helicopter/366a58122925",
      dest: "https://www.purchasingmatrix.com/aviation/rfq/airbus-helicopter/366a58122925"
    }
  ]);

  assert.ok(rule, "expected a rule to be derived instead of null");
  assert.deepEqual(rule, {
    kind: "insert",
    prefix: "https://www.purchasingmatrix.com/",
    insert: "aviation/"
  });

  const applied = applyRedirectRule(
    "https://www.purchasingmatrix.com/rfq/airbus-helicopter/9999999999",
    rule as RedirectRule
  );

  assert.equal(
    applied,
    "https://www.purchasingmatrix.com/aviation/rfq/airbus-helicopter/9999999999"
  );
});

test("insert rule does not apply to a URL missing the shared prefix", () => {
  const rule: RedirectRule = {
    kind: "insert",
    prefix: "https://www.purchasingmatrix.com/",
    insert: "aviation/"
  };

  assert.equal(applyRedirectRule("https://other-site.com/rfq/x/1", rule), null);
});

test("disagreeing pairs (different edits) refuse to derive a rule", () => {
  const rule = deriveRedirectRule([
    {
      source: "https://site.com/rfq/a/1",
      dest: "https://site.com/aviation/rfq/a/1"
    },
    {
      source: "https://site.com/rfq/b/2",
      dest: "https://site.com/marine/rfq/b/2"
    }
  ]);

  assert.equal(rule, null);
});

test("identical source/dest pairs are skipped without forcing a null rule", () => {
  const rule = deriveRedirectRule([
    { source: "https://site.com/x", dest: "https://site.com/x" },
    {
      source: "https://site.com/rfq/a/1",
      dest: "https://site.com/aviation/rfq/a/1"
    }
  ]);

  assert.deepEqual(rule, {
    kind: "insert",
    prefix: "https://site.com/",
    insert: "aviation/"
  });
});

test("no usable pairs yields null", () => {
  assert.equal(deriveRedirectRule([]), null);
  assert.equal(
    deriveRedirectRule([{ source: "https://site.com/x", dest: "https://site.com/x" }]),
    null
  );
});
