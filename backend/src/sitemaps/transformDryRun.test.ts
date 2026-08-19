import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SHAPE_LIMIT,
  TransformDryRun,
  valueShape
} from "./transformDryRun.js";
import { parseStructure } from "./transformStructure.js";
import { pathMatchesTemplate } from "./rewriteLocs.js";

const TEMPLATE = "/nspart/{param}";

function run(
  currentRaw: string,
  nextRaw: string,
  urls: string[],
  template = TEMPLATE
) {
  const dryRun = new TransformDryRun({
    current: parseStructure(currentRaw),
    next: parseStructure(nextRaw),
    matchesPattern: (url) => {
      try {
        return pathMatchesTemplate(new URL(url).pathname, template);
      } catch {
        return false;
      }
    }
  });

  for (const url of urls) {
    dryRun.observe(url);
  }

  return dryRun.totals();
}

// --- valueShape -------------------------------------------------------------

test("valueShape keeps digit-run length and collapses letter runs", () => {
  // The asymmetry is the point: a fixed split position is right for one of
  // these and wrong for the other, so they must not share a bucket.
  assert.equal(valueShape("/nsnpart/part-7-20/"), "/a/a-9-99/");
  assert.equal(valueShape("/nsnpart/part-7-20000/"), "/a/a-9-99999/");
  // Letter length is not a risk, so "part" and "parts" do share one.
  assert.equal(valueShape("/a/part/"), valueShape("/a/parts/"));
});

test("valueShape caps very long digit runs", () => {
  assert.equal(valueShape("/a/12345678901234567890/"), `/a/${"9".repeat(12)}/`);
});

// --- counters ---------------------------------------------------------------

test("counts rewritten, unchanged, skipped and out-of-pattern separately", () => {
  // A two-param template, so the pattern spans SEVERAL structures and the one
  // being edited addresses only some of them. That is what `skipped` is for:
  // URLs the transform silently passes through because the current structure's
  // static segment does not match them.
  const totals = run(
    "/nspart/{A}/",
    "/nsnpart/{A|split|6|-|}/",
    [
      // Rewritten.
      "https://x.com/nspart/part-720/",
      "https://x.com/nspart/part-721/",
      // In the pattern, but this structure does not address it.
      "https://x.com/niinpart/part-722/",
      // Not in the pattern at all — wrong segment count.
      "https://x.com/blog/",
      "https://x.com/a/b/c/"
    ],
    "/{param}/{param}"
  );

  assert.equal(totals.total_locs, 5);
  assert.equal(totals.matched, 2);
  assert.equal(totals.rewritten, 2);
  assert.equal(totals.skipped, 1);
  assert.equal(totals.unchanged, 0);
});

test("separates a no-op transform from a non-matching structure", () => {
  // The structure matches every URL and the transform changes nothing, which
  // must NOT read as "skipped" — that is the difference between "your structure
  // is too narrow" and "your rule does nothing".
  const totals = run("/nspart/{A}/", "/nspart/{A}/", [
    "https://x.com/nspart/part-720/",
    "https://x.com/nspart/part-721/"
  ]);

  assert.equal(totals.matched, 2);
  assert.equal(totals.unchanged, 2);
  assert.equal(totals.rewritten, 0);
  assert.equal(totals.skipped, 0);
});

// --- the representativeness signal ------------------------------------------

test("different value lengths land in different shape buckets", () => {
  const totals = run("/nspart/{A}/", "/nsnpart/{A|split|6|-|}/", [
    "https://x.com/nspart/part-720/",
    "https://x.com/nspart/part-721/",
    "https://x.com/nspart/part-722/",
    // The outlier the ~1,000-URL preview pool might never have contained.
    "https://x.com/nspart/part-72000/"
  ]);

  assert.equal(totals.rewritten, 4);
  assert.equal(totals.shapes.length, 2);
  assert.deepEqual(
    totals.shapes.map((entry) => [entry.shape, entry.count]),
    [
      ["/a/a-9-99/", 3],
      ["/a/a-9-9999/", 1]
    ]
  );
  assert.equal(totals.shapes[1].after, "https://x.com/nsnpart/part-7-2000/");
});

test("the shape histogram is bounded and says when it truncated", () => {
  // Each value carries a different NUMBER of digit groups, so every one lands in
  // its own bucket. (Varying only the length of a single digit run would stop
  // producing new shapes at the 12-digit cap, well before the limit.)
  const urls = Array.from(
    { length: SHAPE_LIMIT + 10 },
    (_, index) => `https://x.com/nspart/part-7${"x1".repeat(index + 1)}/`
  );
  const totals = run("/nspart/{A}/", "/nsnpart/{A|split|6|-|}/", urls);

  assert.equal(totals.shapes.length, SHAPE_LIMIT);
  assert.equal(totals.shapes_truncated, true);
});

// --- anomalies --------------------------------------------------------------

test("counts values shorter than the split position", () => {
  const totals = run("/nspart/{A}/", "/nsnpart/{A|split|6|-|}/", [
    "https://x.com/nspart/part-720/",
    // "ab" is shorter than position 6, so the separator is appended, not
    // inserted — correct per the clamp, and almost certainly not intended.
    "https://x.com/nspart/ab/"
  ]);

  assert.equal(totals.clamped_split, 1);
  assert.equal(totals.clamped_split_example, "https://x.com/nsnpart/ab-/");
});

test("a result that merely ends with the separator is not a clamp", () => {
  // "ab-" split at 1 with "-" gives "a-b-", which ENDS WITH the separator and is
  // perfectly correct. The clamp is detected by length, not by suffix, and this
  // is the case that tells the two tests apart.
  const totals = run("/nspart/{A}/", "/nsnpart/{A|split|1|-|}/", [
    "https://x.com/nspart/ab-/"
  ]);

  assert.equal(totals.rewritten, 1);
  assert.equal(totals.shapes[0].after, "https://x.com/nsnpart/a-b-/");
  assert.equal(totals.clamped_split, 0);
});

test("clamp detection holds when the split position is exactly the length", () => {
  // position === value.length is the boundary: the separator lands at the end,
  // which is the clamp, and one off either way must not be counted with it.
  const atBoundary = run("/nspart/{A}/", "/nsnpart/{A|split|2|-|}/", [
    "https://x.com/nspart/ab/"
  ]);

  assert.equal(atBoundary.clamped_split, 1);

  const inside = run("/nspart/{A}/", "/nsnpart/{A|split|1|-|}/", [
    "https://x.com/nspart/ab/"
  ]);

  assert.equal(inside.clamped_split, 0);
});

test("counts collisions where two URLs collapse onto one", () => {
  // Stripping "-catalog" makes these two different pages the same URL.
  const totals = run("/nspart/{A}/", "/nspart/{A|-catalog|}/", [
    "https://x.com/nspart/acme-catalog/",
    "https://x.com/nspart/acme-catalog/"
  ]);

  assert.equal(totals.rewritten, 2);
  assert.equal(totals.collisions, 1);
  assert.equal(totals.collision_example, "https://x.com/nspart/acme/");
  assert.equal(totals.collision_scan_truncated, false);
});

test("a clean transform reports no anomalies", () => {
  const totals = run("/nspart/{A}/", "/nsnpart/{A|split|6|-|}/", [
    "https://x.com/nspart/part-720/",
    "https://x.com/nspart/part-721/"
  ]);

  assert.equal(totals.clamped_split, 0);
  assert.equal(totals.collisions, 0);
  assert.equal(totals.double_slash, 0);
  assert.equal(totals.shapes_truncated, false);
  assert.equal(totals.collision_scan_truncated, false);
});
