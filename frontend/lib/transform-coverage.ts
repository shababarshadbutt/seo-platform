import {
  captureStructureValues,
  transformUrl,
  type ParsedStructure
} from "./transform-structure";

// Does the new structure's rule actually generalise, or does it only fit the one
// example it was inferred from?
//
// THE REPORTED BUG. One by-example pair — nsn-parts-10004 becoming
// /nsn/nsn-parts/page-1-4/ — inferred
//
//     /nsn/nsn-parts/{A|nsn-parts-1000|page-1-|}/
//
// whose `replace` needle carries the EXAMPLE'S OWN DIGITS. Two of the ten
// previewed URLs transformed; the other eight kept their value verbatim and
// still received the new `nsn-parts/` segment, producing
// /nsn/nsn-parts/nsn-parts-10062/ — the literal twice over. Nothing was
// malfunctioning: transformUrl applied the rule it was given, and
// inferNewStructure's self-check passed because it only ever validates against
// the single example it came from. Nobody measured whether the chosen reading
// held for anything else.
//
// So this measures it, against the pattern's real URL pool, before the user can
// commit. Pairs with findSegmentDuplication rather than replacing it: that one
// answers "does the new segment repeat text in the value", this one answers "does
// the rule do anything to most values at all". Both were true here; only the
// second explains why the output was wrong.
//
// PUBLIC FUNCTIONS ONLY, deliberately. The obvious implementation reaches for
// applyTransform inside transform-structure.ts, but that module is byte-mirrored
// against the backend copy and policed by the MIRRORED list in its test.
// Widening the mirrored surface for the sake of a warning is not worth the drift
// risk, so the transformed value is read back out of the rewritten path instead.

export type TransformCoverage = {
  // URLs that matched `current` — the only ones a rule can say anything about.
  matched: number;
  // …of those, how many had a param value actually change.
  transformed: number;
  untransformed: number;
  // First few untransformed results, already rewritten, so the warning can quote
  // what the user would actually get.
  examples: string[];
  // Whether `next` asks for any value to change at all. False for a structure
  // that only re-parents segments, and the whole measurement is meaningless
  // then — see shouldWarn.
  expectsValueChange: boolean;
};

const MAX_EXAMPLES = 3;

// A rule is expected to apply to essentially every value of the shape it
// targets, so "most of them silently keep their value" is the defect. Half is
// the line.
//
// WHY NOT SOMETHING TINY LIKE 0.1. The reported case was 2 of 880, which any
// threshold catches — but the same rule against a 7-URL pool is 2 of 7, and 29%
// sails past a 10% bar while still duplicating a segment on five of the seven.
// Tying the gate to how big the pool happens to be would let the identical
// broken rule through on a small pattern. Written after the first draft did
// exactly that and two tests caught it.
//
// THE TRADE-OFF, stated because it is real: a deliberately partial edit — strip
// "-catalog" where only some values carry it — now trips this. Those URLs still
// receive any new static segment while keeping their value, so flagging them is
// defensible, and the override exists for the case where it is genuinely
// intended.
export const LOW_COVERAGE_RATIO = 0.5;

function paramPositions(next: ParsedStructure): Array<{
  index: number;
  name: string;
  // A "none" transform means the value is carried through untouched BY DESIGN,
  // so it must not count as evidence that the rule failed.
  expectsChange: boolean;
}> {
  const positions: Array<{
    index: number;
    name: string;
    expectsChange: boolean;
  }> = [];

  next.segments.forEach((rule, index) => {
    if (rule.type === "param") {
      positions.push({
        index,
        name: rule.name,
        expectsChange: rule.transform.kind !== "none"
      });
    }
  });

  return positions;
}

// The per-URL verdict, exported so the preview's sample ORDERING and these
// counts come from one definition. Two implementations of "did this URL really
// transform?" would eventually disagree, and the disagreement would show up as a
// warning that says five failed above a list showing none of them.
//
//   "no-match"       → the URL is not this pattern's shape; not evidence.
//   "kept-value"     → matched, but no param the rule edits came out different.
//                      This is the duplicated-segment case.
//   "transformed"    → the rule did what it says.
export type TransformOutcome = "no-match" | "kept-value" | "transformed";

export function classifyTransform(
  rawUrl: string,
  current: ParsedStructure,
  next: ParsedStructure
): TransformOutcome {
  const expecting = paramPositions(next).filter(
    (position) => position.expectsChange
  );

  if (expecting.length === 0) {
    // Nothing was asked to change, so nothing can have failed to.
    return "transformed";
  }

  const values = captureStructureValues(rawUrl, current);

  if (!values) {
    return "no-match";
  }

  const rewritten = transformUrl(rawUrl, current, next);

  // null means the result equalled the input — the strongest form of "did not
  // apply".
  if (rewritten === null) {
    return "kept-value";
  }

  let outSegments: string[];

  try {
    outSegments = new URL(rewritten).pathname.split("/").filter(Boolean);
  } catch {
    return "no-match";
  }

  // One is enough: a multi-param structure that edits one value and carries
  // another is working as written.
  return expecting.some(
    (position) => outSegments[position.index] !== values.get(position.name)
  )
    ? "transformed"
    : "kept-value";
}

export function measureTransformCoverage(
  urls: string[],
  current: ParsedStructure,
  next: ParsedStructure
): TransformCoverage {
  const positions = paramPositions(next);
  const expecting = positions.filter((position) => position.expectsChange);
  const coverage: TransformCoverage = {
    matched: 0,
    transformed: 0,
    untransformed: 0,
    examples: [],
    expectsValueChange: expecting.length > 0
  };

  if (expecting.length === 0) {
    return coverage;
  }

  for (const rawUrl of urls) {
    const outcome = classifyTransform(rawUrl, current, next);

    // A URL the rule was never going to match is not a failure of the rule, and
    // must not dilute the ratio in either direction.
    if (outcome === "no-match") {
      continue;
    }

    coverage.matched += 1;

    if (outcome === "transformed") {
      coverage.transformed += 1;
      continue;
    }

    coverage.untransformed += 1;

    if (coverage.examples.length < MAX_EXAMPLES) {
      // The REWRITTEN url where there is one, because the shape the user would
      // end up with (/nsn/nsn-parts/nsn-parts-10062/) is what makes this
      // alarming. Falls back to the input when the transform was a total no-op.
      coverage.examples.push(
        transformUrl(rawUrl, current, next) ?? rawUrl
      );
    }
  }

  return coverage;
}

// Should the modal warn and block on this measurement?
//
// Three conditions, each of which is a false positive on its own:
//   * the rule must ASK for a value change (a pure re-parent legitimately
//     changes none, and blocking that would break a valid, common edit);
//   * something must actually have failed;
//   * and the share that worked must be genuinely small.
export function isLowCoverage(coverage: TransformCoverage): boolean {
  if (!coverage.expectsValueChange || coverage.untransformed === 0) {
    return false;
  }

  if (coverage.matched === 0) {
    return false;
  }

  return coverage.transformed / coverage.matched < LOW_COVERAGE_RATIO;
}
