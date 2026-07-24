import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRedirectApplyRewriter } from "./rewriteLocs.js";
import type { RedirectRule } from "./redirectRule.js";

// The bug this fixes: apply-redirects' whole-pattern widening used a pre-built
// exact-match map sourced from the CAPPED pattern_urls sample pool, so any URL
// not in that ~1,000-row sample was silently left unrewritten. These tests pin
// the new rewriter's contract — most importantly, that it rewrites a <loc> that
// matches the derived rule even though that exact URL was never enumerated.

const replaceRule: RedirectRule = {
  kind: "replace",
  find: "-parts-catalog",
  replace: ""
};
const insertRule: RedirectRule = {
  kind: "insert",
  prefix: "https://site.com/",
  insert: "aviation/"
};

test("rewrites a URL that matches the rule but was NEVER in the exact map", () => {
  // Empty exact map on purpose: only the general rule can rewrite this URL.
  const rewrite = buildRedirectApplyRewriter(new Map(), replaceRule);

  assert.equal(
    rewrite("https://site.com/manufacturer/jamco-parts-catalog/widget-9999"),
    "https://site.com/manufacturer/jamco/widget-9999"
  );
});

test("insert-kind rule reaches an un-enumerated URL too", () => {
  const rewrite = buildRedirectApplyRewriter(new Map(), insertRule);

  assert.equal(
    rewrite("https://site.com/manufacturer/never-sampled-88888"),
    "https://site.com/aviation/manufacturer/never-sampled-88888"
  );
});

test("an exact confirmed replacement wins over the general rule", () => {
  // This URL both is in the exact map AND matches the rule; the confirmed,
  // HTTP-verified destination must win.
  const exact = new Map([
    [
      "https://site.com/manufacturer/acme-parts-catalog/x",
      "https://site.com/confirmed/acme/x"
    ]
  ]);
  const rewrite = buildRedirectApplyRewriter(exact, replaceRule);

  assert.equal(
    rewrite("https://site.com/manufacturer/acme-parts-catalog/x"),
    "https://site.com/confirmed/acme/x"
  );
});

test("a URL matching neither the map nor the rule passes through (null)", () => {
  const rewrite = buildRedirectApplyRewriter(new Map(), replaceRule);

  assert.equal(rewrite("https://site.com/already/clean/path"), null);
});

test("null rule degrades to exact-map-only (buildLocMapRewriter behaviour)", () => {
  const exact = new Map([["https://site.com/a", "https://site.com/b"]]);
  const rewrite = buildRedirectApplyRewriter(exact, null);

  assert.equal(rewrite("https://site.com/a"), "https://site.com/b");
  assert.equal(rewrite("https://site.com/unmapped"), null);
});

test("an exact replacement equal to the URL is a no-op (null), not a rewrite", () => {
  const exact = new Map([["https://site.com/a", "https://site.com/a"]]);
  const rewrite = buildRedirectApplyRewriter(exact, null);

  assert.equal(rewrite("https://site.com/a"), null);
});
