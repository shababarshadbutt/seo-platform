import assert from "node:assert/strict";
import { test } from "node:test";

import { mapWithConcurrency, workerCountForFiles } from "./fileRewritePool.js";

// The pattern rewrite ladder: one worker thread per 500 files, capped at 4.
// piscina's maxThreads belongs to the shared pool and can't be varied per job,
// so this number is enforced by capping in-flight pool.run() calls instead —
// which makes mapWithConcurrency load-bearing, not a convenience.

test("thread ladder: one thread per 500 files, at least 1, capped at 4", () => {
  // Boundaries matter more than the middle: 500 must still be 1 thread and 501
  // must be 2, or the ladder is off by one rung everywhere above it.
  assert.equal(workerCountForFiles(0), 1);
  assert.equal(workerCountForFiles(1), 1);
  assert.equal(workerCountForFiles(499), 1);
  assert.equal(workerCountForFiles(500), 1);
  assert.equal(workerCountForFiles(501), 2);
  assert.equal(workerCountForFiles(1000), 2);
  assert.equal(workerCountForFiles(1001), 3);
  assert.equal(workerCountForFiles(1500), 3);
  assert.equal(workerCountForFiles(1501), 4);
  assert.equal(workerCountForFiles(50000), 4);
});

test("thread ladder never returns 0, so a job always makes progress", () => {
  for (const count of [-5, 0, 1]) {
    assert.ok(workerCountForFiles(count) >= 1);
  }
});

test("mapWithConcurrency never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;

  await mapWithConcurrency(
    Array.from({ length: 40 }, (_, index) => index),
    3,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    }
  );

  assert.equal(peak, 3);
});

test("mapWithConcurrency settles EVERY task even when one rejects", async () => {
  // This is the whole reason it isn't Promise.all. These tasks run alongside an
  // open transaction; a first-failure reject would return while stragglers were
  // still in flight, and those stragglers would then query a client the catch
  // block had already released — an unhandled rejection that kills the worker.
  const finished: number[] = [];

  const results = await mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, item === 0 ? 0 : 5));

    if (item === 0) {
      throw new Error("boom");
    }

    finished.push(item);
    return item * 10;
  });

  assert.equal(results.length, 5);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(finished.sort(), [1, 2, 3, 4]);

  for (const index of [1, 2, 3, 4]) {
    const entry = results[index];
    assert.equal(entry.status, "fulfilled");
    assert.equal(
      entry.status === "fulfilled" ? entry.value : null,
      index * 10
    );
  }
});

test("mapWithConcurrency keeps results in INPUT order, not completion order", async () => {
  // Phase 2 walks these results to build the undo record, so a set that
  // depended on which worker happened to finish first would make undo
  // non-deterministic.
  const results = await mapWithConcurrency(
    [30, 20, 10, 0],
    4,
    async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    }
  );

  assert.deepEqual(
    results.map((entry) => (entry.status === "fulfilled" ? entry.value : null)),
    [0, 1, 2, 3]
  );
});

test("mapWithConcurrency handles an empty list without hanging", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});
