// Explicit timing spans and counters for one Sitemap Cleaner run.
//
// Why this exists alongside stageTimer.ts rather than inside it: StageTimer
// attributes wall clock to whichever STAGE was last announced to the browser.
// That is the right coarse model, but it cannot answer the two questions this
// release exists to answer:
//
//   1. Which phase is slow when a phase announces nothing? Silent work (the
//      keep/drop fold, `rm -rf in/`, the duplicates CSV) is charged to whatever
//      stage happened to be announced before it.
//   2. Within Pass 2, is the cost CPU (sax parsing) or disk (the provisional
//      write/read/unlink hop)? Both happen under a single "output" label, so a
//      stage-level number cannot separate them — and separating them is exactly
//      what decides whether the next pass raises the worker count or removes
//      the provisional hop.
//
// So: spans here are authoritative, StageTimer is the coarse fallback, and both
// are emitted. If they disagree materially that is itself a finding.
//
// Everything is milliseconds unless the key says otherwise. Timing granularity
// is deliberately per-file and per-chunk, never per-URL: an hrtime call around
// every one of several million `<loc>` elements would measurably distort the
// very thing being measured.

export type Observation = {
  count: number;
  sum: number;
  max: number;
  /** Retained samples for the p95 estimate; capped so a huge run stays bounded. */
  samples: number[];
};

const MAX_SAMPLES = 2000;

export type CleanerMetricsSnapshot = {
  totals: Record<string, number>;
  counters: Record<string, number>;
  observations: Record<
    string,
    { count: number; sum: number; max: number; p95: number }
  >;
};

export class CleanerMetrics {
  private readonly totals = new Map<string, number>();
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, Observation>();
  private readonly now: () => number;

  // Injectable clock so tests are deterministic rather than sleep-based.
  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  /** Accumulate milliseconds under a key. */
  add(key: string, ms: number) {
    this.totals.set(key, (this.totals.get(key) ?? 0) + ms);
  }

  /** Accumulate a plain count (files, bytes, URLs, entries). */
  inc(key: string, amount = 1) {
    this.counters.set(key, (this.counters.get(key) ?? 0) + amount);
  }

  /**
   * Record one sample of a repeated measurement, keeping count/sum/max plus a
   * bounded reservoir for p95. Use for per-file durations, where the tail
   * matters more than the mean — one pathological file is invisible in an
   * average but obvious in a p95/max pair.
   */
  observe(key: string, value: number) {
    let entry = this.observations.get(key);

    if (!entry) {
      entry = { count: 0, sum: 0, max: 0, samples: [] };
      this.observations.set(key, entry);
    }

    entry.count += 1;
    entry.sum += value;
    entry.max = Math.max(entry.max, value);

    if (entry.samples.length < MAX_SAMPLES) {
      entry.samples.push(value);
    }
  }

  /** Time an async span, recording it under `key` and returning its value. */
  async timeAsync<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.now();

    try {
      return await fn();
    } finally {
      this.add(key, this.now() - startedAt);
    }
  }

  /** Time a synchronous span. */
  timeSync<T>(key: string, fn: () => T): T {
    const startedAt = this.now();

    try {
      return fn();
    } finally {
      this.add(key, this.now() - startedAt);
    }
  }

  /** Start a manual span; call the returned function to close it. */
  start(key: string): () => number {
    const startedAt = this.now();

    return () => {
      const elapsed = this.now() - startedAt;

      this.add(key, elapsed);

      return elapsed;
    };
  }

  get(key: string): number {
    return this.totals.get(key) ?? 0;
  }

  count(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  snapshot(): CleanerMetricsSnapshot {
    const observations: CleanerMetricsSnapshot["observations"] = {};

    for (const [key, entry] of this.observations) {
      observations[key] = {
        count: entry.count,
        sum: Math.round(entry.sum),
        max: Math.round(entry.max),
        p95: Math.round(percentile(entry.samples, 0.95))
      };
    }

    return {
      totals: Object.fromEntries(
        [...this.totals].map(([key, value]) => [key, Math.round(value)])
      ),
      counters: Object.fromEntries(this.counters),
      observations
    };
  }
}

// Nearest-rank percentile. Sorts a copy so repeated snapshots stay stable.
export function percentile(samples: number[], fraction: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);

  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function createCleanerMetrics(options: { now?: () => number } = {}) {
  return new CleanerMetrics(options);
}
