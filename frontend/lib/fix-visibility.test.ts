import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  fixActionState,
  fixButtonState,
  hasStaleCountsAfterFix,
  showCheckButton,
  showFixButton,
  showFixedBadge
} from "./fix-visibility";

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

// --- the dialog's empty-state copy AND its auto-start ------------------------
// This one predicate drives three things that must agree: the Check button's
// visibility, the empty-state copy ("being re-checked" vs "No redirect URLs
// remain"), and autoStartRecheck — which is what makes Check actually check
// instead of just opening a panel. Asserting the selector here rather than the
// DOM, since results/page.tsx has no component test harness.

test("empty dialog for an unscored pattern selects the re-checking copy", () => {
  assert.equal(showCheckButton({ status: "UNKNOWN" }), true);
});

test("only an unscored row auto-starts a re-check on open", () => {
  // A scored row must not fire network requests just because its Fix modal was
  // opened — re-probing a measured pattern stays an explicit press.
  assert.equal(showCheckButton({ status: "UNKNOWN" }), true);

  for (const status of ["GOOD", "WARNING", "BAD"] as const) {
    assert.equal(showCheckButton({ status }), false, status);
  }
});

test("empty dialog for a scored pattern keeps the clean-result copy", () => {
  // "No redirect URLs remain" is only truthful once something was measured.
  for (const status of ["GOOD", "WARNING", "BAD"] as const) {
    assert.equal(showCheckButton({ status }), false);
  }
});

// ---------------------------------------------------------------------------
// fixButtonState — the grey "Fixed" chip
// ---------------------------------------------------------------------------
//
// THE REGRESSION THIS GUARDS. Applying a fix rewrites the sampled rows in place
// and the pattern is rescored, so a fixed pattern lands on GOOD and its button
// disappears — identical to a pattern that was healthy all along. On a table of
// hundreds of rows that left reviewers reopening patterns to find out whether
// they had already dealt with them.

const APPLIED = "2026-08-18T10:00:00.000Z";

test("an unfixed row behaves exactly as the two old predicates did", () => {
  assert.equal(fixButtonState({ status: "BAD" }), "fix");
  assert.equal(fixButtonState({ status: "WARNING" }), "fix");
  assert.equal(fixButtonState({ status: "UNKNOWN" }), "check");
  assert.equal(fixButtonState({ status: "GOOD" }), "none");
});

test("a null stamp is the same as no stamp at all", () => {
  // The column is nullable and older patterns predate it, so NULL must read as
  // "never fixed" rather than as a value.
  assert.equal(fixButtonState({ status: "BAD", redirectsAppliedAt: null }), "fix");
  assert.equal(
    fixButtonState({ status: "GOOD", redirectsAppliedAt: null }),
    "none"
  );
});

// The whole point: the chip must survive the rescore that follows a fix, which
// is precisely when the row turns GOOD and the old rule rendered nothing.
test("a fixed pattern reads as fixed once it is rescored healthy", () => {
  assert.equal(
    fixButtonState({ status: "GOOD", redirectsAppliedAt: APPLIED }),
    "fixed"
  );
});

// "fixed" is a fact about what was DONE to the pattern, not a reading of its
// current measurement, so no status may override it. A pattern that was fixed
// and has since gone Broken again still shows it was fixed — the row's own
// Status cell reports the current verdict.
test("fixed outranks every status, including a later regression to BAD", () => {
  for (const status of ["GOOD", "WARNING", "BAD", "UNKNOWN"] as const) {
    assert.equal(
      fixButtonState({ status, redirectsAppliedAt: APPLIED }),
      "fixed",
      status
    );
  }
});

// showCheckButton drives autoStartRecheck and the modal's empty-state copy, so a
// fixed-but-unscored row must not silently start probing the site again.
test("fixed outranks check, so a fixed row does not auto-start a re-check", () => {
  assert.equal(
    fixButtonState({ status: "UNKNOWN", redirectsAppliedAt: APPLIED }),
    "fixed"
  );
  assert.notEqual(
    fixButtonState({ status: "UNKNOWN", redirectsAppliedAt: APPLIED }),
    "check"
  );
});

// --- badge and action are separate answers (v1.74) --------------------------

const FIXED_BROKEN = {
  status: "BAD" as const,
  redirectsAppliedAt: "2026-08-21T02:30:00Z"
};

test("a fixed pattern still offers the Fix action", () => {
  // The regression this closes: fixButtonState returns "fixed", the row rendered
  // an inert chip INSTEAD of the button, and a fixed pattern became a dead end —
  // exactly the wall hit on the reported session, where two patterns showed Fixed
  // and there was no way to reopen either.
  assert.equal(fixButtonState(FIXED_BROKEN), "fixed");
  assert.equal(fixActionState(FIXED_BROKEN), "fix");
  assert.equal(showFixedBadge(FIXED_BROKEN), true);
});

test("the badge does not invent an action where there was none", () => {
  // A fixed pattern that is now Healthy has nothing to fix and nothing to check.
  // The badge is still true; the action must not be conjured up to match it.
  const healthy = { status: "GOOD" as const, redirectsAppliedAt: "2026-08-21T02:30:00Z" };

  assert.equal(showFixedBadge(healthy), true);
  assert.equal(fixActionState(healthy), "none");
});

test("a fixed UNKNOWN pattern still offers Check, not Fix", () => {
  // The action keeps deferring to status, which is the distinction showFixButton
  // and showCheckButton exist to keep apart. Being fixed once does not turn
  // "never measured" into "confirmed broken".
  const unknown = {
    status: "UNKNOWN" as const,
    redirectsAppliedAt: "2026-08-21T02:30:00Z"
  };

  assert.equal(fixActionState(unknown), "check");
});

test("an unfixed pattern has no badge and its action is unchanged", () => {
  const unfixed = { status: "BAD" as const, redirectsAppliedAt: null };

  assert.equal(showFixedBadge(unfixed), false);
  assert.equal(fixActionState(unfixed), fixButtonState(unfixed));
});

// --- stale counts after a fix ------------------------------------------------

test("counts are stale exactly once a fix has run", () => {
  // apply-redirects rewrites the files and never re-extracts the pattern's URLs,
  // so after a fix the occurrence count describes files that no longer exist in
  // that shape. This is the root cause of "0 URLs updated" and of "No source
  // files found" appearing beside a six-figure occurrence count.
  assert.equal(hasStaleCountsAfterFix(FIXED_BROKEN), true);
  assert.equal(hasStaleCountsAfterFix({ redirectsAppliedAt: null }), false);
  assert.equal(hasStaleCountsAfterFix({}), false);
});
