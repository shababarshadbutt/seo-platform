import { deriveRedirectRule, type RedirectRule } from "../sitemaps/redirectRule.js";
import { valueShape } from "../sitemaps/transformDryRun.js";

// Split a population into URL SHAPES, decide how many of each to probe, and
// distil a rule per shape from what came back.
//
// WHY. Verifying a 579,034-URL pattern took 3h17m at 50 req/s, and the rate knob
// only buys a constant factor — above ~1M URLs even 400 req/s exceeds an hour.
// URLs sharing a shape come from one CMS template, so a sample of a shape
// usually answers for the shape. ~50 per shape over six shapes is ~300 probes
// instead of 579,034.
//
// HYBRID, NOT BLIND SAMPLING. A shape whose probed pairs all distil to the same
// rule is trusted and extrapolated. A shape whose pairs DISAGREE is not: it is
// reported as unagreed so the caller can escalate that shape — and only that
// shape — to a full verification. Rigour where the data is messy, minutes where
// it is uniform.
//
// WHY PER-SHAPE RULES EXIST AT ALL. deriveRedirectRule requires every pair to
// produce a byte-identical diff. Applied to a whole pattern that is a global
// constraint, and it is exactly why the reported pattern yielded no rule and
// needed 579,034 probes. Within one shape the constraint only has to hold among
// URLs of the same template, which is why stratifying makes rules derivable at
// all rather than merely faster.
//
// EXTRAPOLATION IS NOT MEASUREMENT. Nothing here may be written to
// verified_urls: v1.68 made apply-redirects treat every row there as a URL that
// was actually fetched, and that distinction is what fixed the
// "button says 28,546, toast says 10" bug. The output of this module is a RULE
// per shape, stored separately (migration 051) and applied as the inference it
// is.

export type ShapeStratum = {
  shape: string;
  // Every URL of this shape, in enumeration order.
  urls: string[];
};

export type ShapeVerdict = {
  shape: string;
  population: number;
  sampleSize: number;
  // Null when the samples disagreed, or when none of them redirected.
  rule: RedirectRule | null;
  agreed: boolean;
};

// Probes per shape. 50 is a deliberate flat count rather than a percentage: a
// shape is a template, so what is being tested is "does this template rewrite
// consistently", and the answer does not get harder to reach because the
// template was used 500,000 times instead of 5,000. A percentage would make the
// big shapes — the ones that cost the hours — the most expensive to clear.
export const DEFAULT_SHAPE_SAMPLE = 50;

export function groupByShape(urls: string[]): ShapeStratum[] {
  const strata = new Map<string, string[]>();

  for (const url of urls) {
    let pathname: string;

    try {
      pathname = new URL(url).pathname;
    } catch {
      // Not probeable and not classifiable; the full path already skips these.
      continue;
    }

    const shape = valueShape(pathname);
    const existing = strata.get(shape);

    if (existing) {
      existing.push(url);
    } else {
      strata.set(shape, [url]);
    }
  }

  return Array.from(strata.entries())
    .map(([shape, shapeUrls]) => ({ shape, urls: shapeUrls }))
    // Biggest first: those are the shapes whose extrapolation saves the most
    // time, so a run that is cut short has already cleared the expensive ones.
    .sort((a, b) => b.urls.length - a.urls.length);
}

// Which URLs to probe for a stratum. EVENLY SPREAD across the stratum rather
// than the first N: enumeration order follows file order, so the first N are
// usually all from one sitemap file and one contiguous id range — precisely the
// slice most likely to behave alike and least likely to expose a shape that is
// not actually uniform.
export function sampleStratum(
  stratum: ShapeStratum,
  sampleSize = DEFAULT_SHAPE_SAMPLE
): string[] {
  if (stratum.urls.length <= sampleSize) {
    return [...stratum.urls];
  }

  const step = stratum.urls.length / sampleSize;
  const picked: string[] = [];

  for (let index = 0; index < sampleSize; index += 1) {
    picked.push(stratum.urls[Math.floor(index * step)]);
  }

  return picked;
}

// Distil the probe results for one shape.
//
// `pairs` carries only the probed URLs that actually redirected. A shape where
// nothing redirected is `agreed: false` with a null rule — there is nothing to
// extrapolate, and calling that agreement would license rewriting the shape on
// no evidence.
export function judgeStratum(
  stratum: ShapeStratum,
  pairs: Array<{ source: string; dest: string }>,
  sampleSize: number
): ShapeVerdict {
  const rule = pairs.length > 0 ? deriveRedirectRule(pairs) : null;

  return {
    shape: stratum.shape,
    population: stratum.urls.length,
    sampleSize,
    rule,
    agreed: rule !== null
  };
}

// The URLs an accept can reach, split into what was MEASURED and what would be
// extrapolated. Drives the label the modal shows, so the two numbers can never
// be summed into one that hides the difference.
export function coverageFromVerdicts(verdicts: ShapeVerdict[]): {
  measured: number;
  extrapolated: number;
  trustedShapes: number;
  unagreedShapes: string[];
} {
  let measured = 0;
  let extrapolated = 0;
  let trustedShapes = 0;
  const unagreedShapes: string[] = [];

  for (const verdict of verdicts) {
    measured += verdict.sampleSize;

    if (verdict.agreed) {
      trustedShapes += 1;
      // The probed members are already counted as measured, so only the
      // remainder is extrapolation. Clamped at 0 for the case where the whole
      // stratum was small enough to probe end to end — there is nothing left to
      // infer there, and a negative would quietly shrink the total.
      extrapolated += Math.max(0, verdict.population - verdict.sampleSize);
    } else {
      unagreedShapes.push(verdict.shape);
    }
  }

  return { measured, extrapolated, trustedShapes, unagreedShapes };
}
