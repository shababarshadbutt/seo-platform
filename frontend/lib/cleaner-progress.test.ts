import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activeStep,
  cleanerProgressInitial,
  CLEANER_STEPS,
  overallFromFractions,
  reduceCleanerProgress,
  reduceCleanerUploadProgress,
  type CleanerRunProgress
} from "./cleaner-progress.js";

// The Sitemap Cleaner's progress reducer is the one piece of this feature with
// real logic and no React or network in it — which is why it was extracted. The
// bugs it exists to prevent are all "the bar froze / blanked / went backwards",
// and every one of them shipped at least once.

const FILES = 1681;

function progress(
  stage: string,
  current?: number,
  total?: number,
  seq?: number
) {
  return {
    type: "progress" as const,
    stage,
    message: `${stage} frame`,
    current,
    total,
    seq
  };
}

function apply(
  state: CleanerRunProgress,
  frames: { stage: string; current?: number; total?: number }[],
  startAt = 1000
) {
  let next = state;
  let now = startAt;

  for (const frame of frames) {
    now += 250;
    const before = next.overallPercent;

    next = reduceCleanerProgress(next, progress(frame.stage, frame.current, frame.total), now);
    assert.ok(
      next.overallPercent >= before,
      `bar regressed at ${frame.stage}: ${before} -> ${next.overallPercent}`
    );
  }

  return next;
}

test("the bar advances monotonically through a whole run", () => {
  const done = apply(cleanerProgressInitial(FILES, 0), [
    { stage: "upload", current: 0, total: FILES },
    { stage: "upload", current: 800, total: FILES },
    { stage: "upload", current: FILES, total: FILES },
    { stage: "parse", current: 400, total: FILES },
    { stage: "parse", current: FILES, total: FILES },
    { stage: "dedup" },
    { stage: "output", current: FILES, total: FILES },
    { stage: "index" },
    { stage: "zip", current: 10, total: 10 }
  ]);

  assert.equal(done.overallPercent, 100);
  assert.equal(done.step, "package");
});

test("counterless stages never blank the panel", () => {
  // v1.49's actual bug: dedup/index/zip carried no current/total, the page
  // called setProgress(null), and the bar vanished mid-run.
  const before = apply(cleanerProgressInitial(FILES, 0), [
    { stage: "upload", current: FILES, total: FILES },
    { stage: "parse", current: FILES, total: FILES }
  ]);
  const after = apply(before, [{ stage: "dedup" }], 5000);

  assert.equal(after.determinate, false, "dedup must read as indeterminate");
  assert.ok(after.overallPercent >= before.overallPercent, "bar must not blank");
  assert.notEqual(after.label, "", "label must not blank");
  assert.equal(after.stepFraction.read, 1, "an earlier step must stay complete");
});

// ---- The v1.51 regression this rewrite exists to prevent -------------------

test("an upload frame arriving AFTER a parse frame still advances the upload term", () => {
  // Under batching, batch 0 finishes parsing while batches 1..33 are still
  // uploading. v1.50 dropped any frame from a step below the current one, so at
  // this exact moment the upload display went permanently dead. This is the
  // single assertion that pins the fix.
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerProgress(state, progress("upload", 50, FILES), 1000);
  state = reduceCleanerProgress(state, progress("parse", 50, FILES), 1500);

  const uploadBefore = state.stepFraction.upload;

  state = reduceCleanerProgress(state, progress("upload", 900, FILES), 2000);

  assert.ok(
    state.stepFraction.upload > uploadBefore,
    "a later upload frame was ignored — the upload display is frozen again"
  );
  assert.equal(state.current, 900);
});

test("client byte progress keeps flowing once parsing has started", () => {
  // Same regression, other half: reduceCleanerUploadProgress used to return
  // early whenever stepIndex > 0, killing the XHR-driven bar.
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerProgress(state, progress("parse", 100, FILES), 1000);

  const before = state.stepFraction.upload;

  state = reduceCleanerUploadProgress(
    state,
    { loadedBytes: 60, totalBytes: 100, transferredFiles: 900, totalFiles: FILES, percent: 60 },
    1500
  );

  assert.ok(state.stepFraction.upload > before, "XHR byte progress was ignored");
  assert.ok(state.overallPercent > 0);
});

test("two steps can be in progress at once", () => {
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerProgress(state, progress("upload", 800, FILES), 1000);
  state = reduceCleanerProgress(state, progress("parse", 200, FILES), 1200);

  assert.ok(state.stepFraction.upload > 0 && state.stepFraction.upload < 1);
  assert.ok(state.stepFraction.read > 0 && state.stepFraction.read < 1);
  // Highlight the furthest step that has started but not finished.
  assert.equal(activeStep(state.stepFraction), "upload");
});

test("no step fraction can ever decrease", () => {
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerProgress(state, progress("upload", 1600, FILES), 1000);

  const high = state.stepFraction.upload;

  // A stale/duplicated frame reporting less progress must be absorbed.
  state = reduceCleanerProgress(state, progress("upload", 12, FILES), 1200);

  assert.equal(state.stepFraction.upload, high);
});

test("the seq guard drops replayed frames after a reconnect", () => {
  let state = cleanerProgressInitial(100, 0);

  state = reduceCleanerProgress(state, progress("parse", 50, 100, 7), 1000);

  const after = state.overallPercent;

  state = reduceCleanerProgress(state, progress("parse", 1, 100, 3), 1100);

  assert.equal(state.overallPercent, after, "a replayed frame was applied");
});

test("entering a later step completes the earlier ones", () => {
  // The backend sends no closing 100% frame per stage, so without this the bar
  // would stall a few percent short for the entire run.
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerProgress(state, progress("upload", 5, FILES), 1000);
  state = reduceCleanerProgress(state, progress("zip", 3, 3), 2000);

  assert.equal(state.stepFraction.upload, 1);
  assert.equal(state.stepFraction.read, 1);
  assert.equal(state.stepFraction.clean, 1);
  assert.equal(state.overallPercent, 100);
});

test("an unknown backend stage holds the current step and uses its message", () => {
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerProgress(state, progress("parse", 100, FILES), 1000);

  const before = state.step;

  state = reduceCleanerProgress(
    state,
    { type: "progress", stage: "brand-new-stage", message: "Doing something new…" },
    1500
  );

  assert.equal(state.step, before);
  assert.equal(state.label, "Doing something new…");
});

test("server upload counts take over from the byte estimate without going backwards", () => {
  let state = cleanerProgressInitial(FILES, 0);

  state = reduceCleanerUploadProgress(
    state,
    { loadedBytes: 30, totalBytes: 100, transferredFiles: 500, totalFiles: FILES, percent: 30 },
    1000
  );
  assert.equal(state.current, 500);

  // The server's spooled count is authoritative but lags the byte estimate.
  state = reduceCleanerProgress(state, progress("upload", 480, FILES), 1500);
  assert.equal(state.hasServerUploadCount, true);

  const pinned = state.current;

  state = reduceCleanerUploadProgress(
    state,
    { loadedBytes: 40, totalBytes: 100, transferredFiles: 700, totalFiles: FILES, percent: 40 },
    2000
  );

  assert.equal(state.current, pinned, "the byte estimate overrode the server count");
});

test("weights cover exactly 100% and steps are ordered", () => {
  assert.equal(
    overallFromFractions({ upload: 1, read: 1, clean: 1, package: 1 }),
    100
  );
  assert.deepEqual(
    CLEANER_STEPS.map((step) => step.key),
    ["upload", "read", "clean", "package"]
  );
});
