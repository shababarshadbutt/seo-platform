import { strict as assert } from "node:assert";
import { test } from "node:test";

import { etaSecondsFrom, verifyProgress } from "./verify-progress";

const JOB = {
  id: "job-1",
  status: "RUNNING",
  urls_total: 0,
  urls_done: 0,
  enum_files_total: null as number | null,
  enum_files_done: null as number | null
};

test("a PENDING job is queued, with nothing to divide by", () => {
  // The reported bug: this state had no rendering, so a queued run looked exactly
  // like a hung one. It must not report a denominator — a determinate bar at 0%
  // is what made it indistinguishable.
  const progress = verifyProgress({ ...JOB, status: "PENDING" });

  assert.equal(progress.phase, "queued");
  assert.equal(progress.total, 0);
  assert.equal(progress.anchorKey, null);
});

test("the scan phase measures FILES", () => {
  const progress = verifyProgress({
    ...JOB,
    enum_files_total: 3,
    enum_files_done: 1
  });

  assert.equal(progress.phase, "files");
  assert.equal(progress.done, 1);
  assert.equal(progress.total, 3);
});

test("the probe phase measures URLS", () => {
  const progress = verifyProgress({
    ...JOB,
    urls_total: 1150,
    urls_done: 300
  });

  assert.equal(progress.phase, "urls");
  assert.equal(progress.done, 300);
  assert.equal(progress.total, 1150);
});

test("URLs win over a lingering file counter", () => {
  // enum_files_* is cleared when the scan ends, but a write already in flight can
  // land after. Checking urls first stops that dragging the display back to the
  // scan phase mid-probe.
  const progress = verifyProgress({
    ...JOB,
    urls_total: 1150,
    urls_done: 300,
    enum_files_total: 3,
    enum_files_done: 3
  });

  assert.equal(progress.phase, "urls");
});

test("the anchor key changes with the phase, not just the job", () => {
  // This is the whole reason the key exists. Reusing one anchor across the phase
  // boundary would predict URL throughput from a file rate — orders of magnitude
  // out, quoted exactly when someone starts watching.
  const scanning = verifyProgress({
    ...JOB,
    enum_files_total: 3,
    enum_files_done: 1
  });
  const probing = verifyProgress({ ...JOB, urls_total: 1150, urls_done: 10 });

  assert.equal(scanning.anchorKey, "job-1:files");
  assert.equal(probing.anchorKey, "job-1:urls");
  assert.notEqual(scanning.anchorKey, probing.anchorKey);
});

test("in flight with no denominator yet reports no phase", () => {
  // The window before either counter is published. Honest "unknown" rather than a
  // claim of zero progress.
  assert.equal(verifyProgress(JOB).phase, null);
  assert.equal(verifyProgress(null).phase, null);
});

test("no ETA until there is a real sample", () => {
  // One flush of the counter a couple of polls in makes the rate look infinite.
  assert.equal(
    etaSecondsFrom({ elapsedSeconds: 4, completed: 100, remaining: 900 }),
    null
  );
  assert.equal(
    etaSecondsFrom({ elapsedSeconds: 30, completed: 0, remaining: 900 }),
    null
  );
});

test("ETA comes from the measured rate", () => {
  // 100 in 20s = 5/s; 900 remaining = 180s.
  assert.equal(
    etaSecondsFrom({ elapsedSeconds: 20, completed: 100, remaining: 900 }),
    180
  );
});

test("ETA never goes negative", () => {
  // done can exceed total transiently — urls_done starts at the reused count and
  // the totals are written by separate statements.
  assert.equal(
    etaSecondsFrom({ elapsedSeconds: 20, completed: 100, remaining: -50 }),
    0
  );
});
