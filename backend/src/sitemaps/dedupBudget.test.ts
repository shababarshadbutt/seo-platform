import assert from "node:assert/strict";
import { test } from "node:test";
import v8 from "node:v8";

import {
  CleanerCapacityError,
  admitDedupRun,
  approxUrlCeiling,
  chargeDedupBytes,
  dedupBudgetBytes,
  dedupEntryCost,
  dedupLedger,
  releaseDedupRun,
  resetDedupLedgerForTest,
  setDedupBudgetForTest
} from "./dedupBudget.js";

function reset() {
  setDedupBudgetForTest(null);
  resetDedupLedgerForTest();
}

// assert.throws returns void, so it cannot hand back the error to inspect. These
// tests assert on the numbers CARRIED by the error (the whole point of the
// typed error is that the message can name them), so capture it directly.
function capture(fn: () => void): CleanerCapacityError {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof CleanerCapacityError,
      `expected CleanerCapacityError, got ${String(error)}`
    );

    return error;
  }

  throw new assert.AssertionError({ message: "expected a throw, got none" });
}

test("the ceiling is derived from the live heap limit, not a constant", () => {
  reset();

  // The whole reason this is computed rather than configured: the budget must
  // move with --max-old-space-size automatically, so the guard and the heap can
  // never drift apart. Assert the actual relationship holds.
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  assert.ok(heapLimit > 0);
  assert.equal(dedupBudgetBytes(), Math.floor(heapLimit * 0.55));

  // And it must be a usable number of URLs, not an accidental zero.
  assert.ok(approxUrlCeiling() > 1_000_000);
});

test("cost is charged per byte, so long URLs cost more than short ones", () => {
  reset();

  const short = dedupEntryCost(40);
  const long = dedupEntryCost(120);

  assert.ok(long > short);

  // A URL-COUNT ceiling cannot express this: the same count of 120-char URLs
  // costs ~1.7x the 40-char corpus, which is the error a count-based guard makes.
  assert.ok(long / short > 1.5);

  // Peak factor is applied (16 header + len + 43 table) * 1.6.
  assert.equal(dedupEntryCost(80), Math.ceil((16 + 80 + 43) * 1.6));
});

test("a single run is stopped at the budget with the real numbers named", () => {
  reset();
  setDedupBudgetForTest(10_000);

  admitDedupRun("solo");
  chargeDedupBytes("solo", 9_000, 50);

  const error = capture(() => chargeDedupBytes("solo", 2_000, 60));

  // The message must name the actual count and the ceiling — "too large" sends
  // the user nowhere.
  assert.match(error.message, /60/);
  assert.equal(error.uniqueUrls, 60);
  assert.ok(error.bytes > error.budgetBytes);
});

test("TWO runs each legal alone are stopped when TOGETHER they exceed budget", () => {
  reset();
  setDedupBudgetForTest(10_000);

  admitDedupRun("a");
  admitDedupRun("b");

  // 4,000 each: comfortably legal for either run on its own.
  chargeDedupBytes("a", 4_000, 100);
  chargeDedupBytes("b", 4_000, 100);
  assert.equal(dedupLedger().totalBytes, 8_000);
  assert.equal(dedupLedger().runs, 2);

  // A third increment that either run could afford alone crosses the SHARED
  // total. This is the case a per-run ceiling cannot catch no matter how it is
  // sized, and it is why the ledger is process-wide.
  const error = capture(() => chargeDedupBytes("b", 4_000, 200));

  assert.equal(error.concurrentRuns, 2);
  assert.match(error.message, /other run/);

  // The run that tried to cross the line is the one that failed; the other keeps
  // its charge and its progress.
  assert.equal(dedupLedger().totalBytes, 8_000);
});

test("releasing a run returns its bytes to the shared budget", () => {
  reset();
  setDedupBudgetForTest(10_000);

  admitDedupRun("a");
  chargeDedupBytes("a", 8_000, 100);
  assert.equal(dedupLedger().totalBytes, 8_000);

  releaseDedupRun("a");

  // A leaked charge would permanently shrink the budget for every later run and
  // need a restart to recover — the exact failure this accounting prevents.
  assert.equal(dedupLedger().totalBytes, 0);
  assert.equal(dedupLedger().runs, 0);

  // So the budget is fully available again.
  admitDedupRun("b");
  chargeDedupBytes("b", 9_000, 100);
  assert.equal(dedupLedger().totalBytes, 9_000);
});

test("releasing an unknown run is a no-op, not a negative total", () => {
  reset();
  setDedupBudgetForTest(10_000);

  admitDedupRun("a");
  chargeDedupBytes("a", 5_000, 10);

  releaseDedupRun("never-existed");
  releaseDedupRun("a");
  releaseDedupRun("a"); // double release must not go negative

  assert.equal(dedupLedger().totalBytes, 0);
});

test("a NEW run is refused up front once the budget is nearly spent", () => {
  reset();
  setDedupBudgetForTest(10_000);

  admitDedupRun("big");
  chargeDedupBytes("big", 8_500, 100); // past the 80% admission watermark

  // Refused before it starts, rather than after it has spent minutes pulling
  // over SFTP and parsing only to die on its first dedup entry.
  const error = capture(() => admitDedupRun("latecomer"));

  assert.match(error.message, /already in progress|memory limit/i);
  assert.equal(error.concurrentRuns, 1);
});

test("a new run is admitted while there is still headroom", () => {
  reset();
  setDedupBudgetForTest(10_000);

  admitDedupRun("a");
  chargeDedupBytes("a", 4_000, 100); // 40% — below the watermark

  assert.doesNotThrow(() => admitDedupRun("b"));
  assert.equal(dedupLedger().runs, 2);
});
