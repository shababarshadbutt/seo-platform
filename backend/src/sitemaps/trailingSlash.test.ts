import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildPatternTemplateRewriter,
  buildTrailingSlashRewriter
} from "./rewriteLocs.js";

const fix = buildTrailingSlashRewriter();

describe("buildTrailingSlashRewriter", () => {
  test("adds a trailing slash to a path missing one", () => {
    assert.equal(
      fix("https://example.com/rfq/product/part-123"),
      "https://example.com/rfq/product/part-123/"
    );
  });

  test("leaves a path that already ends with / unchanged", () => {
    assert.equal(fix("https://example.com/rfq/product/part-123/"), null);
  });

  test("skips domain-only URLs", () => {
    assert.equal(fix("https://example.com"), null);
    assert.equal(fix("https://example.com/"), null);
  });

  test("skips URLs whose last segment is a file", () => {
    assert.equal(fix("https://example.com/sitemap.xml"), null);
    assert.equal(fix("https://example.com/docs/guide.html"), null);
    assert.equal(fix("https://example.com/files/report.pdf"), null);
    assert.equal(fix("https://example.com/img/logo.jpg"), null);
  });

  test("inserts the slash before a query string", () => {
    assert.equal(
      fix("https://example.com/path?q=1"),
      "https://example.com/path/?q=1"
    );
    assert.equal(
      fix("https://example.com/a/b?x=1&y=2"),
      "https://example.com/a/b/?x=1&y=2"
    );
  });

  test("does not double-slash a path with a query that already ends in /", () => {
    assert.equal(fix("https://example.com/path/?q=1"), null);
  });

  test("preserves the fragment", () => {
    assert.equal(
      fix("https://example.com/path#section"),
      "https://example.com/path/#section"
    );
  });

  test("returns null for non-http junk", () => {
    assert.equal(fix("not a url"), null);
    assert.equal(fix("mailto:x@example.com"), null);
  });

  test("treats a trailing dotted version segment with a short suffix as a file", () => {
    // Documented heuristic limit: a short dotted suffix reads as an extension.
    assert.equal(fix("https://example.com/v1.2"), null);
  });
});

describe("buildPatternTemplateRewriter with trailing-slash templates", () => {
  // Regression: a trailing-slash fix rewrites patterns.template to end in "/",
  // so a subsequent rename passes that slashed template as `fromTemplate`. The
  // rewriter must still match its own (also-slashed) URLs and apply the rename,
  // preserving the trailing slash — otherwise the rename silently no-ops and the
  // order (fix-slashes then rename) loses the rename entirely.
  test("matches a slashed URL when the from-template is slashed", () => {
    const rewrite = buildPatternTemplateRewriter(
      "/parts/{param}/",
      "/components/{param}/"
    );
    assert.equal(
      rewrite("https://example.com/parts/part-100/"),
      "https://example.com/components/part-100/"
    );
  });

  test("preserves the URL's trailing slash even if templates omit it", () => {
    const rewrite = buildPatternTemplateRewriter(
      "/parts/{param}",
      "/components/{param}"
    );
    assert.equal(
      rewrite("https://example.com/parts/part-100/"),
      "https://example.com/components/part-100/"
    );
  });

  test("a slashed from-template still matches an unslashed URL", () => {
    const rewrite = buildPatternTemplateRewriter(
      "/parts/{param}/",
      "/components/{param}"
    );
    assert.equal(
      rewrite("https://example.com/parts/part-100"),
      "https://example.com/components/part-100"
    );
  });

  test("still inserts a static segment (order-based param carry)", () => {
    const rewrite = buildPatternTemplateRewriter(
      "/manufacturer/{param}/",
      "/aviation/manufacturer/{param}/"
    );
    assert.equal(
      rewrite("https://example.com/manufacturer/jamco/"),
      "https://example.com/aviation/manufacturer/jamco/"
    );
  });

  test("non-matching path still passes through unchanged (null)", () => {
    const rewrite = buildPatternTemplateRewriter(
      "/parts/{param}/",
      "/components/{param}/"
    );
    assert.equal(rewrite("https://example.com/other/thing/"), null);
  });
});
