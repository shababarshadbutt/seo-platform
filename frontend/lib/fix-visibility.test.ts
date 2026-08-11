import { strict as assert } from "node:assert";
import { test } from "node:test";

import { showCheckButton, showFixButton } from "./fix-visibility";

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

// --- showCheckButton: the never-scored entry point --------------------------
// 54e08a3e stopped never-sampled patterns reporting BAD, which correctly removed
// the Fix button from them — and left them with NOTHING to click. Check is that
// missing action. All four statuses are pinned so the split between "confirmed
// problem" and "no measurement" cannot quietly drift.

test("Not-scored pattern SHOWS Check", () => {
  assert.equal(showCheckButton({ status: "UNKNOWN" }), true);
});

test("Broken pattern hides Check — it has a confirmed problem, so Fix applies", () => {
  assert.equal(showCheckButton({ status: "BAD" }), false);
});

test("Warning pattern hides Check — same reason as Broken", () => {
  assert.equal(showCheckButton({ status: "WARNING" }), false);
});

test("Healthy pattern hides Check — nothing to fix and nothing unknown", () => {
  // Explicitly asserted because it is the one status with NO button at all, and
  // that is the design (fix-visibility.ts's own note), not an oversight.
  assert.equal(showCheckButton({ status: "GOOD" }), false);
});

test("Fix and Check are never both shown, for any status", () => {
  // They occupy one table cell, so overlap would be a render bug. Also states the
  // invariant: exactly one of them, or neither (GOOD).
  for (const status of ["GOOD", "WARNING", "BAD", "UNKNOWN"] as const) {
    assert.equal(
      showFixButton({ status }) && showCheckButton({ status }),
      false,
      `both buttons rendered for ${status}`
    );
  }
});

test("every non-healthy status offers exactly one action", () => {
  // The dead end this fixes: a status with no route into PatternVerifyPanel.
  for (const status of ["WARNING", "BAD", "UNKNOWN"] as const) {
    assert.equal(
      showFixButton({ status }) || showCheckButton({ status }),
      true,
      `${status} has no button — dead end`
    );
  }
});

// --- the dialog's empty-state copy -----------------------------------------
// The dialog branches on this same predicate: showCheckButton(fixRow) picks
// "hasn't been checked yet", otherwise "No redirect URLs remain". Asserting the
// selector here rather than the DOM, since results/page.tsx has no component
// test harness.

test("empty dialog for an unscored pattern selects the not-checked copy", () => {
  assert.equal(showCheckButton({ status: "UNKNOWN" }), true);
});

test("empty dialog for a scored pattern keeps the clean-result copy", () => {
  // "No redirect URLs remain" is only truthful once something was measured.
  for (const status of ["GOOD", "WARNING", "BAD"] as const) {
    assert.equal(showCheckButton({ status }), false);
  }
});
