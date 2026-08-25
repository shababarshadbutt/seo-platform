import { pathMatchesTemplate, type LocUrlRewriter } from "./rewriteLocs.js";
import { valueShape } from "./transformDryRun.js";

// WHICH URLs DID AN APPLY LEAVE BEHIND? (v1.81)
//
// WHY THIS EXISTS. buildRedirectApplyRewriter rewrites a <loc> only when a
// confirmed destination, an approved/derived rule, or an AGREED per-shape rule
// covers it; everything else returns null and passes through byte-for-byte. That
// is correct — rewriting a URL nobody measured is the overreach v1.68 was written
// to stop — but the count it produces was the only thing reported, so an apply
// that reached 12 of 579,034 URLs and one that reached all of them printed the
// same success sentence and drew the same Fixed chip.
//
// Two reported sessions were this, seen from different angles:
//
//   * a six-segment pattern whose URLs span several unrelated families. Their
//     confirmed pairs disagree, so deriveRedirectRule returns null for the whole
//     pattern and per-shape strata come back unagreed. A handful of exact pairs
//     rewrote, the pattern was stamped Fixed, and the downloaded sitemap still
//     showed the old URLs — because it was never touched;
//   * /nsn/nsn-parts-9558/ left alone next to a rewritten sibling. valueShape
//     keeps digit-run LENGTH, so human-identical neighbours land in different
//     strata and one can be agreed while the next is not.
//
// In both, the operator's question is the same: WHICH ones were missed. This
// answers it from the pass that is already running.
//
// WHY A WRAPPER AND NOT A SECOND SCAN. The rewrite already streams every <loc> of
// every file in scope. A separate read-only pass would double the disk work on a
// 6.58M-loc session to recount URLs the rewriter has just finished looking at,
// and it could disagree with the rewrite about what counts as a <loc> or as a
// pattern member. Wrapping means one traversal and, by construction, the same
// verdict — the same reason scanSitemapLocs is built on the rewrite transform.
//
// THE WRAPPER IS TRANSPARENT. It returns the inner rewriter's answer unchanged,
// including null. No byte of output moves because a tally is attached.

export type SkippedShape = {
  // valueShape of the pathname — the same key pattern_shape_rules is keyed on,
  // so a shape listed here can be looked up there to see whether it was sampled
  // and disagreed, or was never probed at all.
  shape: string;
  count: number;
  // One real URL of this shape, so the UI can show the operator something they
  // recognise instead of "/a/a-a-9999/".
  example: string;
};

export type SkippedReport = {
  // <loc>s that matched the pattern and were left unchanged.
  skippedInScope: number;
  // Biggest first, capped at `shapeLimit`.
  byShape: SkippedShape[];
  // True when more distinct shapes were seen than `byShape` holds, so the UI can
  // say the list is a top-N rather than implying it is exhaustive.
  shapesTruncated: boolean;
};

// Distinct shapes to keep. Bounded for the reason every histogram in this
// codebase is bounded: an unbounded map over a population in the millions is an
// out-of-memory crash, and a transform producing more than a couple of dozen
// shapes has already told the operator what they need to know. Matches
// transformDryRun's SHAPE_LIMIT deliberately — the two lists are read side by
// side in the modal and a different cap in each would be a puzzle.
export const SKIPPED_SHAPE_LIMIT = 25;

export function emptySkippedReport(): SkippedReport {
  return { skippedInScope: 0, byShape: [], shapesTruncated: false };
}

// Merge one file's report into a running total. Used by the callers that walk
// several files (both apply paths do), and by the job that has to fold reports
// coming back from worker threads.
//
// The merged shape list is re-capped, so folding 187 files each holding up to 25
// shapes still yields at most SKIPPED_SHAPE_LIMIT — and `shapesTruncated` stays
// sticky once any input had more than it could hold.
export function mergeSkippedReports(
  reports: Iterable<SkippedReport>
): SkippedReport {
  const counts = new Map<string, { count: number; example: string }>();
  let skippedInScope = 0;
  let truncated = false;

  for (const report of reports) {
    skippedInScope += report.skippedInScope;
    truncated = truncated || report.shapesTruncated;

    for (const entry of report.byShape) {
      const existing = counts.get(entry.shape);

      if (existing) {
        existing.count += entry.count;
      } else {
        counts.set(entry.shape, {
          count: entry.count,
          example: entry.example
        });
      }
    }
  }

  const byShape = Array.from(counts.entries())
    .map(([shape, entry]) => ({
      shape,
      count: entry.count,
      example: entry.example
    }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape));

  return {
    skippedInScope,
    byShape: byShape.slice(0, SKIPPED_SHAPE_LIMIT),
    shapesTruncated: truncated || byShape.length > SKIPPED_SHAPE_LIMIT
  };
}

// Wrap a rewriter so the <loc>s it declines are counted and sampled by shape.
//
// `template` is the pattern's template. It is what separates "this URL belongs to
// the pattern and was not fixed" — the number the operator wants — from "this URL
// is some other pattern's and was never in scope", which is most of a shared
// sitemap file and would drown the real answer. Matching is delegated to
// pathMatchesTemplate, the same predicate the rewriters and the population
// verifier use, so this cannot drift into its own idea of membership.
//
// A structure scope, when one is set, is already ANDed into `rewriter` by
// applyStructureFilterToRewriter — an out-of-scope URL returns null there and is
// counted here as skipped. That is deliberate and it is the honest reading: the
// operator narrowed the edit, and those URLs really are pattern members this
// apply did not change.
export function tallySkippedInScope(
  rewriter: LocUrlRewriter,
  options: { template: string; shapeLimit?: number }
): { rewriter: LocUrlRewriter; report: () => SkippedReport } {
  const shapeLimit = options.shapeLimit ?? SKIPPED_SHAPE_LIMIT;
  const shapes = new Map<string, { count: number; example: string }>();
  let skippedInScope = 0;
  let overflowed = false;

  const wrapped: LocUrlRewriter = (url) => {
    const next = rewriter(url);

    if (next !== null) {
      return next;
    }

    let pathname: string;

    try {
      pathname = new URL(url).pathname;
    } catch {
      // Not a URL this apply could ever have rewritten, and not classifiable
      // either. Counting it would report a malformed <loc> as a missed fix.
      return null;
    }

    if (!pathMatchesTemplate(pathname, options.template)) {
      return null;
    }

    skippedInScope += 1;

    const shape = valueShape(pathname);
    const existing = shapes.get(shape);

    if (existing) {
      existing.count += 1;
    } else if (shapes.size < shapeLimit) {
      shapes.set(shape, { count: 1, example: url });
    } else {
      // Past the cap the histogram stops growing and says so, rather than
      // implying the list below is everything.
      overflowed = true;
    }

    return null;
  };

  return {
    rewriter: wrapped,
    report: () => ({
      skippedInScope,
      byShape: Array.from(shapes.entries())
        .map(([shape, entry]) => ({
          shape,
          count: entry.count,
          example: entry.example
        }))
        .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape)),
      shapesTruncated: overflowed
    })
  };
}
