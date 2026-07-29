// Per-stage wall-clock timing for a Cleaner run.
//
// Why this exists: a real run took ~25 minutes for 2,264 files against a
// benchmark of 250 files in ~19s, and NOBODY COULD SAY WHICH STAGE ATE THE TIME.
// The stage names were already there — every SSE frame carries one — but they
// were only ever written to the browser, so the moment the tab closed the
// evidence was gone. Answering "which stage was slow?" required reproducing the
// run instead of reading a log line.
//
// This records the elapsed time between stage transitions and emits ONE summary
// line at the end. It does not change the SSE contract: the frames the client
// sees are untouched, this only observes them.
//
// Ordering assumption: a run moves through stages roughly in sequence and can
// revisit one (parse emits per file). Time is attributed to whichever stage was
// last announced, so a revisited stage accumulates — which is what you want for
// "how long was spent parsing" as opposed to "when did parsing start".

export type StageTotals = Record<string, number>;

export class StageTimer {
  private readonly startedAt: number;
  private current: string | null = null;
  private currentSince: number;
  private readonly totals: StageTotals = {};
  // Injectable so tests are deterministic rather than sleep-based.
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.currentSince = this.startedAt;
  }

  // Call on every progress frame. Repeated calls for the same stage are cheap
  // and are what make a per-file stage accumulate correctly.
  mark(stage: string | undefined) {
    if (!stage) {
      return;
    }

    const at = this.now();

    if (this.current !== null) {
      this.totals[this.current] = (this.totals[this.current] ?? 0) + (at - this.currentSince);
    }

    this.current = stage;
    this.currentSince = at;
  }

  // Close the final open stage and return whole-run totals.
  finish(): { total_ms: number; stage_ms: StageTotals } {
    const at = this.now();

    if (this.current !== null) {
      this.totals[this.current] = (this.totals[this.current] ?? 0) + (at - this.currentSince);
      this.current = null;
      this.currentSince = at;
    }

    return { total_ms: at - this.startedAt, stage_ms: { ...this.totals } };
  }

  // The slowest stage, for a log line that leads with the answer instead of
  // making the reader scan a map.
  static dominant(totals: StageTotals): { stage: string; ms: number } | null {
    const entries = Object.entries(totals);

    if (entries.length === 0) {
      return null;
    }

    return entries
      .map(([stage, ms]) => ({ stage, ms }))
      .sort((a, b) => b.ms - a.ms)[0];
  }
}
