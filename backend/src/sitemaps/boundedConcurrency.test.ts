import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runWithBoundedConcurrency } from "./boundedConcurrency.js";

// The Cleaner handoff ingest and the SFTP pull both work through thousands of
// files through this scheduler, so the things that would break quietly are worth
// pinning: exceeding the concurrency ceiling (which would blow past the DB pool),
// misaligning results with inputs (which would attribute one file's failure to
// another), and a progress counter that repeats or goes backwards (which drives a
// visible bar).

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("runWithBoundedConcurrency", () => {
  it("never exceeds the concurrency ceiling", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;

    await runWithBoundedConcurrency(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Several yields, so a broken scheduler has every chance to overlap more
      // than it should.
      await tick();
      await tick();
      inFlight -= 1;

      return item;
    });

    assert.equal(peak, 4, `peak concurrency was ${peak}, expected exactly 4`);
  });

  it("actually runs in parallel rather than one at a time", async () => {
    // Guards the opposite mistake: a "concurrent" scheduler that accidentally
    // awaits each item in sequence would still satisfy the ceiling test.
    const items = Array.from({ length: 8 }, (_, i) => i);
    let peak = 0;
    let inFlight = 0;

    await runWithBoundedConcurrency(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;

      return item;
    });

    assert.ok(peak > 1, "no two tasks ever overlapped");
  });

  it("returns results index-aligned with the inputs despite out-of-order completion", async () => {
    const items = ["a", "b", "c", "d", "e", "f"];

    const results = await runWithBoundedConcurrency(items, 3, async (item, index) => {
      // Reverse the natural finishing order: later items settle first.
      for (let i = 0; i < items.length - index; i += 1) {
        await tick();
      }

      return `${item}:${index}`;
    });

    assert.deepEqual(results, ["a:0", "b:1", "c:2", "d:3", "e:4", "f:5"]);
  });

  it("gives every index to exactly one task", async () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const seen = new Map<number, number>();

    await runWithBoundedConcurrency(items, 8, async (item, index) => {
      seen.set(index, (seen.get(index) ?? 0) + 1);
      await tick();

      return item;
    });

    assert.equal(seen.size, 200);
    assert.deepEqual(
      [...seen.values()].filter((count) => count !== 1),
      [],
      "an index was claimed by more than one worker"
    );
  });

  it("reports completion counts 1..N exactly once each, in order", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const counts: number[] = [];

    await runWithBoundedConcurrency(
      items,
      5,
      async (item) => {
        await tick();

        return item;
      },
      (_result, completed, total) => {
        assert.equal(total, 30);
        counts.push(completed);
      }
    );

    assert.deepEqual(
      counts,
      Array.from({ length: 30 }, (_, i) => i + 1),
      "progress counts were not a clean 1..N sequence"
    );
  });

  it("keeps going after a task settles a failure", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);

    const results = await runWithBoundedConcurrency(items, 3, async (item) => {
      await tick();

      // The contract: tasks settle failures rather than throwing.
      return item === 4 ? { ok: false, item } : { ok: true, item };
    });

    assert.equal(results.length, 10);
    assert.equal(results.filter((r) => r.ok).length, 9);
    assert.deepEqual(results[4], { ok: false, item: 4 });
  });

  it("caps workers at the item count for a short list", async () => {
    let peak = 0;
    let inFlight = 0;

    await runWithBoundedConcurrency([1, 2], 16, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;

      return item;
    });

    assert.equal(peak, 2);
  });

  it("treats a concurrency below 1 as 1 rather than doing nothing", async () => {
    const results = await runWithBoundedConcurrency([1, 2, 3], 0, async (i) => i * 2);

    assert.deepEqual(results, [2, 4, 6]);
  });

  it("does nothing, successfully, for an empty list", async () => {
    let called = false;

    const results = await runWithBoundedConcurrency([], 4, async (item) => {
      called = true;

      return item;
    });

    assert.deepEqual(results, []);
    assert.equal(called, false);
  });
});
