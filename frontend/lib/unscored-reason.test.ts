import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  analysisSettled,
  unscoredReasonFor,
  unscoredReasonLabel
} from "./unscored-reason";

const blocked = { http_status_category: "blocked" };
const notFound = { http_status_category: "failure" };
const ok = { http_status_category: "success" };

// Most cases below are about a FINISHED analysis, which is when an unscored row is
// a finding rather than a queue position.
const DONE = true;

// THE REGRESSION THIS GUARDS. A fresh analysis of a WAF-fronted site produced a
// pattern table where every row read "Not scored / 0% / 0%", identical to a session
// nobody had finished analysing. Both are status UNKNOWN — patternScore is right
// about that, a blocked sample is not a measurement — but they need opposite
// actions, and the table said nothing that could tell them apart.

test("sampled and wholly blocked reads as blocked, not as unsampled", () => {
  assert.equal(
    unscoredReasonFor("UNKNOWN", "current", [blocked, blocked, blocked], DONE),
    "blocked"
  );
});

test("no samples at all reads as not-sampled", () => {
  assert.equal(unscoredReasonFor("UNKNOWN", "current", [], DONE), "not-sampled");
});

// The two cases that made this necessary are distinguishable, and that is the
// whole point — asserted together so a future change cannot collapse them again.
test("blocked and not-sampled never produce the same answer", () => {
  assert.notEqual(
    unscoredReasonFor("UNKNOWN", "current", [blocked], DONE),
    unscoredReasonFor("UNKNOWN", "current", [], DONE)
  );
});

// --- the negative controls, which matter most -------------------------------
// This label must never appear on a row that HAS a measurement. An explanation
// attached to a scored row is a claim about data we did measure, and wrong.

test("a scored pattern gets no reason, whatever its samples say", () => {
  for (const status of ["GOOD", "WARNING", "BAD"] as const) {
    assert.equal(unscoredReasonFor(status, "current", [], DONE), null, status);
    assert.equal(unscoredReasonFor(status, "current", [blocked], DONE), null, status);
  }
});

test("a MIX of blocked and real results gets no reason", () => {
  // Such a pattern is not unscored in the first place: patternScore scores it off
  // the measurable rows. If a stale row ever arrives here, inventing an
  // explanation for it would be a guess, so the rule stays silent.
  assert.equal(
    unscoredReasonFor("UNKNOWN", "current", [blocked, notFound], DONE),
    null
  );
  assert.equal(unscoredReasonFor("UNKNOWN", "current", [blocked, ok], DONE), null);
});

test("legacy patterns get no reason — they are never sampled by design", () => {
  // They exist to be compared against the current set, so "no URLs sampled" would
  // be true and meaningless on every single one.
  assert.equal(unscoredReasonFor("UNKNOWN", "legacy", [], DONE), null);
  assert.equal(unscoredReasonFor("UNKNOWN", "legacy", [blocked], DONE), null);
});

test("one non-blocked sample is enough to withhold the blocked reason", () => {
  // Guards against an `some`-instead-of-`every` slip, which would label a mostly-
  // fine pattern as refused.
  assert.equal(
    unscoredReasonFor("UNKNOWN", "current", [
      blocked,
      blocked,
      blocked,
      notFound
    ], DONE),
    null
  );
});

test("a null category is not treated as blocked", () => {
  // A transport failure (no HTTP status at all) is unreachability, not a refusal.
  assert.equal(
    unscoredReasonFor("UNKNOWN", "current", [{ http_status_category: null }], DONE),
    null
  );
});

// --- a run that has not finished yet ----------------------------------------
// Unscored is the ORDINARY state of a pattern that has not been reached yet. The
// costly mistake here is not silence, it is telling someone their site is refusing
// us — and to go ask a third party for a WAF allowlist — because a sampling pass is
// still working through its queue.

test("an unsampled pattern says nothing while the analysis is still running", () => {
  assert.equal(unscoredReasonFor("UNKNOWN", "current", [], false), null);
});

test("a blocked pattern DOES say so mid-run — the block already happened", () => {
  // Unlike "no URLs sampled", this is a measurement, not an absence of one. It is
  // just as true at 40% through the run as at the end.
  assert.equal(
    unscoredReasonFor("UNKNOWN", "current", [blocked, blocked], false),
    "blocked"
  );
});

test("only terminal session statuses count as settled", () => {
  for (const status of ["COMPLETE", "COMPLETED", "FAILED", "CANCELLED"] as const) {
    assert.equal(analysisSettled(status), true, status);
  }

  for (const status of [
    "PENDING",
    "PROCESSING",
    "EXTRACTING",
    "EXTRACTED",
    "SAMPLING"
  ] as const) {
    assert.equal(analysisSettled(status), false, status);
  }
});

test("an unknown or missing status is NOT treated as settled", () => {
  // Both spellings of "we have not loaded the session yet". Defaulting to settled
  // would flash the allowlist advice on first paint of a running session.
  assert.equal(analysisSettled(undefined), false);
  assert.equal(analysisSettled("SOMETHING_NEW"), false);
});

// --- the copy ---------------------------------------------------------------

test("the blocked label states the count and uses the same verb as the banners", () => {
  assert.equal(
    unscoredReasonLabel("blocked", 10),
    "site refused all 10 checks"
  );
});

test("the blocked label is singular for one check", () => {
  assert.equal(unscoredReasonLabel("blocked", 1), "site refused all 1 check");
});

test("the blocked label groups thousands, like every other count on the page", () => {
  assert.equal(
    unscoredReasonLabel("blocked", 1000),
    "site refused all 1,000 checks"
  );
});

test("the not-sampled label claims nothing about the site", () => {
  // Deliberately says nothing about blocking or health: at this point we genuinely
  // do not know, and the previous copy implying "nobody checked" on a pattern that
  // WAS checked and blocked is the bug this whole rule exists to fix.
  assert.equal(unscoredReasonLabel("not-sampled", 0), "no URLs sampled");
});
