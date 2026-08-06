import { strict as assert } from "node:assert";
import { test } from "node:test";

import { showFixButton } from "./fix-visibility";

// The regression this guards: /about-us-style patterns — total_urls = 1, the
// single sampled URL is a 404, so no redirect ever lands in the sample. The
// old hasRedirects-only rule hid Fix on exactly those Broken rows.
test("Broken pattern shows Fix regardless of sampled redirects (total_urls = 1 case)", () => {
  assert.equal(showFixButton({ status: "BAD" }), true);
});

test("Warning pattern shows Fix regardless of sampled redirects", () => {
  assert.equal(showFixButton({ status: "WARNING" }), true);
});

// SEO-team spec: Fix is hidden ONLY for Healthy — and Healthy always hides it,
// even when a redirect landed in the sample. No fallback condition.
test("Healthy pattern hides Fix even with a redirect in its sample", () => {
  // A row object like the table's PatternRow: hasRedirects is present and
  // true, and must have no effect on visibility.
  const healthyWithSampledRedirect = { status: "GOOD" as const, hasRedirects: true };
  assert.equal(showFixButton(healthyWithSampledRedirect), false);
});

test("Not-scored pattern hides Fix", () => {
  assert.equal(showFixButton({ status: "UNKNOWN" }), false);
});
