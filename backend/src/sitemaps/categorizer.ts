// Path-structure categorization for the Sitemap Categorizer tool (see
// "Sitemap_Tool_Requirements 2.0.docx" sections 3 and 4).
//
// Two independent, stateless-per-call pieces, run in order for every URL:
//   1. categorizeRfq — the 8 RFQ URL shapes, matched structurally.
//   2. categorizeRegular — depth-based categorization for everything else,
//      using a boundary lookup built ONCE per run by DepthBoundaryDetector.
//
// NOT BUILT ON transformStructure.ts'S GRAMMAR. That grammar (parseStructure /
// captureStructureValues) matches one fixed shape at a time by segment count,
// which is the right tool for a single rename/transform rule but not for this
// decision tree: the doc's own step 1 requires routing a "/rfq/product/..."
// path away from case 1 by the LITERAL VALUE of its second segment, regardless
// of how many segments follow — e.g. "/rfq/product/x/" (3 segments) must NOT
// fall through to case 1's /rfq/{manufacturer}/{part-no}/ shape just because
// the segment counts happen to line up. A value-guarded, count-agnostic check
// like that cross-cuts segment-count-based matching, so the decision tree is
// encoded directly against the segment array instead.
//
// THE DOC'S SECTION 4 HEADING ("How the Tool Identifies RFQ Cases") IS
// NARROWER THAN ITS OWN DECISION TREE READS. Steps 1-4 identify RFQ shapes;
// step 5 ("path starts with nsn, no rfq -> static page") and step 6 ("no rule
// matches -> uncategorized.xml") read as if they close out one single
// decision procedure for every URL, but a plain non-RFQ, non-nsn path (e.g.
// "/aviation/components/g-10-sheet/", per section 3.1) matches none of steps
// 1-5 and would land on step 6 by that literal reading — contradicting
// section 3.1, which is unambiguous that such URLs belong in a category file.
// The reading that keeps the whole document self-consistent: steps 1-4 are
// categorizeRfq below; step 5 is a reminder that "nsn" without "rfq" is NOT an
// RFQ case and defers to depth-based categorization (3.2) — exactly what
// categorizeRfq already does by returning null for it; and step 6 is the
// FINAL fallback of the combined pipeline (categorizeUrl), reached only when
// neither categorizeRfq nor categorizeRegular (which almost always resolves
// to at least main.xml) produces a category.

export type CategorizationResult = {
  ruleId: string;
  filename: string;
};

export const MAIN_FILENAME = "main.xml";
export const UNCATEGORIZED_FILENAME = "uncategorized.xml";

// Split a URL's pathname into non-empty segments ("/a//b/" -> ["a", "b"]).
// Returns null for a URL that doesn't parse, so callers route it to
// "uncategorized" rather than throwing.
export function pathSegmentsFromUrl(rawUrl: string): string[] | null {
  try {
    return new URL(rawUrl).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}

const NSN_PATTERN = /^\d{13}$/;

// The doc's section 4 decision tree, steps 1-4 (RFQ identification). Returns
// null when no RFQ shape matches — including the doc's own documented gap,
// case 8 (Business Jet / "civil-aviation"), which has only one ungeneralized
// example and no stated filename rule; a null here falls through to
// categorizeRegular rather than guessing at a rule the doc never stated.
export function categorizeRfq(segments: string[]): CategorizationResult | null {
  if (segments.length === 0) {
    return null;
  }

  const [first, second] = segments;

  // Step 1: first segment is "rfq".
  if (first === "rfq") {
    if (second === "product") {
      // Case 2: /rfq/product/{category}/{manufacturer}/{part-no}/
      if (segments.length === 5) {
        return { ruleId: "rfq-2", filename: `${segments[2]}-rfq.xml` };
      }

      // Second segment is literally "product" but the shape doesn't match
      // case 2's segment count — per step 1, this must NOT fall through to
      // case 1 either (that would mis-file it under the wrong category).
      return null;
    }

    // Case 1: /rfq/{manufacturer}/{part-no}/
    if (segments.length === 3) {
      return { ruleId: "rfq-1", filename: "rfq.xml" };
    }

    return null;
  }

  // Step 2: first segment is "nsn" and the path contains "rfq" as the second
  // segment ("/nsn/rfq/..."). nsn-without-rfq defers to categorizeRegular.
  if (first === "nsn" && second === "rfq") {
    const after = segments.slice(2);

    // Case 6: /nsn/rfq/{vertical}/{nsn}/{part-no}/ — the middle of the three
    // segments following rfq is a 13-digit NSN. Checked first per the doc's
    // own ordering (case 6 before case 5).
    if (after.length === 3 && NSN_PATTERN.test(after[1])) {
      return { ruleId: "rfq-6", filename: `nsn-${after[0]}-rfq.xml` };
    }

    // Case 5: /nsn/rfq/{manufacturer}/{part-no}/
    if (after.length === 2) {
      return { ruleId: "rfq-5", filename: "nsn-rfq.xml" };
    }

    return null;
  }

  // Step 3: first segment is "parts-by-ipc".
  if (first === "parts-by-ipc") {
    // Case 7: /parts-by-ipc/{ipc-category}/rfq/{aircraft-model}/{manufacturer}/{part-no}/
    if (segments.length === 6 && segments[2] === "rfq") {
      return { ruleId: "rfq-7", filename: `parts-by-ipc-${segments[1]}-rfq.xml` };
    }

    return null;
  }

  // Step 4: any other first segment, followed by "rfq".
  if (second === "rfq") {
    const after = segments.slice(2);
    const category = first;

    // Case 3: /{category}/rfq/{part-no}/
    if (after.length === 1) {
      return { ruleId: "rfq-3", filename: `${category}-rfq.xml` };
    }

    // Case 4: /{category}/rfq/{manufacturer}/{part-no}/
    if (after.length === 2) {
      return { ruleId: "rfq-4", filename: `${category}-rfq.xml` };
    }

    // 3+ segments after rfq (e.g. the Business Jet / "civil-aviation" case):
    // the doc gives one example with no generalized rule. Fall through to
    // categorizeRegular rather than guess.
    return null;
  }

  return null;
}

// --- Depth-based categorization (doc sections 3.1 / 3.2) -------------------
//
// One unified rule for both "regular" and "static listing" pages: detect,
// from the observed data, the first path position whose values are too
// varied to be a fixed vocabulary, and treat everything from there on as the
// dynamic leaf. The dash-joined segments BEFORE that position become the
// category filename; a URL that never reaches a detected boundary (homepage,
// L1, L1/L2, or a static listing page's own index) goes to main.xml.
//
// Same cardinality rule as extractPatternsJob.ts's shouldParameterizeTracker,
// generalized from one flat per-absolute-position tracker (correct only for
// URLs already grouped under one template) to a TREE of trackers keyed by the
// literal prefix walked so far — required because depth varies by section
// (the doc's own words): position 1 is dynamic under /manufacturer/ but
// position 2 is dynamic under /nsn/fscs/, and a flat per-position tracker
// cannot represent both at once.
export const DEPTH_PARAM_UNIQUE_THRESHOLD = 100;
export const DEPTH_PARAM_UNIQUE_RATIO_THRESHOLD = 0.6;
export const DEPTH_PARAM_MIN_OBSERVED_URLS = 3;

type DepthPositionTracker = {
  counts: Map<string, number>;
  observedUrlCount: number;
  dynamic: boolean;
};

function shouldResolveDynamic(tracker: DepthPositionTracker): boolean {
  const uniqueRatio =
    tracker.observedUrlCount === 0
      ? 0
      : tracker.counts.size / tracker.observedUrlCount;

  return (
    tracker.counts.size > DEPTH_PARAM_UNIQUE_THRESHOLD ||
    (tracker.observedUrlCount >= DEPTH_PARAM_MIN_OBSERVED_URLS &&
      uniqueRatio >= DEPTH_PARAM_UNIQUE_RATIO_THRESHOLD)
  );
}

// A prefix (array of segments walked from the root) as a lookup key. Plain
// JSON encoding: unambiguous, and directly how boundaries are persisted
// (array-of-arrays survives a jsonb round trip with no extra decoding step).
function prefixKey(prefix: string[]): string {
  return JSON.stringify(prefix);
}

// JSON-safe snapshot of a detector's trackers, for checkpointing an in-progress
// detect pass (see categorizerCategorizeJob.ts's resumable detect loop). Same
// "cheap because bounded by distinct static prefixes" reasoning as `counts`
// itself — this is never sized by URL count.
export type SerializedDepthBoundaryDetector = Array<
  [string, { counts: Array<[string, number]>; observedUrlCount: number; dynamic: boolean }]
>;

// Accumulates per-prefix position statistics across a streamed population.
// Memory is bounded by the number of DISTINCT STATIC PREFIXES in the site
// (tens to low thousands), never by URL count: a tracker's `counts` map stops
// growing the moment it resolves dynamic (cleared, same as
// shouldParameterizeTracker), and observe() never descends a URL past the
// first dynamic position it hits, so no tracker is ever created inside a
// resolved-dynamic subtree.
export class DepthBoundaryDetector {
  private trackers = new Map<string, DepthPositionTracker>();

  // Rehydrates a detector from a prior serialize() snapshot, so a chunked
  // detect pass can resume mid-scan instead of restarting at the root.
  static fromSerialized(data: SerializedDepthBoundaryDetector): DepthBoundaryDetector {
    const detector = new DepthBoundaryDetector();

    for (const [key, tracker] of data) {
      detector.trackers.set(key, {
        counts: new Map(tracker.counts),
        observedUrlCount: tracker.observedUrlCount,
        dynamic: tracker.dynamic
      });
    }

    return detector;
  }

  serialize(): SerializedDepthBoundaryDetector {
    return Array.from(this.trackers, ([key, tracker]) => [
      key,
      {
        counts: Array.from(tracker.counts),
        observedUrlCount: tracker.observedUrlCount,
        dynamic: tracker.dynamic
      }
    ]);
  }

  observe(segments: string[]): void {
    let prefix: string[] = [];

    for (const segment of segments) {
      const key = prefixKey(prefix);
      let tracker = this.trackers.get(key);

      if (!tracker) {
        tracker = { counts: new Map(), observedUrlCount: 0, dynamic: false };
        this.trackers.set(key, tracker);
      }

      if (tracker.dynamic) {
        // Boundary already known for this lineage — this URL's leaf starts
        // here, nothing deeper is relevant to depth detection.
        return;
      }

      tracker.observedUrlCount += 1;
      tracker.counts.set(segment, (tracker.counts.get(segment) ?? 0) + 1);

      if (shouldResolveDynamic(tracker)) {
        tracker.dynamic = true;
        tracker.counts.clear();
        return;
      }

      // Still undecided: keep walking, using this URL's actual segment value
      // as the next prefix component (not yet known whether this position is
      // a fixed vocabulary or just under-observed).
      prefix = [...prefix, segment];
    }
  }

  // The resolved boundaries, as plain arrays ready for jsonb storage.
  boundaries(): string[][] {
    const result: string[][] = [];

    for (const [key, tracker] of this.trackers) {
      if (tracker.dynamic) {
        result.push(JSON.parse(key) as string[]);
      }
    }

    return result;
  }
}

// A boundary set prepared once per categorize run and reused across every
// per-URL categorizeRegular call, so the hot path is a Set lookup, not a
// re-serialization of every stored boundary per URL.
export type DepthBoundaryLookup = Set<string>;

export function buildDepthBoundaryLookup(
  boundaries: string[][]
): DepthBoundaryLookup {
  return new Set(boundaries.map((prefix) => prefixKey(prefix)));
}

export function categorizeRegular(
  segments: string[],
  boundaries: DepthBoundaryLookup
): CategorizationResult {
  for (let depth = 0; depth < segments.length; depth += 1) {
    const prefix = segments.slice(0, depth);

    if (boundaries.has(prefixKey(prefix))) {
      // A boundary detected at depth 0 means the very first segment is
      // already too varied to be a category name — a degenerate case the doc
      // doesn't cover (every example site has at least one static level).
      // Falling to uncategorized is the honest answer rather than emitting an
      // empty filename.
      if (prefix.length === 0) {
        return { ruleId: "uncategorized", filename: UNCATEGORIZED_FILENAME };
      }

      return { ruleId: "regular", filename: `${prefix.join("-")}.xml` };
    }
  }

  // No dynamic boundary found along this path: homepage, L1, L1/L2, or a
  // static listing page's own index (doc 3.1 / 3.2).
  return { ruleId: "regular-main", filename: MAIN_FILENAME };
}

// The full per-URL pipeline: RFQ first, then depth-based, then the doc's
// step-6 fallback for whatever neither one resolves (an unparseable URL, or
// the depth-0-boundary degenerate case above).
export function categorizeUrl(
  rawUrl: string,
  boundaries: DepthBoundaryLookup
): CategorizationResult {
  const segments = pathSegmentsFromUrl(rawUrl);

  if (!segments) {
    return { ruleId: "uncategorized", filename: UNCATEGORIZED_FILENAME };
  }

  return categorizeRfq(segments) ?? categorizeRegular(segments, boundaries);
}
