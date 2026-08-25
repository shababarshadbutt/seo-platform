import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  SKIPPED_SHAPE_LINES,
  skippedShapeLines,
  skippedSummary
} from "./skipped-shapes";

const SHAPES = [
  {
    shape: "/a/a-a-9999/",
    count: 9541,
    example: "https://www.asap-distribution.com/nsn/nsn-parts-9558/"
  },
  {
    shape: "/a/a-a-99999/",
    count: 12,
    example: "https://www.asap-distribution.com/nsn/nsn-parts-12191/"
  }
];

test("each line leads with a real URL, not the internal shape key", () => {
  // The reported case. "/a/a-a-9999/" is the right key and the wrong sentence:
  // the operator is looking at a sitemap containing /nsn/nsn-parts-9558/ and
  // wants to know why THAT one was skipped.
  const lines = skippedShapeLines(SHAPES);

  assert.equal(
    lines[0],
    "9,541 like https://www.asap-distribution.com/nsn/nsn-parts-9558/"
  );
  assert.equal(lines.length, 2);
  assert.ok(
    lines.every((line) => !line.includes("/a/a-")),
    "the normalised shape never reaches the reader"
  );
});

test("a long list is trimmed and says how much it trimmed", () => {
  const many = Array.from({ length: SKIPPED_SHAPE_LINES + 3 }, (_, index) => ({
    shape: `/a/${index}/`,
    count: 10 - index,
    example: `https://x.test/${index}/`
  }));

  const lines = skippedShapeLines(many);

  assert.equal(lines.length, SKIPPED_SHAPE_LINES + 1);
  assert.equal(lines[lines.length - 1], "…and 3 more URL groups");
});

test("a backend-truncated histogram is reported as truncated, not as complete", () => {
  // Two different incompletenesses. Collapsing them would let a capped histogram
  // read as "these are the only ones", which is the class of over-claim this
  // whole release is about.
  const lines = skippedShapeLines(SHAPES, { truncated: true });

  assert.equal(lines[lines.length - 1], "…and more URL groups than could be listed");
});

test("a complete list claims nothing extra", () => {
  assert.deepEqual(skippedShapeLines(SHAPES, { truncated: false }).length, 2);
  assert.deepEqual(skippedShapeLines([]), []);
});

test("the summary states both halves and the file scope", () => {
  const summary = skippedSummary({
    applied: 12,
    skipped: 579022,
    filesEdited: 3,
    filesInPattern: 187
  });

  assert.match(summary, /12 of 579,034 URLs/);
  assert.match(summary, /across 3 of 187 files/);
  assert.match(summary, /579,022 were left unchanged/);
});

test("the summary drops the file scope when it was not measured", () => {
  const summary = skippedSummary({ applied: 12, skipped: 8 });

  assert.match(summary, /12 of 20 URLs in this pattern updated\./);
  assert.ok(!summary.includes("files"));
});
