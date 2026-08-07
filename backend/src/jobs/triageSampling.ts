import {
  clusterParamValues,
  segmentMatchesAnchor,
  type StructureAnchor
} from "../sitemaps/structureClusters.js";

// The triage sampling pipeline: decide WHICH URLs to probe for a fast,
// approximate read on a pattern, before anyone commits to checking all of them.
//
//   URL population -> deduplicate -> stratify by URL sub-pattern
//     -> hash-based ~1% draw within each stratum -> (probe, rate limited)
//     -> adaptive expansion where the sample looks anomalous -> estimate
//
// Everything here is PURE and synchronous — no network, no database — so the
// part that is genuinely easy to get wrong (allocation across strata, the
// estimator, the expansion trigger) is testable without a client web server on
// the other end. triageJob.ts owns the I/O.
//
// WHY HASH-BASED rather than a random draw. The sample must be REPRODUCIBLE:
// re-running triage on an unchanged pattern has to return the same estimate,
// otherwise a user watching the number wobble between runs cannot tell sampling
// noise from a real change on the client's site. A stable hash of the URL gives
// a fixed pseudo-random permutation, so "the first k by hash" is a random draw
// that is the same random draw every time. It also makes expansion coherent:
// widening the sample re-uses the same ordering, so round two is a superset of
// round one and the two never disagree about a URL.
//
// WHY STRATIFY. A pattern's URLs are not homogeneous — that is the entire
// premise of Issue 1's structure detection. On the real nsnstocks data,
// /nsn/{param} holds four families (niin-parts-{var}, part-types-{var}, …) that
// behave DIFFERENTLY: one family had been re-laid-out and 404s wholesale while
// the others were fine. A flat 1% sample of the pattern can miss a small
// broken family entirely, or hit it twice and extrapolate its breakage across
// the whole pattern. Sampling each family separately and weighting by its real
// size fixes both, and it is what makes the per-sub-pattern breakdown in the UI
// truthful rather than decorative.

export const TRIAGE_SAMPLE_RATE = 0.01;
// Statistical floor. Below ~30 observations a proportion estimate carries a
// confidence interval so wide it says nothing, so small patterns get sampled at
// far more than 1% — correctly. Clamped to the population when smaller.
export const TRIAGE_MIN_SAMPLE = 30;
// Cost ceiling for the first round: 400 probes at 25 req/s is ~16 seconds.
export const TRIAGE_MAX_SAMPLE = 400;
// Every stratum worth reporting gets at least this many probes, so a small
// sub-pattern is never described from one or two observations.
export const TRIAGE_MIN_PER_STRATUM = 5;
// Ceiling INCLUDING an adaptive expansion: ~1200 probes is ~48 seconds. Past
// this, triage stops being the cheap option and the user should just run the
// full verification.
export const TRIAGE_MAX_EXPANDED_SAMPLE = 1200;
// An expansion may add at most this multiple of the first-round sample.
//
// Without it, "how much room is left under the 1200 cap" is the only limit, and
// on a small pattern that means expanding to the ENTIRE population — caught by
// the integration test, which saw a 200-URL pattern triaged at 200/200. A
// triage that probes everything is not a triage; it is a full verification
// wearing the wrong label, reporting an estimate for a number it now knows
// exactly.
export const TRIAGE_MAX_EXPANSION_FACTOR = 3;
// …and regardless of the above, triage never touches more than this fraction of
// the population. Past roughly a quarter, the honest advice is to run the full
// check and get an exact answer rather than pay most of the cost for an
// estimate.
export const TRIAGE_MAX_POPULATION_FRACTION = 0.25;
// A stratum whose observed hit rate for a target status is at or above this is
// treated as anomalous and re-sampled harder, to tighten the interval where the
// problem actually is.
export const TRIAGE_EXPANSION_HIT_RATE = 0.1;
// …as is any stratum that showed ANY hit on a sample this thin, where one
// observation swings the estimate wildly.
export const TRIAGE_EXPANSION_MIN_CONFIDENT_SAMPLE = 20;

export const RESIDUAL_STRATUM_LABEL = "{param} (other)";

export type TriageStratumPlan = {
  label: string;
  // Deduplicated population of this sub-pattern. The estimator's weight.
  population: number;
  // The URLs to probe, already drawn.
  urls: string[];
};

export type TriagePlan = {
  populationTotal: number;
  sampledTotal: number;
  strata: TriageStratumPlan[];
};

export type TriageOptions = {
  sampleRate?: number;
  minSample?: number;
  maxSample?: number;
  minPerStratum?: number;
};

// FNV-1a, 32-bit. A stable, dependency-free, well-distributed string hash. Not
// cryptographic and does not need to be — it is here to permute, not to hide.
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // hash * 16777619, in 32-bit arithmetic without overflowing to a double.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}

function templateSegments(template: string): string[] {
  const trimmed = template.trim();
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  return path === "" ? [] : path.split("/").filter(Boolean);
}

type Stratification = {
  // Ordered stratum labels, largest first; the residual bucket last.
  labels: string[];
  byLabel: Map<string, string[]>;
};

// Choose ONE {param} slot to stratify on and bucket every URL by it.
//
// Only one slot, deliberately: crossing two slots multiplies the strata and
// shrinks each one below the point where its sample says anything. The slot
// picked is the one whose clustering is most discriminating (most real
// clusters), which is the slot that actually separates the pattern's families.
// A pattern with no literal anchor anywhere (e.g. /rfq/{param}/{param}, all
// free-form) correctly yields a single stratum, and the estimator degrades to
// plain proportion estimation — which is the right answer for a homogeneous
// population.
export function stratifyUrls(
  urls: string[],
  template: string
): Stratification {
  const segments = templateSegments(template);
  const paramIndexes: number[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "{param}") {
      paramIndexes.push(index);
    }
  }

  let best: {
    segmentIndex: number;
    clusters: ReturnType<typeof clusterParamValues>;
  } | null = null;

  for (const segmentIndex of paramIndexes) {
    const values: string[] = [];

    for (const url of urls) {
      const parts = pathSegments(url);

      if (parts && parts.length === segments.length && parts[segmentIndex]) {
        values.push(parts[segmentIndex]);
      }
    }

    if (values.length === 0) {
      continue;
    }

    const clusters = clusterParamValues(values);
    const anchored = clusters.filter((cluster) => cluster.anchor !== null).length;

    if (!best || anchored > best.clusters.filter((c) => c.anchor !== null).length) {
      best = { segmentIndex, clusters };
    }
  }

  const byLabel = new Map<string, string[]>();

  if (!best || best.clusters.filter((cluster) => cluster.anchor !== null).length === 0) {
    byLabel.set(RESIDUAL_STRATUM_LABEL, [...urls]);

    return { labels: [RESIDUAL_STRATUM_LABEL], byLabel };
  }

  const anchored: Array<{ label: string; anchor: StructureAnchor }> = best.clusters
    .filter(
      (cluster): cluster is typeof cluster & { anchor: StructureAnchor } =>
        cluster.anchor !== null
    )
    .map((cluster) => ({ label: cluster.label, anchor: cluster.anchor }));

  for (const url of urls) {
    const parts = pathSegments(url);
    const value =
      parts && parts.length === segments.length
        ? parts[best.segmentIndex]
        : undefined;
    // First matching anchor wins — the same one-URL-one-bucket rule the rest of
    // the pipeline uses. Anything unmatched (or unparseable) falls to residual
    // rather than being dropped: the population total must stay honest.
    const matched = value
      ? anchored.find((entry) =>
          segmentMatchesAnchor(value, entry.anchor.direction, entry.anchor.value)
        )
      : undefined;
    const label = matched?.label ?? RESIDUAL_STRATUM_LABEL;
    const bucket = byLabel.get(label);

    if (bucket) {
      bucket.push(url);
    } else {
      byLabel.set(label, [url]);
    }
  }

  const labels = Array.from(byLabel.keys()).sort((a, b) => {
    if (a === RESIDUAL_STRATUM_LABEL) {
      return 1;
    }

    if (b === RESIDUAL_STRATUM_LABEL) {
      return -1;
    }

    return (byLabel.get(b)?.length ?? 0) - (byLabel.get(a)?.length ?? 0);
  });

  return { labels, byLabel };
}

// Spread a total sample budget across strata: proportional to population, with
// a floor per stratum so small sub-patterns are still described, then trimmed
// back to the budget from the largest allocations so the floors survive.
function allocate(
  populations: number[],
  budget: number,
  minPerStratum: number
): number[] {
  const total = populations.reduce((sum, value) => sum + value, 0);

  if (total === 0) {
    return populations.map(() => 0);
  }

  const allocation = populations.map((population) =>
    Math.min(
      population,
      Math.max(
        Math.min(minPerStratum, population),
        Math.round((population / total) * budget)
      )
    )
  );

  let assigned = allocation.reduce((sum, value) => sum + value, 0);

  // Over budget: take from the largest allocations first, never below the
  // per-stratum floor.
  while (assigned > budget) {
    let bestIndex = -1;
    let bestValue = -1;

    for (let index = 0; index < allocation.length; index += 1) {
      const floor = Math.min(minPerStratum, populations[index]);

      if (allocation[index] > floor && allocation[index] > bestValue) {
        bestValue = allocation[index];
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      // Everything is at its floor; the floors themselves exceed the budget,
      // which is the correct outcome — describing every stratum matters more
      // than hitting an arbitrary total.
      break;
    }

    allocation[bestIndex] -= 1;
    assigned -= 1;
  }

  // Under budget with room left: give the remainder to the strata that can
  // absorb it, largest population first.
  const order = populations
    .map((population, index) => ({ population, index }))
    .sort((a, b) => b.population - a.population);

  let cursor = 0;

  while (assigned < budget && cursor < order.length * 1000) {
    const entry = order[cursor % order.length];

    if (allocation[entry.index] < populations[entry.index]) {
      allocation[entry.index] += 1;
      assigned += 1;
    } else if (
      order.every((item) => allocation[item.index] >= populations[item.index])
    ) {
      break;
    }

    cursor += 1;
  }

  return allocation;
}

// Deterministic pseudo-random ordering: sort by hash, tie-broken by the URL so
// two URLs that collide still order stably.
function byHash(urls: string[]): string[] {
  return [...urls].sort((a, b) => {
    const diff = stableHash(a) - stableHash(b);

    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
}

// Build the first-round triage sample.
export function planTriageSample(
  rawUrls: string[],
  template: string,
  options: TriageOptions = {}
): TriagePlan {
  const sampleRate = options.sampleRate ?? TRIAGE_SAMPLE_RATE;
  const minSample = options.minSample ?? TRIAGE_MIN_SAMPLE;
  const maxSample = options.maxSample ?? TRIAGE_MAX_SAMPLE;
  const minPerStratum = options.minPerStratum ?? TRIAGE_MIN_PER_STRATUM;

  // Deduplicate on the exact URL string — the same key verified_urls is unique
  // on, so triage's denominator and verification's denominator agree.
  const urls = Array.from(new Set(rawUrls));
  const populationTotal = urls.length;

  if (populationTotal === 0) {
    return { populationTotal: 0, sampledTotal: 0, strata: [] };
  }

  const budget = Math.min(
    populationTotal,
    Math.max(Math.min(minSample, populationTotal), Math.min(maxSample, Math.round(populationTotal * sampleRate)))
  );

  const { labels, byLabel } = stratifyUrls(urls, template);
  const populations = labels.map((label) => byLabel.get(label)?.length ?? 0);
  const allocation = allocate(populations, budget, minPerStratum);

  const strata: TriageStratumPlan[] = labels.map((label, index) => ({
    label,
    population: populations[index],
    urls: byHash(byLabel.get(label) ?? []).slice(0, allocation[index])
  }));

  return {
    populationTotal,
    sampledTotal: strata.reduce((sum, stratum) => sum + stratum.urls.length, 0),
    strata
  };
}

export type StratumObservation = {
  label: string;
  population: number;
  sampled: number;
  // Observed count per HTTP status within this stratum's sample.
  hitsByStatus: Map<number, number>;
};

// Decide where to look harder after round one, and draw the extra URLs.
//
// Two triggers, both about the ESTIMATE being untrustworthy rather than the
// result being bad news:
//   * a hit rate at or above TRIAGE_EXPANSION_HIT_RATE — a real problem, worth
//     narrowing the interval before quoting a number;
//   * any hit at all on a sample thinner than
//     TRIAGE_EXPANSION_MIN_CONFIDENT_SAMPLE — one observation out of eight
//     extrapolates to a wildly wide range, so the number would be close to
//     meaningless as printed.
//
// A stratum with ZERO hits is deliberately NOT expanded: zero is the cheap,
// useful signal this layer exists to deliver ("no sign of 404s here"), and it
// is reported as sample-based rather than treated as proof.
export function planTriageExpansion(
  plan: TriagePlan,
  observations: StratumObservation[],
  targetStatuses: number[],
  template: string,
  allUrls: string[],
  options: { maxExpandedSample?: number } = {}
): TriagePlan | null {
  const maxExpanded = options.maxExpandedSample ?? TRIAGE_MAX_EXPANDED_SAMPLE;
  // Three independent ceilings, all of which must hold: the absolute cost cap,
  // a bound relative to what round one already cost, and a bound relative to
  // the population so triage can never quietly become a full verification.
  const remaining = Math.min(
    maxExpanded - plan.sampledTotal,
    TRIAGE_MAX_EXPANSION_FACTOR * plan.sampledTotal,
    Math.floor(plan.populationTotal * TRIAGE_MAX_POPULATION_FRACTION) -
      plan.sampledTotal
  );

  if (remaining <= 0) {
    return null;
  }

  const anomalous = observations.filter((observation) => {
    if (observation.sampled === 0) {
      return false;
    }

    const hits = targetStatuses.reduce(
      (sum, status) => sum + (observation.hitsByStatus.get(status) ?? 0),
      0
    );

    if (hits === 0) {
      return false;
    }

    return (
      hits / observation.sampled >= TRIAGE_EXPANSION_HIT_RATE ||
      observation.sampled < TRIAGE_EXPANSION_MIN_CONFIDENT_SAMPLE
    );
  });

  if (anomalous.length === 0) {
    return null;
  }

  const urls = Array.from(new Set(allUrls));
  const { byLabel } = stratifyUrls(urls, template);
  const alreadySampled = new Map(
    plan.strata.map((stratum) => [stratum.label, new Set(stratum.urls)])
  );

  // Room is split across the anomalous strata in proportion to how much of each
  // is still unsampled, so expansion goes where there is actually more to learn.
  const headroom = anomalous.map((observation) =>
    Math.max(0, observation.population - observation.sampled)
  );
  const extra = allocate(headroom, Math.min(remaining, headroom.reduce((a, b) => a + b, 0)), 0);

  const strata: TriageStratumPlan[] = [];
  let added = 0;

  for (let index = 0; index < anomalous.length; index += 1) {
    const observation = anomalous[index];
    const seen = alreadySampled.get(observation.label) ?? new Set<string>();
    // Same hash ordering as round one, so the extra draw is the CONTINUATION of
    // the same permutation — round two is a strict superset of round one.
    const additional = byHash(byLabel.get(observation.label) ?? [])
      .filter((url) => !seen.has(url))
      .slice(0, extra[index]);

    if (additional.length === 0) {
      continue;
    }

    added += additional.length;
    strata.push({
      label: observation.label,
      population: observation.population,
      urls: additional
    });
  }

  if (added === 0) {
    return null;
  }

  return {
    populationTotal: plan.populationTotal,
    sampledTotal: added,
    strata
  };
}

export type StatusEstimate = {
  httpStatus: number;
  // Observed count in the sample.
  observed: number;
  // Stratified extrapolation to the full population, rounded.
  estimate: number;
  // 95% interval on that extrapolation, rounded and clamped to [0, population].
  ciLow: number;
  ciHigh: number;
};

// Stratified proportion estimate with a 95% interval.
//
// estimate = Σ N_h · p_h  over strata, so a small broken family contributes its
// own real weight instead of being averaged into the pattern.
//
// Variance uses the finite-population correction (1 − n_h/N_h): when a stratum
// is sampled in full the term goes to zero, which is right — that part of the
// count is not an estimate at all, it is known. The interval is what lets the
// UI say "~340" honestly rather than implying three-digit precision from a
// 257-URL sample.
export function estimateFromObservations(
  observations: StratumObservation[],
  statuses: number[]
): StatusEstimate[] {
  const populationTotal = observations.reduce(
    (sum, observation) => sum + observation.population,
    0
  );

  return statuses.map((status) => {
    let estimate = 0;
    let variance = 0;
    let observed = 0;

    for (const observation of observations) {
      const hits = observation.hitsByStatus.get(status) ?? 0;

      observed += hits;

      if (observation.sampled === 0 || observation.population === 0) {
        continue;
      }

      const proportion = hits / observation.sampled;

      estimate += observation.population * proportion;

      const fpc = Math.max(
        0,
        1 - observation.sampled / observation.population
      );
      // n−1 denominator (the unbiased sample variance); with a single
      // observation there is no spread to measure, so the term is dropped
      // rather than divided by zero — the interval is then driven by the other
      // strata, and the caller still sees sampled=1 in the breakdown.
      const denominator = observation.sampled - 1;

      if (denominator > 0) {
        variance +=
          observation.population *
          observation.population *
          fpc *
          ((proportion * (1 - proportion)) / denominator);
      }
    }

    const halfWidth = 1.96 * Math.sqrt(variance);

    return {
      httpStatus: status,
      observed,
      estimate: Math.round(estimate),
      ciLow: Math.max(0, Math.round(estimate - halfWidth)),
      ciHigh: Math.min(populationTotal, Math.round(estimate + halfWidth))
    };
  });
}
