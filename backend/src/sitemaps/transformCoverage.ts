import {
  captureStructureValues,
  transformUrl,
  type ParsedStructure
} from "./transformStructure.js";

// Server-side half of the transform coverage gate (v1.68). Mirrors the intent of
// frontend/lib/transform-coverage.ts, NOT its bytes: the client measures to warn
// as the user types, this refuses to apply. Both must agree about what "the rule
// did not apply" means, which is why the rule is stated once, here and there, in
// the same three cases.
//
// THE REPORTED BUG. One by-example pair — nsn-parts-10004 becoming
// /nsn/nsn-parts/page-1-4/ — inferred {A|nsn-parts-1000|page-1-|}, a `replace`
// needle carrying the example's own digits. Two of the previewed URLs
// transformed; the rest kept their value verbatim and still received the new
// `nsn-parts/` segment, producing /nsn/nsn-parts/nsn-parts-10062/. The client
// warns about it, and a warning the server does not enforce is decoration: the
// backend re-infers and applies independently, so a client that skips the
// warning (or an API caller that never saw it) would write the mangled rewrite.
//
// NOT IN resolveTransformRequest, deliberately, even though that is where the
// apply/dry-run/sample-file validation is shared. Refusing to MEASURE a rule is
// self-defeating — the dry run and the sample file are how a user discovers the
// rule is bad. Inspection stays open; only the write is gated.

export type CoverageVerdict = {
  matched: number;
  transformed: number;
  untransformed: number;
  example: string | null;
  // False when the new structure asks no value to change (a pure re-parent), in
  // which case there is nothing to measure and nothing to refuse.
  expectsValueChange: boolean;
};

// Half. See the frontend copy for the reasoning, including why a pool-size
// relative threshold would let the identical broken rule through on a small
// pattern.
export const LOW_COVERAGE_RATIO = 0.5;

function expectsValueChange(next: ParsedStructure): boolean {
  return next.segments.some(
    (rule) => rule.type === "param" && rule.transform.kind !== "none"
  );
}

export function measureTransformCoverage(
  urls: string[],
  current: ParsedStructure,
  next: ParsedStructure
): CoverageVerdict {
  const verdict: CoverageVerdict = {
    matched: 0,
    transformed: 0,
    untransformed: 0,
    example: null,
    expectsValueChange: expectsValueChange(next)
  };

  if (!verdict.expectsValueChange) {
    return verdict;
  }

  const paramPositions = next.segments
    .map((rule, index) => ({ rule, index }))
    .filter(
      (entry): entry is { rule: { type: "param" } & typeof entry.rule; index: number } =>
        entry.rule.type === "param"
    )
    .filter((entry) => entry.rule.transform.kind !== "none");

  for (const rawUrl of urls) {
    const values = captureStructureValues(rawUrl, current);

    // Not this pattern's shape — not evidence about the rule either way.
    if (!values) {
      continue;
    }

    verdict.matched += 1;

    const rewritten = transformUrl(rawUrl, current, next);

    if (rewritten === null) {
      verdict.untransformed += 1;
      verdict.example = verdict.example ?? rawUrl;
      continue;
    }

    let outSegments: string[];

    try {
      outSegments = new URL(rewritten).pathname.split("/").filter(Boolean);
    } catch {
      verdict.matched -= 1;
      continue;
    }

    const changed = paramPositions.some(
      (entry) => outSegments[entry.index] !== values.get(entry.rule.name)
    );

    if (changed) {
      verdict.transformed += 1;
      continue;
    }

    verdict.untransformed += 1;
    verdict.example = verdict.example ?? rewritten;
  }

  return verdict;
}

export function isLowCoverage(verdict: CoverageVerdict): boolean {
  if (!verdict.expectsValueChange || verdict.untransformed === 0) {
    return false;
  }

  if (verdict.matched === 0) {
    return false;
  }

  return verdict.transformed / verdict.matched < LOW_COVERAGE_RATIO;
}

export function lowCoverageMessage(verdict: CoverageVerdict): string {
  return (
    `this rule only transforms ${verdict.transformed} of the ${verdict.matched} ` +
    `sampled URLs it matches — the other ${verdict.untransformed} would keep ` +
    `their current value under the new path` +
    (verdict.example ? ` (e.g. ${verdict.example})` : "") +
    ". Adjust the new structure, or send force_low_coverage: true to apply it anyway."
  );
}
