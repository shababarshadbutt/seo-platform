import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanTransformDryRun } from "./transformDryRunScan.js";
import { destroyDryRunScanPool } from "./dryRunScanPool.js";
import type { PatternScanTarget } from "../sitemaps/patternFileScan.js";
import type { DryRunTotals } from "../sitemaps/transformDryRun.js";

// THE EQUIVALENCE THIS FILE EXISTS FOR: scanning across worker threads must
// answer exactly what scanning inline answers.
//
// Splitting the files across threads is only safe because every counter either
// adds or merges. The one that does NOT simply add is COLLISIONS — "two URLs
// collapse onto one" is a property of the whole population, so a pair whose two
// halves land in different threads is invisible to both of them and can only be
// found when their partials meet. The fixture below puts such a pair in
// DIFFERENT FILES on purpose; without the hash merge in mergeDryRunPartials the
// parallel run reports fewer collisions than the serial one and this test fails.
//
// The path is chosen by `totalUrls` against DRY_RUN_PARALLEL_THRESHOLD, so both
// can be driven from one process by passing a small or a huge number — no env
// juggling, and no reliance on module load order.
const INLINE = 0;
const POOLED = 10_000_000;

// Everything a scan measures, minus the illustrative URLs.
//
// The EXAMPLES are deliberately excluded from the equality check rather than
// forced to agree. Which URL illustrates a shape is "whichever was seen first",
// and both paths read files concurrently, so first is a race in either of them.
// Pinning it would mean comparing candidates on every one of 6.58M observations
// to make a cosmetic field deterministic. The COUNTS are what a decision rests
// on, so those must match exactly; the examples are checked for presence
// separately.
function comparable(totals: DryRunTotals) {
  return {
    ...totals,
    clamped_split_example: undefined,
    collision_example: undefined,
    shapes: totals.shapes.map((shape) => ({
      shape: shape.shape,
      count: shape.count
    }))
  };
}

const BASE = "https://example.com";
const workDir = mkdtempSync(path.join(os.tmpdir(), "dry-run-scan-"));

after(async () => {
  await destroyDryRunScanPool();
  rmSync(workDir, { recursive: true, force: true });
});

function writeTarget(name: string, urls: string[]): PatternScanTarget {
  const inputPath = path.join(workDir, name);

  writeFileSync(
    inputPath,
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
      urls.map((url) => `  <url><loc>${url}</loc></url>`).join("\n") +
      "\n</urlset>\n",
    "utf8"
  );

  return {
    displayName: name,
    storedFilename: name,
    inputPath,
    isGzip: false
  };
}

// Ten files. File 0 and file 1 hold DIFFERENT URLs that strip to the SAME
// result — the cross-file collision. File 2 holds a same-file collision, so the
// test would still fail if the merge counted cross-file pairs but dropped the
// local ones the workers found themselves.
const collisionTargets: PatternScanTarget[] = [
  writeTarget("c-0.xml", [
    `${BASE}/p/alpha-catalog/`,
    `${BASE}/p/one-catalog/`,
    `${BASE}/other/skip-me/`
  ]),
  writeTarget("c-1.xml", [
    `${BASE}/p/alpha-catalog-catalog/`,
    `${BASE}/p/two-catalog/`
  ]),
  writeTarget("c-2.xml", [
    `${BASE}/p/beta-catalog/`,
    `${BASE}/p/beta-catalog-catalog/`
  ]),
  ...Array.from({ length: 7 }, (_, index) =>
    writeTarget(
      `c-pad-${index}.xml`,
      Array.from(
        { length: 20 },
        (_, seq) => `${BASE}/p/pad${index}x${seq}-catalog/`
      )
    )
  )
];

const COLLISION_SCAN = {
  targets: collisionTargets,
  currentStructure: "/p/{A}/",
  newStructure: "/p/{A|-catalog|}/",
  template: "/p/{param}",
  structureFilters: []
};

// A second corpus for the positional operator, with value lengths that vary and
// two values short enough to clamp — so the shape histogram and the clamp
// counter are exercised across threads too, not just the collision merge.
const splitTargets: PatternScanTarget[] = Array.from(
  { length: 8 },
  (_, index) =>
    writeTarget(`s-${index}.xml`, [
      `${BASE}/nspart/part-${700 + index}/`,
      `${BASE}/nspart/part-${70000 + index}/`,
      `${BASE}/nspart/ab/`,
      `${BASE}/elsewhere/${index}/`
    ])
);

const SPLIT_SCAN = {
  targets: splitTargets,
  currentStructure: "/nspart/{A}/",
  newStructure: "/nsnpart/{A|split|6|-|}/",
  template: "/nspart/{param}",
  structureFilters: []
};

test("a pooled scan reports exactly what an inline scan reports", async () => {
  const inline = await scanTransformDryRun({
    ...COLLISION_SCAN,
    totalUrls: INLINE
  });
  const pooled = await scanTransformDryRun({
    ...COLLISION_SCAN,
    totalUrls: POOLED
  });

  assert.equal(inline.parallel, false);
  assert.equal(pooled.parallel, true);
  assert.equal(inline.filesScanned, pooled.filesScanned);
  assert.equal(inline.filesSkipped, 0);
  assert.equal(pooled.filesSkipped, 0);

  // The whole point: same numbers, not merely similar ones.
  assert.deepEqual(comparable(pooled.totals), comparable(inline.totals));

  // And a collision found only at merge time is still nameable, which is what
  // the per-partial example sample exists for.
  assert.ok(
    pooled.totals.collision_example,
    "a pooled scan must still be able to show a colliding URL"
  );
});

test("the cross-file collision is actually there to be found", async () => {
  // Guards the guard. If the fixture stopped producing a collision that spans
  // two files, the equivalence test above would keep passing while proving
  // nothing about the merge.
  const inline = await scanTransformDryRun({
    ...COLLISION_SCAN,
    totalUrls: INLINE
  });

  assert.equal(inline.totals.collisions, 2, "expected one cross-file and one same-file collision");

  const pooled = await scanTransformDryRun({
    ...COLLISION_SCAN,
    totalUrls: POOLED
  });

  assert.equal(pooled.totals.collisions, 2);
});

test("shapes and clamps survive the thread boundary", async () => {
  const inline = await scanTransformDryRun({ ...SPLIT_SCAN, totalUrls: INLINE });
  const pooled = await scanTransformDryRun({ ...SPLIT_SCAN, totalUrls: POOLED });

  assert.deepEqual(comparable(pooled.totals), comparable(inline.totals));
  assert.ok(pooled.totals.clamped_split_example);

  // And the fixture really does exercise both, so the equality above is not
  // agreement about zero.
  assert.ok(inline.totals.shapes.length > 1, "expected more than one shape");
  assert.equal(inline.totals.clamped_split, splitTargets.length);
  assert.equal(inline.totals.skipped, 0);
});

test("a single-file pattern stays inline however many URLs it claims", async () => {
  // One file cannot be split across threads, so the pool would only add startup
  // cost.
  const result = await scanTransformDryRun({
    ...SPLIT_SCAN,
    targets: [splitTargets[0]],
    totalUrls: POOLED
  });

  assert.equal(result.parallel, false);
  assert.equal(result.filesScanned, 1);
});

test("an unreadable file is skipped, not fatal, on both paths", async () => {
  const missing: PatternScanTarget = {
    displayName: "gone.xml",
    storedFilename: "gone.xml",
    inputPath: path.join(workDir, "definitely-not-here.xml"),
    isGzip: false
  };
  const targets = [...splitTargets, missing];

  const inline = await scanTransformDryRun({
    ...SPLIT_SCAN,
    targets,
    totalUrls: INLINE
  });
  const pooled = await scanTransformDryRun({
    ...SPLIT_SCAN,
    targets,
    totalUrls: POOLED
  });

  assert.equal(inline.filesSkipped, 1);
  assert.equal(pooled.filesSkipped, 1);
  assert.equal(inline.filesScanned, splitTargets.length);
  assert.equal(pooled.filesScanned, splitTargets.length);
  assert.deepEqual(comparable(pooled.totals), comparable(inline.totals));
});
