import assert from "node:assert/strict";
import { test } from "node:test";

import { StageTimer } from "./stageTimer.js";

// A controllable clock, so these assert on arithmetic rather than on sleeps.
function fakeClock(start = 1_000) {
  let now = start;

  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

test("time is attributed to the stage that was open, not the one being entered", () => {
  const clock = fakeClock();
  const timer = new StageTimer({ now: clock.now });

  timer.mark("pull");
  clock.advance(20_000);
  timer.mark("parse");
  clock.advance(3_000);
  timer.mark("zip");
  clock.advance(1_000);

  const { total_ms, stage_ms } = timer.finish();

  assert.equal(stage_ms.pull, 20_000);
  assert.equal(stage_ms.parse, 3_000);
  assert.equal(stage_ms.zip, 1_000);
  assert.equal(total_ms, 24_000);
});

// parse emits one frame per file, so the same stage is marked hundreds of times.
// "How long was spent parsing" requires those to ACCUMULATE, and interleaving
// must not lose time to whichever stage happened to be last.
test("a revisited stage accumulates instead of resetting", () => {
  const clock = fakeClock();
  const timer = new StageTimer({ now: clock.now });

  timer.mark("parse");
  clock.advance(100);
  timer.mark("parse");
  clock.advance(150);
  timer.mark("dedup");
  clock.advance(40);
  timer.mark("parse");
  clock.advance(10);

  const { stage_ms, total_ms } = timer.finish();

  assert.equal(stage_ms.parse, 260, "100 + 150 + 10");
  assert.equal(stage_ms.dedup, 40);
  // Nothing may be lost or double-counted: the parts must equal the whole.
  assert.equal(
    Object.values(stage_ms).reduce((a, b) => a + b, 0),
    total_ms
  );
});

test("dominant() names the slowest stage", () => {
  assert.deepEqual(
    StageTimer.dominant({ pull: 1_140_000, parse: 24_000, zip: 6_000 }),
    { stage: "pull", ms: 1_140_000 }
  );
  assert.equal(StageTimer.dominant({}), null);
});

// Time before the first mark() belongs to the run, not to a stage — a run that
// spends 10s listing a directory before announcing anything must not silently
// drop that from total_ms.
test("total_ms covers the whole run even before the first stage is marked", () => {
  const clock = fakeClock();
  const timer = new StageTimer({ now: clock.now });

  clock.advance(10_000);
  timer.mark("pull");
  clock.advance(5_000);

  const { total_ms, stage_ms } = timer.finish();

  assert.equal(total_ms, 15_000);
  assert.equal(stage_ms.pull, 5_000);
});

test("an undefined stage is ignored rather than becoming a bucket", () => {
  const clock = fakeClock();
  const timer = new StageTimer({ now: clock.now });

  timer.mark("pull");
  clock.advance(1_000);
  timer.mark(undefined);
  clock.advance(1_000);

  const { stage_ms } = timer.finish();

  assert.deepEqual(Object.keys(stage_ms), ["pull"]);
  assert.equal(stage_ms.pull, 2_000);
});
