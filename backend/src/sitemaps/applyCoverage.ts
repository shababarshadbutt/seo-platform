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
  // recognise instead of "/a/a-a-9999/". Always examples[0] — derived rather
  // than tracked separately so the two can never disagree.
  example: string;
  // Up to EXAMPLES_PER_SHAPE real URLs (v1.84). The Review dialog asks the
  // operator to edit these into what they SHOULD be and derives a rule from the
  // pairs, which is why one is not enough: deriveRedirectRule needs more than a
  // single pair before it can tell a real transformation from a coincidence.
  examples: string[];
  // How many distinct FILES this shape was skipped in (v1.84). The operator
  // sees "285,851 URLs · 42 files" before approving a rule, because the URL
  // count alone does not convey the blast radius of getting it wrong.
  files: number;
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

// Real URLs kept per shape. Three because that is what the rule editor needs:
// one pair can be reproduced by infinitely many rules, and a handful lets
// deriveRedirectRule reject an edit that only works for the example in front of
// the operator. More would be noise in a dialog row.
export const EXAMPLES_PER_SHAPE = 3;

export function emptySkippedReport(): SkippedReport {
  return { skippedInScope: 0, byShape: [], shapesTruncated: false };
}

// Fold b's examples into a's, keeping order and stopping at the cap.
function mergeExamples(into: string[], from: readonly string[]): string[] {
  const merged = [...into];

  for (const example of from) {
    if (merged.length >= EXAMPLES_PER_SHAPE) {
      break;
    }

    if (!merged.includes(example)) {
      merged.push(example);
    }
  }

  return merged;
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
  const counts = new Map<
    string,
    { count: number; examples: string[]; files: number }
  >();
  let skippedInScope = 0;
  let truncated = false;

  for (const report of reports) {
    skippedInScope += report.skippedInScope;
    truncated = truncated || report.shapesTruncated;

    for (const entry of report.byShape) {
      const existing = counts.get(entry.shape);

      if (existing) {
        existing.count += entry.count;
        existing.examples = mergeExamples(existing.examples, entry.examples);
        // SUMMED, and that is only right because each report being folded here
        // describes a DIFFERENT file — which is the contract of the per-file
        // callers (applyRedirectsJob and the worker pool). Folding two reports
        // covering the same file would double-count it.
        existing.files += entry.files;
      } else {
        counts.set(entry.shape, {
          count: entry.count,
          examples: [...entry.examples],
          files: entry.files
        });
      }
    }
  }

  const byShape = Array.from(counts.entries())
    .map(([shape, entry]) => ({
      shape,
      count: entry.count,
      example: entry.examples[0] ?? "",
      examples: entry.examples,
      files: entry.files
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
// `beginFile` exists because the two apply paths tally at different
// granularities and both must produce the same per-shape FILE count.
// applyRedirectsJob makes a fresh tally per file and merges the reports;
// redirectApply deliberately keeps ONE tally across every file of the apply (see
// its comment). Without a file boundary the second could only ever report "1".
//
// Callers that already tally per file need not call it: the unnamed default
// bucket yields files = 1 for every shape seen, which is exactly right for a
// report describing one file.
export function tallySkippedInScope(
  rewriter: LocUrlRewriter,
  options: { template: string; shapeLimit?: number }
): {
  rewriter: LocUrlRewriter;
  beginFile: (fileKey: string) => void;
  report: () => SkippedReport;
} {
  const shapeLimit = options.shapeLimit ?? SKIPPED_SHAPE_LIMIT;
  // files is a Set, not a counter, so the same file cannot be counted twice when
  // its <loc>s are interleaved or revisited. Bounded by the pattern's FILE count
  // (hundreds), not by its URL population (millions) — which is why this one is
  // safe to keep whole while the shape histogram above is capped.
  const shapes = new Map<
    string,
    { count: number; examples: string[]; files: Set<string> }
  >();
  let currentFile = "";
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
      existing.files.add(currentFile);

      if (existing.examples.length < EXAMPLES_PER_SHAPE) {
        existing.examples.push(url);
      }
    } else if (shapes.size < shapeLimit) {
      shapes.set(shape, {
        count: 1,
        examples: [url],
        files: new Set([currentFile])
      });
    } else {
      // Past the cap the histogram stops growing and says so, rather than
      // implying the list below is everything.
      overflowed = true;
    }

    return null;
  };

  return {
    rewriter: wrapped,
    beginFile: (fileKey: string) => {
      currentFile = fileKey;
    },
    report: () => ({
      skippedInScope,
      byShape: Array.from(shapes.entries())
        .map(([shape, entry]) => ({
          shape,
          count: entry.count,
          example: entry.examples[0] ?? "",
          examples: entry.examples,
          files: entry.files.size
        }))
        .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape)),
      shapesTruncated: overflowed
    })
  };
}
