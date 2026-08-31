import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SKIPPED_SHAPE_COUNT_LIMIT,
  SKIPPED_SHAPE_LIMIT,
  emptySkippedReport,
  mergeSkippedReports,
  tallySkippedInScope,
  EXAMPLES_PER_SHAPE
} from "./applyCoverage.js";
import type { LocUrlRewriter } from "./rewriteLocs.js";

const TEMPLATE = "/nsn/{param}/";

// Rewrites only the URLs it was told about — the shape of every real apply, where
// reach is bounded by confirmed destinations and agreed rules.
function rewriterFor(known: Record<string, string>): LocUrlRewriter {
  return (url) => known[url] ?? null;
}

test("the wrapper is transparent: every answer passes through unchanged", () => {
  // The one property that must hold no matter what the tally does. A rewrite that
  // moved a byte because a counter was attached would be a far worse bug than the
  // silence this module exists to end.
  const known = {
    "https://x.test/nsn/nsn-parts-1/": "https://x.test/nsn/parts-1/"
  };
  const { rewriter } = tallySkippedInScope(rewriterFor(known), {
    template: TEMPLATE
  });

  assert.equal(
    rewriter("https://x.test/nsn/nsn-parts-1/"),
    "https://x.test/nsn/parts-1/"
  );
  assert.equal(rewriter("https://x.test/nsn/nsn-parts-2/"), null);
  assert.equal(rewriter("https://x.test/other/thing/"), null);
  assert.equal(rewriter("not a url"), null);
});

test("counts pattern members the rewriter declined, and nothing else", () => {
  const { rewriter, report } = tallySkippedInScope(
    rewriterFor({
      "https://x.test/nsn/nsn-parts-1/": "https://x.test/nsn/parts-1/"
    }),
    { template: TEMPLATE }
  );

  rewriter("https://x.test/nsn/nsn-parts-1/"); // rewritten -> not skipped
  rewriter("https://x.test/nsn/nsn-parts-2/"); // skipped, in pattern
  rewriter("https://x.test/nsn/nsn-parts-3/"); // skipped, in pattern
  // Out of the pattern: a different segment count, and a different literal. Most
  // of a shared sitemap file looks like this and counting it would drown the real
  // answer.
  rewriter("https://x.test/nsn/nsn-parts/page-2-4628/");
  rewriter("https://x.test/cage/nsn-parts-4/");
  // Unparseable <loc> — not a missed fix, it was never rewritable.
  rewriter("://broken");

  assert.equal(report().skippedInScope, 2);
});

test("the reported case: digit-run length splits human-identical siblings", () => {
  // valueShape keeps digit-run length, so /nsn/nsn-parts-9558/ and
  // /nsn/nsn-parts-12191/ are DIFFERENT shapes — which is why one can have an
  // agreed rule and its neighbour none, and why the skipped list has to be
  // grouped this way for the operator to recognise what happened.
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: TEMPLATE
  });

  rewriter("https://x.test/nsn/nsn-parts-9558/");
  rewriter("https://x.test/nsn/nsn-parts-3345/");
  rewriter("https://x.test/nsn/nsn-parts-12191/");

  const { byShape } = report();

  assert.equal(byShape.length, 2);
  // Biggest first, so the operator reads the shape that costs the most URLs.
  assert.equal(byShape[0].shape, "/a/a-a-9999/");
  assert.equal(byShape[0].count, 2);
  // A real URL, not the normalised form — "/a/a-a-9999/" means nothing to an SEO.
  assert.equal(byShape[0].example, "https://x.test/nsn/nsn-parts-9558/");
  assert.equal(byShape[1].shape, "/a/a-a-99999/");
});

test("the shape histogram is capped and admits it", () => {
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: TEMPLATE,
    shapeLimit: 2
  });

  rewriter("https://x.test/nsn/a-1/");
  rewriter("https://x.test/nsn/a-11/");
  rewriter("https://x.test/nsn/a-111/");

  const result = report();

  assert.equal(result.skippedInScope, 3, "every skip is still counted");
  assert.equal(result.byShape.length, 2);
  assert.equal(result.shapesTruncated, true);
});

test("an untruncated report does not claim truncation", () => {
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: TEMPLATE
  });

  rewriter("https://x.test/nsn/a-1/");

  assert.equal(report().shapesTruncated, false);
});

test("one tally across many files counts the files a shape spans", () => {
  // THE redirectApply PATH. It deliberately keeps a single tally for the whole
  // apply, so without beginFile every shape would report "1 file" however many
  // it really spanned — and the dialog shows that number as the blast radius the
  // operator approves a rule against.
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: "/nsn/{param}/"
  });

  const seen = report;

  const tally = tallySkippedInScope(rewriterFor({}), {
    template: "/nsn/{param}/"
  });

  tally.beginFile("current-a.xml");
  tally.rewriter("https://x.test/nsn/a-1/");
  tally.rewriter("https://x.test/nsn/a-2/");
  tally.beginFile("current-b.xml");
  tally.rewriter("https://x.test/nsn/a-3/");

  const shape = tally.report().byShape[0];

  assert.equal(shape.count, 3);
  assert.equal(shape.files, 2, "three URLs, but only two files");
  // Examples accumulate across files, capped, and stay in encounter order so the
  // operator sees stable URLs between runs.
  assert.deepEqual(shape.examples, [
    "https://x.test/nsn/a-1/",
    "https://x.test/nsn/a-2/",
    "https://x.test/nsn/a-3/"
  ]);
  assert.equal(shape.example, shape.examples[0]);

  // And the per-file callers, which never call beginFile, still get 1.
  rewriter("https://x.test/nsn/a-1/");
  assert.equal(seen().byShape[0].files, 1);
});

test("examples per shape are capped", () => {
  const tally = tallySkippedInScope(rewriterFor({}), {
    template: "/nsn/{param}/"
  });

  for (let index = 0; index < 10; index += 1) {
    tally.rewriter(`https://x.test/nsn/a-${index}/`);
  }

  const shape = tally.report().byShape[0];

  assert.equal(shape.count, 10, "the count is never capped");
  assert.equal(shape.examples.length, EXAMPLES_PER_SHAPE);
});

test("merging folds per-file reports without losing the cap or the flag", () => {
  const merged = mergeSkippedReports([
    {
      skippedInScope: 3,
      byShape: [
        {
          shape: "/a/a-9999/",
          count: 3,
          example: "u1",
          examples: ["u1"],
          files: 1
        }
      ],
      shapesTruncated: false
    },
    {
      skippedInScope: 5,
      byShape: [
        {
          shape: "/a/a-9999/",
          count: 4,
          example: "u2",
          examples: ["u2"],
          files: 1
        },
        {
          shape: "/a/a-99/",
          count: 1,
          example: "u3",
          examples: ["u3"],
          files: 1
        }
      ],
      shapesTruncated: true
    }
  ]);

  assert.equal(merged.skippedInScope, 8);
  assert.equal(merged.byShape[0].shape, "/a/a-9999/");
  assert.equal(merged.byShape[0].count, 7);
  // The FIRST example seen wins, so the URL shown stays stable across re-runs
  // rather than depending on which file finished last.
  assert.equal(merged.byShape[0].example, "u1");
  // Examples from both files are kept, up to the cap — the rule editor needs
  // more than one pair before deriveRedirectRule can reject a rule that only
  // works for the URL the operator happens to be looking at.
  assert.deepEqual(merged.byShape[0].examples, ["u1", "u2"]);
  // Two per-file reports saw this shape, so it spans two files. This is the
  // number the dialog shows as blast radius next to the URL count.
  assert.equal(merged.byShape[0].files, 2);
  assert.equal(merged.shapesTruncated, true, "truncation is sticky");
});

test("merging re-caps a list assembled from many files", () => {
  // 187 files each holding up to SKIPPED_SHAPE_LIMIT shapes must not produce a
  // list of thousands.
  const reports = Array.from({ length: 4 }, (_, file) => ({
    skippedInScope: 10,
    byShape: Array.from({ length: 10 }, (_, index) => ({
      shape: `/a/${file}-${index}/`,
      count: 1,
      example: `u${file}-${index}`,
      examples: [`u${file}-${index}`],
      files: 1
    })),
    shapesTruncated: false
  }));

  const merged = mergeSkippedReports(reports);

  assert.equal(merged.byShape.length, SKIPPED_SHAPE_LIMIT);
  assert.equal(merged.shapesTruncated, true);
  assert.equal(merged.skippedInScope, 40, "the total is never capped");
});

test("an empty report merges to an empty report", () => {
  assert.deepEqual(mergeSkippedReports([]), emptySkippedReport());
});

// COUNTING AND REPORTING ARE TWO LIMITS (v1.90).
//
// THE BUG. They used to be one number, 25, and the tally admits a shape only
// while it has room — with no eviction. So a report was the first 25 shapes SEEN,
// never the 25 biggest, however the dialog worded it. On the queued path each
// file gets its own tally and the reports are merged, so a shape was counted only
// in the files where it happened to land inside that file's first 25.
//
// THE VISIBLE SYMPTOM, from the reported session: the dialog promised 74,329 URLs
// across 25 groups and the apply rewrote 149,745 — because the rewriter fixes each
// shape's FULL population while the numbers describing it had been clipped per
// file. A dialog that under-quotes what it is about to do is the same class of
// wrong as one that over-quotes it.

test("the two limits are separate, and counting is the wider one", () => {
  // Pinned rather than assumed: making them equal again silently restores the
  // under-count, and nothing else in the suite would notice.
  assert.ok(
    SKIPPED_SHAPE_COUNT_LIMIT > SKIPPED_SHAPE_LIMIT,
    "counting must admit more shapes than are reported, or the top-N is a first-N"
  );
});

test("a shape seen after the 25th is still counted in full", () => {
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: TEMPLATE
  });

  // 30 small shapes first, so the interesting one arrives well past #25.
  //
  // DISTINCT SHAPES COME FROM PUNCTUATION, not from longer names: valueShape
  // collapses a whole letter run to one "a", so "aaa-1" and "a-1" are the SAME
  // shape. Each extra "-1" adds a "-9" and makes a genuinely new one.
  for (let index = 0; index < 30; index += 1) {
    rewriter(`https://x.test/nsn/a${"-1".repeat(index + 1)}/`);
  }

  // Then the biggest group in the pattern. Under one limit this shape would have
  // been refused admission entirely and vanished into a boolean.
  for (let index = 0; index < 90; index += 1) {
    rewriter(`https://x.test/nsn/late-${1000 + index}/`);
  }

  const result = report();
  const late = result.byShape.find((entry) => entry.shape === "/a/a-9999/");

  assert.ok(late, "a shape first seen past #25 must still be counted");
  assert.equal(late.count, 90, "and counted in full, not partially");
  assert.equal(result.skippedInScope, 120);
});

test("the biggest groups are the ones that survive the merge", () => {
  // END TO END over the queued path's shape: many per-file tallies, folded. The
  // late-arriving shape is the largest in the pattern and must lead the list.
  const reports = [];

  for (let file = 0; file < 3; file += 1) {
    const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
      template: TEMPLATE
    });

    for (let index = 0; index < 30; index += 1) {
      rewriter(`https://x.test/nsn/a${"-1".repeat(index + 1)}/`);
    }

    for (let index = 0; index < 40; index += 1) {
      rewriter(`https://x.test/nsn/late-${1000 + index}/`);
    }

    reports.push(report());
  }

  const merged = mergeSkippedReports(reports);

  assert.equal(merged.byShape[0].shape, "/a/a-9999/");
  assert.equal(merged.byShape[0].count, 120, "40 per file across 3 files");
  assert.equal(merged.byShape[0].files, 3);
  assert.equal(merged.byShape.length, SKIPPED_SHAPE_LIMIT);
  assert.equal(merged.skippedInScope, 210);
});

test("a per-file report is NOT pre-capped to the reported limit", () => {
  // The mistake this replaces, stated as a test. Capping inside report() looks
  // harmless — the dialog shows 25 either way — but on the queued path this report
  // describes ONE FILE and is then folded into 652 others, so a slice here hands
  // the fold a pre-clipped view of every file and reproduces the under-count
  // exactly. Whoever shows a report to a human caps it; the tally does not.
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: TEMPLATE
  });

  for (let index = 0; index < 40; index += 1) {
    rewriter(`https://x.test/nsn/a${"-1".repeat(index + 1)}/`);
  }

  assert.equal(report().byShape.length, 40);
});

test("past the counting limit it still stops, and still says so", () => {
  // The bound is raised, not removed: this map is built while streaming millions
  // of <loc>s and an unbounded histogram over them is an out-of-memory crash.
  const { rewriter, report } = tallySkippedInScope(rewriterFor({}), {
    template: TEMPLATE,
    shapeLimit: 3
  });

  for (let index = 0; index < 10; index += 1) {
    rewriter(`https://x.test/nsn/a${"-1".repeat(index + 1)}/`);
  }

  const result = report();

  assert.equal(result.byShape.length, 3);
  assert.equal(result.shapesTruncated, true, "a short list must admit it is short");
  assert.equal(result.skippedInScope, 10, "the total is never clipped");
});
