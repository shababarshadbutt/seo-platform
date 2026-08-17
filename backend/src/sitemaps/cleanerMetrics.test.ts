import assert from "node:assert/strict";
import { test } from "node:test";

import { CleanerMetrics, percentile } from "./cleanerMetrics.js";

// A fake clock so these assert exact durations rather than sleeping and hoping.
function fakeClock() {
  let now = 0;

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

test("add accumulates milliseconds under a key", () => {
  const metrics = new CleanerMetrics();

  metrics.add("a", 10);
  metrics.add("a", 5);
  metrics.add("b", 3);

  assert.equal(metrics.get("a"), 15);
  assert.equal(metrics.get("b"), 3);
  assert.equal(metrics.get("missing"), 0);
});

test("inc accumulates counters and defaults to 1", () => {
  const metrics = new CleanerMetrics();

  metrics.inc("files");
  metrics.inc("files");
  metrics.inc("bytes", 4096);

  assert.equal(metrics.count("files"), 2);
  assert.equal(metrics.count("bytes"), 4096);
});

test("observe records count, sum and max", () => {
  const metrics = new CleanerMetrics();

  for (const value of [5, 100, 20]) {
    metrics.observe("file_ms", value);
  }

  const { observations } = metrics.snapshot();

  assert.equal(observations.file_ms.count, 3);
  assert.equal(observations.file_ms.sum, 125);
  // The max is the point: one pathological file vanishes into a mean but is
  // exactly what a slow-run investigation is looking for.
  assert.equal(observations.file_ms.max, 100);
});

test("p95 reflects the tail, not the mean", () => {
  const metrics = new CleanerMetrics();

  // 99 fast files and one very slow one — the mean is ~14ms, the p95 must not be.
  for (let i = 0; i < 99; i += 1) {
    metrics.observe("file_ms", 5);
  }
  metrics.observe("file_ms", 1000);

  const { observations } = metrics.snapshot();

  assert.equal(observations.file_ms.count, 100);
  assert.equal(observations.file_ms.max, 1000);
  assert.equal(observations.file_ms.p95, 5);

  // And with a fatter tail the p95 moves, proving it is not pinned to the mode.
  const fat = new CleanerMetrics();

  for (let i = 0; i < 90; i += 1) {
    fat.observe("x", 1);
  }
  for (let i = 0; i < 10; i += 1) {
    fat.observe("x", 500);
  }

  assert.equal(fat.snapshot().observations.x.p95, 500);
});

test("percentile handles empty and single-sample inputs", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([42], 0.95), 42);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
});

test("timeAsync records the span and returns the value", async () => {
  const clock = fakeClock();
  const metrics = new CleanerMetrics({ now: clock.now });

  const value = await metrics.timeAsync("stage.pass1_ms", async () => {
    clock.advance(250);

    return "result";
  });

  assert.equal(value, "result");
  assert.equal(metrics.get("stage.pass1_ms"), 250);
});

test("timeAsync still records when the span throws", async () => {
  const clock = fakeClock();
  const metrics = new CleanerMetrics({ now: clock.now });

  await assert.rejects(
    metrics.timeAsync("stage.pass2_ms", async () => {
      clock.advance(40);
      throw new Error("boom");
    }),
    /boom/
  );

  // A run that failed halfway is exactly when the timing matters most.
  assert.equal(metrics.get("stage.pass2_ms"), 40);
});

test("start() returns the elapsed time and accumulates across calls", () => {
  const clock = fakeClock();
  const metrics = new CleanerMetrics({ now: clock.now });

  const end1 = metrics.start("pass2.worker_wait_ms");
  clock.advance(30);
  assert.equal(end1(), 30);

  const end2 = metrics.start("pass2.worker_wait_ms");
  clock.advance(70);
  end2();

  assert.equal(metrics.get("pass2.worker_wait_ms"), 100);
});

test("snapshot rounds totals and is stable across repeated calls", () => {
  const metrics = new CleanerMetrics();

  metrics.add("a", 1.4);
  metrics.add("a", 1.4);
  metrics.observe("o", 3);

  const first = metrics.snapshot();
  const second = metrics.snapshot();

  assert.equal(first.totals.a, 3);
  assert.deepEqual(first, second);
});
