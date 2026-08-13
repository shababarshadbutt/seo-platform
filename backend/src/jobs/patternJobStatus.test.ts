import assert from "node:assert/strict";
import { test } from "node:test";

import {
  patternJobFailureMessage,
  shouldLogProgress
} from "./patternJobStatus.js";

// Progress is persisted to the DB every 10 files (the UI polls every 2s and
// wants that resolution) but LOGGED far more coarsely. These pin the throttle so
// a large run stays legible in the log instead of burying itself.

function simulate(filesTotal: number, msPerFlush: number) {
  let lastLoggedAt = 0;
  let lastLoggedFiles = 0;
  let now = 0;
  let lines = 0;

  for (let filesDone = 10; filesDone <= filesTotal; filesDone += 10) {
    now += msPerFlush;

    if (
      shouldLogProgress({ filesDone, filesTotal, lastLoggedAt, lastLoggedFiles, now })
    ) {
      lines += 1;
      lastLoggedAt = now;
      lastLoggedFiles = filesDone;
    }
  }

  return lines;
}

test("a 4,000-file run logs a couple of dozen lines, not 400", () => {
  // 400 flushes at 500ms apart = 200s of wall clock.
  const lines = simulate(4000, 500);

  assert.ok(lines <= 25, `expected <= 25 progress lines, got ${lines}`);
  assert.ok(lines >= 2, `expected at least a first and last line, got ${lines}`);
});

test("a fast run still logs its first and final line", () => {
  // 3 flushes, 1ms apart — neither gate is cleared in between.
  const lines = simulate(30, 1);

  assert.equal(lines, 2);
});

test("the final call is always logged even if both gates would block it", () => {
  assert.equal(
    shouldLogProgress({
      filesDone: 500,
      filesTotal: 500,
      lastLoggedAt: 1_000,
      lastLoggedFiles: 499,
      now: 1_001
    }),
    true
  );
});

test("time alone is not enough — the percentage gate must also clear", () => {
  assert.equal(
    shouldLogProgress({
      filesDone: 11,
      filesTotal: 4000,
      lastLoggedAt: 1_000,
      lastLoggedFiles: 10,
      now: 999_999
    }),
    false
  );
});

test("percentage alone is not enough — the time gate must also clear", () => {
  assert.equal(
    shouldLogProgress({
      filesDone: 400,
      filesTotal: 4000,
      lastLoggedAt: 1_000,
      lastLoggedFiles: 0,
      now: 1_010
    }),
    false
  );
});

test("a raced template collision becomes a sentence, not raw Postgres text", () => {
  // The UI shows maintenance_jobs.error verbatim. Before the routes became
  // jobs, this case was a 400 with a readable message; moving the UPDATE into a
  // job would otherwise have leaked the constraint violation to the user.
  const message = patternJobFailureMessage(
    new Error(
      'duplicate key value violates unique constraint "patterns_unique_template_per_session_role"'
    )
  );

  assert.equal(
    message,
    "Another pattern in this session already uses that template."
  );
});

test("any other failure keeps its own message", () => {
  assert.equal(
    patternJobFailureMessage(new Error("disk full")),
    "disk full"
  );
});
