import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  disablePrivateRoute,
  isPrivateRouteDisabled,
  notePrivateRouteOutcome,
  PRIVATE_ROUTE_RECOVERY,
  privateRouteHealthSnapshot,
  resetPrivateRouteHealth
} from "./privateRouteHealth.js";

const STREAK = 3;

beforeEach(() => {
  resetPrivateRouteHealth();
});

test("nothing trips before the streak is reached", () => {
  assert.equal(notePrivateRouteOutcome("10.0.1.1", false, STREAK), null);
  assert.equal(notePrivateRouteOutcome("10.0.1.1", false, STREAK), null);
  assert.equal(isPrivateRouteDisabled("10.0.1.1"), false);
});

test("it trips at EXACTLY the configured streak, and reports it once", () => {
  notePrivateRouteOutcome("10.0.1.1", false, STREAK);
  notePrivateRouteOutcome("10.0.1.1", false, STREAK);

  const tripped = notePrivateRouteOutcome("10.0.1.1", false, STREAK);

  assert.equal(tripped?.ip, "10.0.1.1");
  assert.equal(tripped?.consecutiveFailures, STREAK);
  assert.equal(tripped?.recovers, PRIVATE_ROUTE_RECOVERY);
  assert.equal(isPrivateRouteDisabled("10.0.1.1"), true);

  // Reported ONCE. Every later failure returns null, so the caller logs and emits a
  // diagnostic event on the transition only — not once per URL for the rest of a
  // 1.3M-URL sweep.
  assert.equal(notePrivateRouteOutcome("10.0.1.1", false, STREAK), null);
  assert.equal(notePrivateRouteOutcome("10.0.1.1", false, STREAK), null);
});

// ANY http status means the route works. A 404 or a 403 still proves the request
// reached a web server over the private path; only "nothing answered" condemns it.
test("a single answered request resets the streak", () => {
  notePrivateRouteOutcome("10.0.1.1", false, STREAK);
  notePrivateRouteOutcome("10.0.1.1", false, STREAK);
  notePrivateRouteOutcome("10.0.1.1", true, STREAK);
  notePrivateRouteOutcome("10.0.1.1", false, STREAK);
  notePrivateRouteOutcome("10.0.1.1", false, STREAK);

  assert.equal(isPrivateRouteDisabled("10.0.1.1"), false);
});

test("streaks are per IP — one dead box does not condemn another", () => {
  for (let i = 0; i < STREAK; i += 1) {
    notePrivateRouteOutcome("10.0.1.1", false, STREAK);
    notePrivateRouteOutcome("10.0.2.2", true, STREAK);
  }

  assert.equal(isPrivateRouteDisabled("10.0.1.1"), true);
  assert.equal(isPrivateRouteDisabled("10.0.2.2"), false);
});

// The pre-probe's path: one request has already answered the question, so there is
// nothing to accumulate evidence about.
test("disablePrivateRoute abandons a route immediately, without a streak", () => {
  const tripped = disablePrivateRoute("10.0.1.1");

  assert.equal(tripped.consecutiveFailures, 1);
  assert.equal(tripped.recovers, PRIVATE_ROUTE_RECOVERY);
  assert.equal(isPrivateRouteDisabled("10.0.1.1"), true);
});

test("disabling an already-disabled route keeps the ORIGINAL record", () => {
  const first = disablePrivateRoute("10.0.1.1");
  const second = disablePrivateRoute("10.0.1.1");

  // Same disabledSince: an operator reading /api/private-routes needs to know when
  // the route actually died, not when it was last asked about.
  assert.equal(second.disabledSince, first.disabledSince);
  assert.equal(privateRouteHealthSnapshot().length, 1);
});

// DELIBERATELY NO RECOVERY. A half-open breaker retrying on a timer would alternate
// verdicts mid-sweep, so the same pattern's URLs would be measured over two different
// network paths and the numbers would mean nothing.
test("a disabled route NEVER re-enables itself, whatever happens next", () => {
  disablePrivateRoute("10.0.1.1");

  // Even a successful result — which cannot actually happen, since routing stops —
  // must not resurrect it.
  notePrivateRouteOutcome("10.0.1.1", true, STREAK);
  notePrivateRouteOutcome("10.0.1.1", true, STREAK);

  assert.equal(isPrivateRouteDisabled("10.0.1.1"), true);
});

test("the snapshot says recovery is manual, in words", () => {
  disablePrivateRoute("10.0.1.1");

  const [entry] = privateRouteHealthSnapshot();

  // A string, not a boolean: `disabled: true` reads as "recovers automatically?
  // unclear", and the natural assumption is a timer.
  assert.equal(entry.recoversOn, PRIVATE_ROUTE_RECOVERY);
  assert.match(entry.recoversOn, /never/);
  assert.equal(typeof entry.disabledSince, "number");
});
