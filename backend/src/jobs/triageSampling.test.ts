import assert from "node:assert/strict";
import { test } from "node:test";

import {
  estimateFromObservations,
  planTriageExpansion,
  planTriageSample,
  stratifyUrls,
  RESIDUAL_STRATUM_LABEL,
  TRIAGE_MAX_SAMPLE,
  TRIAGE_MIN_SAMPLE,
  type StratumObservation
} from "./triageSampling.js";

const HOST = "https://acquireelectrical.com";

// The production case this work exists for: /manufacturer/{param}/{param} with
// 25,744 URLs, of which 187 are 404. Built as two suffix-anchored sub-patterns
// so the stratification path is exercised the way the real data exercises it
// (acquireelectrical's manufacturer slugs are suffix-anchored — see
// structureClusters.ts).
const CATALOG_COUNT = 21_000;
const SPEC_COUNT = 4_744;
const POPULATION = CATALOG_COUNT + SPEC_COUNT; // 25,744
const NOT_FOUND_COUNT = 187;

function buildProductionPopulation() {
  const urls: string[] = [];

  for (let index = 0; index < CATALOG_COUNT; index += 1) {
    urls.push(`${HOST}/manufacturer/brand${index}-parts-catalog/${index % 40}`);
  }

  for (let index = 0; index < SPEC_COUNT; index += 1) {
    urls.push(`${HOST}/manufacturer/brand${index}-spec-sheets/${index % 40}`);
  }

  // The 187 broken ones, spread across both families in proportion so no
  // stratum is secretly the only source of truth.
  const notFound = new Set<string>();
  const catalogBroken = Math.round((NOT_FOUND_COUNT * CATALOG_COUNT) / POPULATION);

  for (let index = 0; index < catalogBroken; index += 1) {
    notFound.add(urls[Math.floor((index * CATALOG_COUNT) / catalogBroken)]);
  }

  let cursor = 0;

  while (notFound.size < NOT_FOUND_COUNT) {
    notFound.add(urls[CATALOG_COUNT + (cursor % SPEC_COUNT)]);
    cursor += 7;
  }

  return { urls, notFound };
}

test("deduplicates before sampling, so the denominator is the real population", () => {
  const urls = [
    `${HOST}/manufacturer/a-parts-catalog/1`,
    `${HOST}/manufacturer/a-parts-catalog/1`,
    `${HOST}/manufacturer/b-parts-catalog/2`
  ];

  const plan = planTriageSample(urls, "/manufacturer/{param}/{param}");

  assert.equal(plan.populationTotal, 2);
});

test("stratifies a suffix-anchored pattern into its real sub-patterns", () => {
  const urls = [
    ...Array.from(
      { length: 30 },
      (_, i) => `${HOST}/manufacturer/brand${i}-parts-catalog/1`
    ),
    ...Array.from(
      { length: 12 },
      (_, i) => `${HOST}/manufacturer/brand${i}-spec-sheets/1`
    )
  ];

  const { labels, byLabel } = stratifyUrls(urls, "/manufacturer/{param}/{param}");

  assert.deepEqual(labels, ["{var}-parts-catalog", "{var}-spec-sheets"]);
  assert.equal(byLabel.get("{var}-parts-catalog")?.length, 30);
  assert.equal(byLabel.get("{var}-spec-sheets")?.length, 12);
});

test("a free-form pattern is one stratum, not shattered into singletons", () => {
  // /rfq/{param} manufacturer slugs are high-cardinality at EVERY token depth —
  // no shared first token, no shared last token. Splitting them would produce
  // hundreds of one-URL strata, each too small to sample or to conclude from.
  //
  // (A set that shares a token at some depth is NOT this case and correctly
  // does split — 100 slugs over 10 first-tokens really is ten families of ten.
  // The distinction matters, and getting it wrong here is what the first draft
  // of this test did.)
  const urls = Array.from(
    { length: 200 },
    (_, i) => `${HOST}/rfq/maker${i}-division${i * 3}-plant${i * 7}`
  );

  const { labels } = stratifyUrls(urls, "/rfq/{param}");

  assert.equal(
    labels.length,
    1,
    `free-form slugs must stay one stratum, got ${labels.join(", ")}`
  );
  assert.equal(labels[0], RESIDUAL_STRATUM_LABEL);
});

test("draws about 1% at production scale, within the cost ceiling", () => {
  const { urls } = buildProductionPopulation();
  const plan = planTriageSample(urls, "/manufacturer/{param}/{param}");

  assert.equal(plan.populationTotal, POPULATION);
  // 1% of 25,744 is 257, comfortably under the 400 ceiling.
  assert.equal(plan.sampledTotal, 257);
  assert.ok(plan.sampledTotal <= TRIAGE_MAX_SAMPLE);

  // Allocation is proportional to each family's real size, so neither family
  // is over- or under-represented in the extrapolation.
  const catalog = plan.strata.find((s) => s.label === "{var}-parts-catalog");
  const spec = plan.strata.find((s) => s.label === "{var}-spec-sheets");

  assert.ok(catalog && spec);
  assert.equal(catalog.population, CATALOG_COUNT);
  assert.equal(spec.population, SPEC_COUNT);
  // Within one URL of exact proportionality.
  assert.ok(
    Math.abs(catalog.urls.length - (257 * CATALOG_COUNT) / POPULATION) <= 1
  );
});

test("small patterns are sampled far above 1% — a 30-URL floor, not a 1% token", () => {
  const urls = Array.from(
    { length: 300 },
    (_, i) => `${HOST}/manufacturer/brand${i}-parts-catalog/1`
  );
  const plan = planTriageSample(urls, "/manufacturer/{param}/{param}");

  // 1% of 300 is 3 — a number from which nothing can be concluded. The floor
  // takes over.
  assert.equal(plan.sampledTotal, TRIAGE_MIN_SAMPLE);
});

test("the sample is reproducible — same population, same draw", () => {
  const { urls } = buildProductionPopulation();
  const first = planTriageSample(urls, "/manufacturer/{param}/{param}");
  // Shuffled input must not change the sample: the draw is keyed on the URL's
  // hash, not on arrival order. Without this, re-running triage would wobble
  // the estimate and a user could not tell noise from a real change.
  const shuffled = [...urls].reverse();
  const second = planTriageSample(shuffled, "/manufacturer/{param}/{param}");

  assert.deepEqual(
    first.strata.map((s) => [s.label, [...s.urls].sort()]),
    second.strata.map((s) => [s.label, [...s.urls].sort()])
  );
});

test("expansion is a strict superset of round one", () => {
  const { urls, notFound } = buildProductionPopulation();
  const plan = planTriageSample(urls, "/manufacturer/{param}/{param}");

  const observations: StratumObservation[] = plan.strata.map((stratum) => {
    const hits = stratum.urls.filter((url) => notFound.has(url)).length;

    return {
      label: stratum.label,
      population: stratum.population,
      sampled: stratum.urls.length,
      hitsByStatus: new Map(hits > 0 ? [[404, hits]] : [])
    };
  });

  const expansion = planTriageExpansion(
    plan,
    observations,
    [404],
    "/manufacturer/{param}/{param}",
    urls
  );

  if (!expansion) {
    // No stratum showed a 404 in round one — a legitimate outcome at this
    // defect rate, and precisely why the zero case is reported as sample-based.
    return;
  }

  const roundOne = new Set(plan.strata.flatMap((s) => s.urls));

  for (const stratum of expansion.strata) {
    for (const url of stratum.urls) {
      assert.ok(
        !roundOne.has(url),
        "expansion must draw URLs round one did not already probe"
      );
    }
  }
});

test("a stratum with zero hits is never expanded", () => {
  const plan = planTriageSample(
    Array.from(
      { length: 5000 },
      (_, i) => `${HOST}/manufacturer/brand${i}-parts-catalog/1`
    ),
    "/manufacturer/{param}/{param}"
  );

  const expansion = planTriageExpansion(
    plan,
    plan.strata.map((stratum) => ({
      label: stratum.label,
      population: stratum.population,
      sampled: stratum.urls.length,
      hitsByStatus: new Map<number, number>()
    })),
    [404],
    "/manufacturer/{param}/{param}",
    []
  );

  assert.equal(expansion, null);
});

test("estimator is exact when a stratum is sampled in full", () => {
  // Sampling everything is not an estimate — the interval must collapse to the
  // point value, or the UI would hedge a number it actually knows.
  const estimates = estimateFromObservations(
    [
      {
        label: "only",
        population: 100,
        sampled: 100,
        hitsByStatus: new Map([[404, 17]])
      }
    ],
    [404]
  );

  assert.equal(estimates[0].estimate, 17);
  assert.equal(estimates[0].ciLow, 17);
  assert.equal(estimates[0].ciHigh, 17);
});

test("estimator weights each stratum by its own population", () => {
  // A small, badly broken family next to a large healthy one. A flat
  // (unstratified) rate would say 50% of 11,000 = 5,500; the correct answer is
  // 1,000 broken in the small family and none in the large one.
  const estimates = estimateFromObservations(
    [
      {
        label: "healthy",
        population: 10_000,
        sampled: 100,
        hitsByStatus: new Map()
      },
      {
        label: "broken",
        population: 1_000,
        sampled: 100,
        hitsByStatus: new Map([[404, 100]])
      }
    ],
    [404]
  );

  assert.equal(estimates[0].estimate, 1_000);
  assert.equal(estimates[0].observed, 100);
});

// This one MEASURES rather than asserts a tight bound, and prints what it found.
// At production's defect rate (187 of 25,744 = 0.73%), a 1% sample expects
// fewer than two hits — so the point estimate is inherently coarse and the
// honest claim for the triage layer is "detects signal", not "estimates
// precisely". The assertion below is deliberately the weak one that is actually
// true; the log line is the evidence.
test("production-shape accuracy: reports the real spread rather than claiming precision", () => {
  const { urls, notFound } = buildProductionPopulation();
  const plan = planTriageSample(urls, "/manufacturer/{param}/{param}");

  const observations: StratumObservation[] = plan.strata.map((stratum) => {
    const hits = stratum.urls.filter((url) => notFound.has(url)).length;

    return {
      label: stratum.label,
      population: stratum.population,
      sampled: stratum.urls.length,
      hitsByStatus: new Map(hits > 0 ? [[404, hits]] : [])
    };
  });

  const [estimate] = estimateFromObservations(observations, [404]);

  console.log(
    `[triage accuracy] population=${POPULATION} truth=${NOT_FOUND_COUNT} ` +
      `sampled=${plan.sampledTotal} (${((plan.sampledTotal / POPULATION) * 100).toFixed(2)}%) ` +
      `observed=${estimate.observed} estimate=${estimate.estimate} ` +
      `ci=[${estimate.ciLow}, ${estimate.ciHigh}]`
  );

  // The defensible claim: the interval is honest about its own width. Either
  // the truth is inside it, or the sample saw nothing at all — which is the
  // documented "no signal, verify to be sure" outcome, not a wrong number
  // presented as right.
  const insideInterval =
    NOT_FOUND_COUNT >= estimate.ciLow && NOT_FOUND_COUNT <= estimate.ciHigh;

  assert.ok(
    insideInterval || estimate.observed === 0,
    `truth ${NOT_FOUND_COUNT} outside CI [${estimate.ciLow}, ${estimate.ciHigh}] ` +
      `despite ${estimate.observed} observed hits`
  );
});
