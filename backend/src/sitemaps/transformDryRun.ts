import {
  captureStructureValues,
  transformUrl,
  type ParsedStructure
} from "./transformStructure.js";

// What a structure transform WOULD do to every URL in a pattern, measured by
// reading the files and writing nothing.
//
// WHY THIS EXISTS. The Update Pattern preview is computed from `pattern_urls`,
// a reservoir sample capped at ~1,000 rows per pattern. A pattern can hold
// millions. So the preview can be entirely correct about the URLs it saw and
// still be wrong about the population — a fixed split position that suits
// "part-720" produces "part-7-20000" for a value the sample never contained,
// and nothing in the old flow could have told the user that before the rewrite
// landed on every file.
//
// The counters below are the answer, and they are deliberately shaped around
// "what could be wrong" rather than "how much work is there":
//   * skipped     — in the pattern, but the CURRENT structure does not match, so
//                   the transform silently passes it through. A large number
//                   here means the structure is narrower than the user thinks.
//   * unchanged   — the structure matched and the transform was a no-op.
//   * shapes      — a bounded histogram of RESULT shapes. This is the one that
//                   catches the wrong-for-other-lengths class, which is why
//                   digit runs keep their length while letter runs collapse.
//   * anomalies   — specific known-bad outcomes, each cheap to detect.

// Digit runs keep their length; letter runs collapse to one "a". That asymmetry
// is the whole point: "part-7-20" and "part-7-20000" must land in DIFFERENT
// buckets (a fixed split position is right for one and wrong for the other),
// while "part" and "parts" need not.
//
// Hand-rolled rather than /[0-9]+|[A-Za-z]+/g with a replace callback. This runs
// once per rewritten URL — 6.58M times on the session that motivated the whole
// feature — and a regex allocating a match object and invoking a closure per run
// was a measurable slice of the scan. transformDryRun.test.ts is the contract
// here, not this implementation.
export function valueShape(value: string): string {
  let out = "";
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);

    if (code >= 48 && code <= 57) {
      const start = index;

      do {
        index += 1;
      } while (
        index < value.length &&
        value.charCodeAt(index) >= 48 &&
        value.charCodeAt(index) <= 57
      );

      out += "9".repeat(Math.min(index - start, 12));
      continue;
    }

    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      do {
        index += 1;
      } while (
        index < value.length &&
        ((value.charCodeAt(index) >= 65 && value.charCodeAt(index) <= 90) ||
          (value.charCodeAt(index) >= 97 && value.charCodeAt(index) <= 122))
      );

      out += "a";
      continue;
    }

    out += value[index];
    index += 1;
  }

  return out;
}

// Distinct result shapes to keep. Past this the histogram stops growing and says
// so — a transform producing more than this many shapes is already telling the
// user everything they need to know (its output is not uniform), and an
// unbounded map here is an out-of-memory crash at 6.58M URLs.
export const SHAPE_LIMIT = 25;

// Outputs remembered while looking for collisions. Bounded for the same reason:
// exact collision detection over the whole population means holding every
// result string, which is gigabytes. Past the cap the scan stops recording and
// reports that it did, rather than implying a clean bill of health it did not
// earn.
export const COLLISION_SCAN_LIMIT = 200_000;

export type DryRunShape = {
  shape: string;
  count: number;
  before: string;
  after: string;
};

export type DryRunTotals = {
  total_locs: number;
  matched: number;
  rewritten: number;
  unchanged: number;
  skipped: number;
  shapes: DryRunShape[];
  shapes_truncated: boolean;
  clamped_split: number;
  clamped_split_example: string | null;
  double_slash: number;
  collisions: number;
  collision_example: string | null;
  collision_scan_truncated: boolean;
};

// What ONE accumulator saw, in a form that survives the worker thread boundary.
//
// The scan runs either inline or across a piscina pool depending on how much
// there is to read, and BOTH paths end in mergeDryRunPartials. That is the point
// of this type: there is no separate "serial totals" code to drift from the
// parallel one, so the two cannot disagree about what they measured.
export type DryRunPartial = {
  totalLocs: number;
  matched: number;
  rewritten: number;
  unchanged: number;
  skipped: number;
  clampedSplit: number;
  clampedSplitExample: string | null;
  doubleSlash: number;
  shapes: DryRunShape[];
  shapesTruncated: boolean;
  // Hashes of the results this accumulator produced, for cross-file collision
  // detection. HASHES, not the URLs: at 6.58M results the strings themselves are
  // hundreds of megabytes to hold and to copy between threads, and nothing
  // downstream needs to read them back — only to know whether two are equal.
  outputHashes: Float64Array;
  // A few hash -> result URL pairs, so a collision discovered at MERGE time can
  // still be named.
  //
  // Without this, a parallel scan reports "7 URLs would collide" and cannot show
  // one, because the two halves of every cross-file pair sit in different
  // partials and only their hashes meet. Bounded hard: this is illustrative, and
  // carrying 6.58M URL strings across the thread boundary to guarantee an example
  // would cost far more than the example is worth.
  hashExamples: Array<[number, string]>;
  localCollisions: number;
  collisionExample: string | null;
  collisionScanTruncated: boolean;
};

// Result URLs remembered per partial for naming a merge-time collision. 64 is
// enough that a real collision is almost always nameable while the array stays
// negligible next to the hash set it accompanies.
export const COLLISION_EXAMPLE_LIMIT = 64;

// FNV-1a run twice with different constants, combined into ONE 52-bit integer.
//
// 52 bits, not 32, and the difference matters: a 32-bit hash over a 200,000-
// entry set produces about five collisions BY CHANCE, so a transform that
// collapses nothing would report "5 URLs would collide" and send someone
// hunting for a bug that isn't there. At 52 bits the same set expects 4e-6 —
// and it still fits exactly in a float64, so the set travels between threads as
// a TypedArray rather than as boxed values.
export function hashOutput(value: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + index;
    h2 = Math.imul(h2, 0x85ebca6b);
  }

  return (h1 >>> 0) * 0x100000 + ((h2 >>> 12) & 0xfffff);
}

// One insertAt rule, pre-resolved to where its output lands in the RESULT path.
//
// The clamp is then detected from the result alone, with no second walk over the
// input: applyTransform always produces `value.length + separator.length`
// characters, so
//
//     clamped  <=>  position >= value.length  <=>  segment.length <= position + separator.length
//
// which is exact, not a heuristic. (endsWith(separator) alone is NOT: "ab-" split
// at 1 with "-" gives "a-b-", which ends with the separator and is not clamped.)
type SplitProbe = {
  // Index into path.split("/") — 1-based because the leading "/" yields an empty
  // first element. Deliberately not filter(Boolean): an empty param value would
  // shift every later index and silently probe the wrong segment.
  pathIndex: number;
  position: number;
  separatorLength: number;
};

function splitProbes(next: ParsedStructure): SplitProbe[] {
  const probes: SplitProbe[] = [];

  next.segments.forEach((rule, index) => {
    if (rule.type !== "param" || rule.transform.kind !== "insertAt") {
      return;
    }

    probes.push({
      pathIndex: index + 1,
      position: rule.transform.position,
      separatorLength: rule.transform.separator.length
    });
  });

  return probes;
}

export class TransformDryRun {
  private readonly current: ParsedStructure;
  private readonly next: ParsedStructure;
  private readonly matchesPattern: (url: string, pathname: string) => boolean;
  private readonly probes: SplitProbe[];
  private readonly shapes = new Map<string, DryRunShape>();
  private readonly seen = new Set<number>();
  private readonly hashExamples = new Map<number, string>();

  private totalLocs = 0;
  private matched = 0;
  private rewritten = 0;
  private unchanged = 0;
  private skipped = 0;
  private shapesTruncated = false;
  private clampedSplit = 0;
  private clampedSplitExample: string | null = null;
  private doubleSlash = 0;
  private collisions = 0;
  private collisionExample: string | null = null;
  private collisionScanTruncated = false;

  constructor(options: {
    current: ParsedStructure;
    next: ParsedStructure;
    // "Is this URL part of the pattern at all?" — the same template + scope test
    // the file breakdown uses, passed in so the dry run and the apply agree on
    // the denominator.
    //
    // Takes the already-parsed pathname alongside the URL. At 6.58M URLs the
    // dominant cost of this whole scan is `new URL()`, and having the predicate
    // parse its own copy of a string the caller has already parsed was a third
    // of the runtime.
    matchesPattern: (url: string, pathname: string) => boolean;
  }) {
    this.current = options.current;
    this.next = options.next;
    this.matchesPattern = options.matchesPattern;
    this.probes = splitProbes(options.next);
  }

  observe(url: string): void {
    this.totalLocs += 1;

    let pathname: string;

    try {
      pathname = new URL(url).pathname;
    } catch {
      return;
    }

    if (!this.matchesPattern(url, pathname)) {
      return;
    }

    // TRANSFORM FIRST, classify second. transformUrl returns null both for "the
    // structure does not match" and for "it matched and changed nothing", so
    // telling those apart needs a second walk (captureStructureValues) — but
    // only on the null branch. Doing it up front for every URL, as this did
    // first, paid for that walk on the overwhelmingly common path where the
    // transform succeeds and the answer was never in doubt.
    const after = transformUrl(url, this.current, this.next);

    if (after !== null) {
      this.matched += 1;
      this.rewritten += 1;
      this.record(url, after);

      return;
    }

    // Conflating these two is exactly how a too-narrow structure reads as a
    // harmless no-op instead of "your structure misses 4.1M URLs".
    if (captureStructureValues(url, this.current)) {
      this.matched += 1;
      this.unchanged += 1;
    } else {
      this.skipped += 1;
    }
  }

  private record(before: string, after: string): void {
    let path: string;

    try {
      path = new URL(after).pathname;
    } catch {
      return;
    }

    const shape = valueShape(path);
    const existing = this.shapes.get(shape);

    if (existing) {
      existing.count += 1;
    } else if (this.shapes.size < SHAPE_LIMIT) {
      this.shapes.set(shape, { shape, count: 1, before, after });
    } else {
      this.shapesTruncated = true;
    }

    // A split position past the end of a value APPENDS the separator instead of
    // inserting it (transformStructure clamps rather than throwing, so one short
    // outlier cannot fail a transform that is right for everything else). That
    // is the correct behaviour and still usually a mistake, so it is counted.
    if (this.probes.length > 0) {
      const segments = path.split("/");

      for (const probe of this.probes) {
        const segment = segments[probe.pathIndex];

        if (
          segment !== undefined &&
          segment.length <= probe.position + probe.separatorLength
        ) {
          this.clampedSplit += 1;

          if (this.clampedSplitExample === null) {
            this.clampedSplitExample = after;
          }

          break;
        }
      }
    }

    if (path.includes("//")) {
      this.doubleSlash += 1;
    }

    // Two different URLs landing on one is a lost page, not a cosmetic issue.
    const digest = hashOutput(after);

    if (this.seen.size >= COLLISION_SCAN_LIMIT) {
      this.collisionScanTruncated = true;
    } else if (this.seen.has(digest)) {
      this.collisions += 1;

      if (this.collisionExample === null) {
        this.collisionExample = after;
      }
    } else {
      this.seen.add(digest);

      if (this.hashExamples.size < COLLISION_EXAMPLE_LIMIT) {
        this.hashExamples.set(digest, after);
      }
    }
  }

  // What this accumulator saw, ready to travel or to be merged. Never a finished
  // answer on its own: even a single-threaded scan goes through
  // mergeDryRunPartials, so there is exactly one place that turns observations
  // into the numbers a user reads.
  partial(): DryRunPartial {
    return {
      totalLocs: this.totalLocs,
      matched: this.matched,
      rewritten: this.rewritten,
      unchanged: this.unchanged,
      skipped: this.skipped,
      clampedSplit: this.clampedSplit,
      clampedSplitExample: this.clampedSplitExample,
      doubleSlash: this.doubleSlash,
      shapes: Array.from(this.shapes.values()),
      shapesTruncated: this.shapesTruncated,
      outputHashes: Float64Array.from(this.seen),
      hashExamples: Array.from(this.hashExamples),
      localCollisions: this.collisions,
      collisionExample: this.collisionExample,
      collisionScanTruncated: this.collisionScanTruncated
    };
  }

  totals(): DryRunTotals {
    return mergeDryRunPartials([this.partial()]);
  }
}

// Combine what several accumulators saw into the one set of numbers the user is
// shown.
//
// COLLISIONS ARE WHY THIS IS NOT JUST ADDITION. "Two URLs collapse onto one" is a
// property of the whole population, and splitting files across threads hides
// every collision whose two halves landed in different threads — which is the
// common case, since a sitemap set is split by size and not by content. So each
// partial carries the hashes of the results it produced, and the pairs that span
// two partials are found HERE.
//
// The arithmetic is exact against a single-threaded scan of the same input (up to
// the caps): a value seen 3 times, split 2/1 across two partials, yields 1 local
// collision in the first, 0 in the second, and 1 more at merge — the same 2 a
// serial scan reports. The equivalence test pins that.
export function mergeDryRunPartials(partials: DryRunPartial[]): DryRunTotals {
  const shapes = new Map<string, DryRunShape>();
  const seen = new Set<number>();
  // hash -> one result URL, pooled from every partial so a collision found here
  // can be named rather than only counted.
  const examples = new Map<number, string>();

  let totalLocs = 0;
  let matched = 0;
  let rewritten = 0;
  let unchanged = 0;
  let skipped = 0;
  let clampedSplit = 0;
  let clampedSplitExample: string | null = null;
  let doubleSlash = 0;
  let shapesTruncated = false;
  let collisions = 0;
  let collisionExample: string | null = null;
  let collisionScanTruncated = false;

  for (const partial of partials) {
    totalLocs += partial.totalLocs;
    matched += partial.matched;
    rewritten += partial.rewritten;
    unchanged += partial.unchanged;
    skipped += partial.skipped;
    clampedSplit += partial.clampedSplit;
    doubleSlash += partial.doubleSlash;
    collisions += partial.localCollisions;
    shapesTruncated = shapesTruncated || partial.shapesTruncated;
    collisionScanTruncated =
      collisionScanTruncated || partial.collisionScanTruncated;

    if (clampedSplitExample === null) {
      clampedSplitExample = partial.clampedSplitExample;
    }

    if (collisionExample === null) {
      collisionExample = partial.collisionExample;
    }

    for (const shape of partial.shapes) {
      const existing = shapes.get(shape.shape);

      if (existing) {
        existing.count += shape.count;
      } else if (shapes.size < SHAPE_LIMIT) {
        shapes.set(shape.shape, { ...shape });
      } else {
        // Two partials can each be under the cap while their union is over it,
        // so the merge has to be able to truncate too — and to say that it did.
        shapesTruncated = true;
      }
    }

    for (const [digest, url] of partial.hashExamples) {
      if (!examples.has(digest)) {
        examples.set(digest, url);
      }
    }

    for (const digest of partial.outputHashes) {
      if (seen.size >= COLLISION_SCAN_LIMIT) {
        collisionScanTruncated = true;
        break;
      }

      if (seen.has(digest)) {
        collisions += 1;

        // A cross-partial collision: neither side saw it alone, so the URL can
        // only come from the examples they carried.
        if (collisionExample === null) {
          collisionExample = examples.get(digest) ?? null;
        }
      } else {
        seen.add(digest);
      }
    }
  }

  return {
    total_locs: totalLocs,
    matched,
    rewritten,
    unchanged,
    skipped,
    shapes: Array.from(shapes.values()).sort(
      (a, b) => b.count - a.count || a.shape.localeCompare(b.shape)
    ),
    shapes_truncated: shapesTruncated,
    clamped_split: clampedSplit,
    clamped_split_example: clampedSplitExample,
    double_slash: doubleSlash,
    collisions,
    collision_example: collisionExample,
    collision_scan_truncated: collisionScanTruncated
  };
}
