import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coverageFromVerdicts,
  DEFAULT_SHAPE_SAMPLE,
  groupByShape,
  judgeStratum,
  sampleStratum,
  ShapeReservoir,
  sweepablePatternIds
} from "./shapeStrata.js";

function urls(count: number, make: (index: number) => string): string[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

test("digit LENGTH splits strata — the reason this saves any time", () => {
  // The reported pattern's six shapes summed to its population exactly. Length
  // is what separates them, and it is what a token-boundary filter cannot see.
  const strata = groupByShape([
    "https://x.com/nsn/nsn-parts-12191/",
    "https://x.com/nsn/nsn-parts-12192/",
    "https://x.com/nsn/nsn-parts-6492/",
    "https://x.com/nsn/page-1-34/"
  ]);

  assert.deepEqual(
    strata.map((s) => [s.shape, s.urls.length]),
    [
      ["/a/a-a-99999/", 2],
      ["/a/a-a-9999/", 1],
      ["/a/a-9-99/", 1]
    ]
  );
});

test("biggest stratum first", () => {
  // A run cut short should already have cleared the shapes whose extrapolation
  // saves the most probing.
  const strata = groupByShape([
    ...urls(3, (i) => `https://x.com/p/a-${i}/`),
    ...urls(9, (i) => `https://x.com/p/a-${1000 + i}/`)
  ]);

  assert.equal(strata[0].urls.length, 9);
  assert.equal(strata[1].urls.length, 3);
});

test("unparseable entries are dropped, not bucketed", () => {
  const strata = groupByShape(["https://x.com/p/a-1/", "nonsense"]);

  assert.equal(strata.length, 1);
  assert.equal(strata[0].urls.length, 1);
});

test("a small stratum is probed end to end", () => {
  const stratum = { shape: "s", urls: urls(10, (i) => `https://x.com/p/a-${i}/`) };

  assert.equal(sampleStratum(stratum, 50).length, 10);
});

test("a large stratum is sampled EVENLY, not from the front", () => {
  // Enumeration order follows file order, so the first N are usually one
  // sitemap file and one contiguous id range — the slice most likely to look
  // uniform whether or not the shape actually is. An even spread is what makes
  // "the samples agreed" mean something.
  const stratum = {
    shape: "s",
    urls: urls(1000, (i) => `https://x.com/p/a-${i}/`)
  };
  const picked = sampleStratum(stratum, 10);

  assert.equal(picked.length, 10);
  assert.equal(picked[0], "https://x.com/p/a-0/");
  assert.equal(picked[9], "https://x.com/p/a-900/");
  // Distinct, and spanning the stratum rather than clustering.
  assert.equal(new Set(picked).size, 10);
});

test("consistent samples yield a trusted rule", () => {
  const stratum = { shape: "s", urls: urls(500, (i) => `https://x.com/p/a-${i}/`) };
  const verdict = judgeStratum(
    stratum,
    [
      { source: "https://x.com/old/a-1/", dest: "https://x.com/new/a-1/" },
      { source: "https://x.com/old/a-2/", dest: "https://x.com/new/a-2/" }
    ],
    50
  );

  assert.equal(verdict.agreed, true);
  assert.deepEqual(verdict.rule, {
    kind: "replace",
    find: "old",
    replace: "new"
  });
});

test("samples that DISAGREE are not trusted — they escalate", () => {
  // The hybrid half. Two different edits within one shape means the shape is not
  // uniform, and extrapolating would rewrite on no evidence.
  const stratum = { shape: "s", urls: urls(500, (i) => `https://x.com/p/a-${i}/`) };
  const verdict = judgeStratum(
    stratum,
    [
      { source: "https://x.com/old/a-1/", dest: "https://x.com/new/a-1/" },
      { source: "https://x.com/old/a-2/", dest: "https://x.com/other/a-2/" }
    ],
    50
  );

  assert.equal(verdict.agreed, false);
  assert.equal(verdict.rule, null);
});

test("a shape where nothing redirected is NOT agreement", () => {
  // No evidence is not the same as consistent evidence. Calling this agreed
  // would license rewriting the shape having learned nothing about it.
  const stratum = { shape: "s", urls: urls(500, (i) => `https://x.com/p/a-${i}/`) };
  const verdict = judgeStratum(stratum, [], 50);

  assert.equal(verdict.agreed, false);
  assert.equal(verdict.rule, null);
});

test("coverage separates measured from extrapolated, and never sums them", () => {
  const coverage = coverageFromVerdicts([
    {
      shape: "/a/a-a-99999/",
      population: 18652,
      sampleSize: 50,
      rule: { kind: "replace", find: "a", replace: "b" },
      agreed: true
    },
    {
      shape: "/a/a-a-999/",
      population: 899,
      sampleSize: 50,
      rule: null,
      agreed: false
    }
  ]);

  assert.equal(coverage.measured, 100);
  // Only the trusted shape's unprobed remainder is inference.
  assert.equal(coverage.extrapolated, 18602);
  assert.equal(coverage.trustedShapes, 1);
  assert.deepEqual(coverage.unagreedShapes, ["/a/a-a-999/"]);
});

test("a fully probed stratum extrapolates nothing", () => {
  // population === sampleSize: everything was fetched, so there is no inference
  // to report. A negative here would quietly shrink the total.
  const coverage = coverageFromVerdicts([
    {
      shape: "s",
      population: 30,
      sampleSize: 30,
      rule: { kind: "replace", find: "a", replace: "b" },
      agreed: true
    }
  ]);

  assert.equal(coverage.measured, 30);
  assert.equal(coverage.extrapolated, 0);
});

test("the default sample is a flat count, not a percentage", () => {
  // A percentage would make the big shapes — the ones that cost the hours — the
  // most expensive to clear, which is backwards.
  assert.equal(DEFAULT_SHAPE_SAMPLE, 50);
  assert.equal(sampleStratum({ shape: "s", urls: urls(500000, (i) => `https://x.com/p/a-${i}/`) }).length, 50);
});

// --- the sweep guard (v1.70) -----------------------------------------------
// The only defect in this area that DESTROYS data, so it gets the first test.

test("a stratified run sweeps NOTHING", () => {
  // The sweep deletes verified rows the run did not touch, on the premise that
  // the run enumerated everything. A sampled run touches ~50 per shape by
  // design, so that premise is false and the sweep would delete the measured
  // verdicts an earlier full verification spent hours producing.
  assert.deepEqual(
    sweepablePatternIds({ strategy: "stratified", patternIds: ["a", "b"] }),
    []
  );
});

test("a full run still sweeps its patterns", () => {
  // The guard must not have disabled the sweep in the case it exists for: a full
  // run DID enumerate everything, so a row it never saw is genuinely gone.
  assert.deepEqual(
    sweepablePatternIds({ strategy: "full", patternIds: ["a", "b"] }),
    ["a", "b"]
  );
});

// --- the streaming reservoir (v1.70) --------------------------------------

// Deterministic source so Algorithm R's behaviour is pinned rather than sampled.
function cyclingRandom(values: number[]): () => number {
  let index = 0;

  return () => {
    const value = values[index % values.length];

    index += 1;

    return value;
  };
}

test("counts the whole population while holding only the sample", () => {
  // The point of the class: 10,000 URLs seen, at most 50 retained.
  const reservoir = new ShapeReservoir({ sampleSize: 50 });

  for (let index = 0; index < 10000; index += 1) {
    reservoir.offer("/a/a-99999/", `https://x.com/p/a-${10000 + index}/`);
  }

  assert.equal(reservoir.populationOf("/a/a-99999/"), 10000);
  assert.equal(reservoir.sampledUrls().length, 50);
  assert.equal(reservoir.totalPopulation, 10000);
  assert.equal(reservoir.shapeCount, 1);
});

test("a shape smaller than the sample size is kept whole", () => {
  const reservoir = new ShapeReservoir({ sampleSize: 50 });

  for (let index = 0; index < 7; index += 1) {
    reservoir.offer("/a/a-9/", `https://x.com/p/a-${index}/`);
  }

  assert.equal(reservoir.populationOf("/a/a-9/"), 7);
  assert.equal(reservoir.sampledUrls().length, 7);
});

test("each shape gets its own reservoir and its own count", () => {
  const reservoir = new ShapeReservoir({ sampleSize: 2 });

  for (let index = 0; index < 9; index += 1) {
    reservoir.offer("/a/a-99999/", `https://x.com/five-${index}/`);
  }

  for (let index = 0; index < 3; index += 1) {
    reservoir.offer("/a/a-9999/", `https://x.com/four-${index}/`);
  }

  assert.equal(reservoir.populationOf("/a/a-99999/"), 9);
  assert.equal(reservoir.populationOf("/a/a-9999/"), 3);
  // Two shapes x sampleSize 2.
  assert.equal(reservoir.sampledUrls().length, 4);
});

test("strata come back biggest population first", () => {
  // So a run cut short has already cleared the shapes whose extrapolation saves
  // the most probing.
  const reservoir = new ShapeReservoir({ sampleSize: 5 });

  reservoir.offer("/small/", "https://x.com/s-1/");

  for (let index = 0; index < 40; index += 1) {
    reservoir.offer("/big/", `https://x.com/b-${index}/`);
  }

  assert.deepEqual(
    reservoir.strata().map((stratum) => stratum.shape),
    ["/big/", "/small/"]
  );
});

test("a later item CAN displace an earlier one — the sample is not the first N", () => {
  // Algorithm R with random() = 0 always targets slot 0, so the last URL offered
  // must have replaced the first. If the reservoir were "keep the first N" this
  // assertion fails, and that is the failure mode that matters: enumeration order
  // follows file order, so the first N of a shape are usually all neighbours and
  // "the samples agreed" would mean nothing.
  const reservoir = new ShapeReservoir({
    sampleSize: 2,
    random: cyclingRandom([0])
  });

  reservoir.offer("/s/", "first");
  reservoir.offer("/s/", "second");
  reservoir.offer("/s/", "third");

  const samples = reservoir.strata()[0].urls;

  assert.equal(reservoir.populationOf("/s/"), 3);
  assert.deepEqual(samples, ["third", "second"]);
});

test("an out-of-range draw keeps the reservoir untouched", () => {
  // random() near 1 puts the index past the reservoir, which is the "do not
  // replace" branch — the arm that makes the probability sampleSize/n rather
  // than 1.
  const reservoir = new ShapeReservoir({
    sampleSize: 2,
    random: cyclingRandom([0.99])
  });

  reservoir.offer("/s/", "first");
  reservoir.offer("/s/", "second");
  reservoir.offer("/s/", "third");

  assert.deepEqual(reservoir.strata()[0].urls, ["first", "second"]);
  assert.equal(reservoir.populationOf("/s/"), 3);
});

test("judgeStratum takes the sample size separately, not the reservoir's length", () => {
  // A ShapeStratum from the reservoir carries the SAMPLE in .urls, so its length
  // is not the population — which is why judgeStratum takes both. Getting this
  // wrong would report population 50 for a 10,000-URL shape and extrapolate
  // nothing.
  const reservoir = new ShapeReservoir({ sampleSize: 3 });

  for (let index = 0; index < 900; index += 1) {
    reservoir.offer("/s/", `https://x.com/old/a-${index}/`);
  }

  const stratum = reservoir.strata()[0];
  const verdict = judgeStratum(
    { shape: stratum.shape, urls: new Array(reservoir.populationOf("/s/")) },
    [
      { source: "https://x.com/old/a-1/", dest: "https://x.com/new/a-1/" },
      { source: "https://x.com/old/a-2/", dest: "https://x.com/new/a-2/" }
    ],
    stratum.urls.length
  );

  assert.equal(verdict.population, 900);
  assert.equal(verdict.sampleSize, 3);
  assert.equal(verdict.agreed, true);
});
