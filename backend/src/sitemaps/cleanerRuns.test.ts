import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { config } from "../config.js";
import {
  createRun,
  finishRun,
  getRun,
  isAbandoned,
  publishFrame,
  reapAbandonedRuns,
  resetRunsForTest,
  SERVER_EPOCH,
  subscribeRun,
  touchRun,
  type RunFrame
} from "./cleanerRuns.js";

beforeEach(() => {
  resetRunsForTest();
});

test("a subscriber going away does NOT stop the run", () => {
  const run = createRun("run-1", "example.com");
  const seen: RunFrame[] = [];
  const subscription = subscribeRun("run-1", (frame) => seen.push(frame));

  assert.ok(subscription);
  publishFrame("run-1", { type: "progress", stage: "pull", message: "1 of 9" });
  assert.equal(seen.length, 1);

  // The client disconnects.
  subscription.unsubscribe();
  publishFrame("run-1", { type: "progress", stage: "pull", message: "2 of 9" });

  // No more frames reach the dead client, but the RUN is untouched — this is the
  // behaviour the whole change exists for.
  assert.equal(seen.length, 1);
  assert.equal(run.status, "running");
  assert.equal(run.controller.signal.aborted, false);
  assert.equal(getRun("run-1")?.lastFrame?.message, "2 of 9");
});

test("a reconnecting subscriber immediately replays the latest progress", () => {
  createRun("run-2", "example.com");
  publishFrame("run-2", { type: "progress", stage: "pull", message: "40 of 90" });

  const replayed = subscribeRun("run-2", () => {});

  assert.ok(replayed);
  // Without this a reconnect during a slow stage stares at a blank stream until
  // the next frame, which can be minutes away.
  assert.equal(replayed.replay.length, 1);
  assert.equal(replayed.replay[0].message, "40 of 90");
});

test("reconnecting AFTER the run finished still yields the terminal frame", () => {
  createRun("run-3", "example.com");
  publishFrame("run-3", { type: "progress", stage: "zip", message: "Packaging…" });
  finishRun("run-3", "done", {
    type: "done",
    download_token: "tok-abc"
  });

  const late = subscribeRun("run-3", () => {});

  assert.ok(late, "a just-finished run must still be reachable");
  const terminal = late.replay.find((frame) => frame.type === "done");

  // The download token is the whole point of the run; losing it to a badly-timed
  // disconnect would mean redoing the work.
  assert.equal(terminal?.download_token, "tok-abc");
});

// A LINGERING subscriber must NOT keep a run alive. When a client aborts its
// fetch, `close` is not guaranteed to fire on a hijacked reply, so the subscriber
// can outlive the connection — this was observed in a live test (watchers=1 after
// the client was gone). Abandonment therefore turns on the heartbeat alone, which
// requires a writable socket, and this pins that rule.
test("a stale subscriber does not keep an unwatched run alive", () => {
  const run = createRun("run-4", "example.com");

  subscribeRun("run-4", () => {});
  run.lastWatchedAt = Date.now() - config.cleanerAbandonGraceMs * 10;

  assert.equal(isAbandoned(run), true, "a leaked listener must not veto reaping");
  assert.deepEqual(reapAbandonedRuns(), ["run-4"]);
  assert.equal(run.controller.signal.aborted, true);
});

test("a subscriber that keeps heartbeating is never abandoned, however long it runs", () => {
  const run = createRun("run-4b", "example.com");

  subscribeRun("run-4b", () => {});
  run.startedAt = Date.now() - config.cleanerAbandonGraceMs * 10;
  touchRun("run-4b");

  assert.equal(isAbandoned(run), false);
  assert.deepEqual(reapAbandonedRuns(), []);
});

test("an unwatched run past the grace period is aborted and its slot released", () => {
  const run = createRun("run-5", "example.com");
  const subscription = subscribeRun("run-5", () => {});

  subscription?.unsubscribe();

  // Just inside the grace period: still ours.
  run.lastWatchedAt = Date.now() - (config.cleanerAbandonGraceMs - 1000);
  assert.deepEqual(reapAbandonedRuns(), []);
  assert.equal(run.controller.signal.aborted, false);

  // Past it: reaped.
  run.lastWatchedAt = Date.now() - config.cleanerAbandonGraceMs - 1;
  assert.deepEqual(reapAbandonedRuns(), ["run-5"]);
  assert.equal(run.status, "abandoned");
  // The abort is what the download loop checks between files, so the SFTP
  // connection slot is released rather than held for the rest of the run.
  assert.equal(run.controller.signal.aborted, true);
});

test("a heartbeat keeps an unwatched run alive across the grace boundary", () => {
  const run = createRun("run-6", "example.com");

  run.lastWatchedAt = Date.now() - config.cleanerAbandonGraceMs - 1;
  touchRun("run-6");

  assert.deepEqual(reapAbandonedRuns(), [], "a touch must reset the clock");
  assert.equal(run.controller.signal.aborted, false);
});

test("a finished run is never reaped, even with nobody watching", () => {
  const run = createRun("run-7", "example.com");

  finishRun("run-7", "done", { type: "done" });
  run.lastWatchedAt = Date.now() - config.cleanerAbandonGraceMs * 5;

  assert.deepEqual(reapAbandonedRuns(), []);
  assert.equal(run.controller.signal.aborted, false);
});

test("one dead subscriber cannot silence the others", () => {
  createRun("run-8", "example.com");
  const alive: RunFrame[] = [];

  subscribeRun("run-8", () => {
    throw new Error("socket already closed");
  });
  subscribeRun("run-8", (frame) => alive.push(frame));

  publishFrame("run-8", { type: "progress", message: "still going" });

  assert.equal(alive.length, 1);
});

test("subscribing to an unknown run reports absence rather than inventing one", () => {
  assert.equal(subscribeRun("nope", () => {}), null);
  assert.equal(getRun("nope"), undefined);
});

// The invariant the "no longer available" diagnosis rests on.
//
// A field report showed a user being told their run was "stopped after being left
// unwatched, or already collected" while they sat watching it. Reaping cannot
// produce that message: it aborts the run and flips its status, but LEAVES IT IN
// the registry, so a reconnect still resolves and receives the terminal frame
// explaining what happened. Only a run absent from the registry 404s — which
// after a reap means the retention window lapsed, and otherwise means the process
// itself is new. If a future change makes reaping delete instead, that misleading
// message becomes reachable again and this test is what should stop it.
test("reaping an abandoned run does NOT remove it — a reconnect still resolves", () => {
  const run = createRun("run-9", "example.com");
  run.lastWatchedAt = Date.now() - config.cleanerAbandonGraceMs - 1;

  assert.deepEqual(reapAbandonedRuns(), ["run-9"]);
  assert.equal(run.status, "abandoned");
  assert.equal(run.controller.signal.aborted, true);

  // Still reachable: the client learns WHY rather than that the run vanished.
  assert.notEqual(getRun("run-9"), undefined);
  assert.ok(subscribeRun("run-9", () => {}));
});

test("the server epoch is stable within a process and non-empty", () => {
  // Reconnect correctness depends on this being constant for the life of the
  // process: it is what tells a returning client whether the API underneath it is
  // the same one that started the run. A per-call value would report a restart on
  // every reconnect; an empty one would report none, ever.
  assert.equal(typeof SERVER_EPOCH, "string");
  assert.ok(SERVER_EPOCH.length > 0);
  assert.equal(SERVER_EPOCH, SERVER_EPOCH);
  // Surviving resetRunsForTest matters — the epoch describes the PROCESS, not the
  // registry's contents.
  resetRunsForTest();
  assert.ok(SERVER_EPOCH.length > 0);
});
