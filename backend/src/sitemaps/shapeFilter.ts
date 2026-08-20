import { valueShape } from "./transformDryRun.js";
import type { LocUrlRewriter } from "./rewriteLocs.js";

// Scope a rewrite to chosen URL SHAPES.
//
// WHY THIS EXISTS. The Update Pattern modal's by-example inference produced a
// rule that transformed 2 of 996 URLs, because a pattern like /nsn/{param}
// mixes several value shapes — nsn-parts-12191, nsn-parts-6492, page-1-34 — and
// one literal rule cannot serve all of them. The v1.68 coverage gate refuses
// such a rule, but refusing is only half an answer: the user still needs to say
// WHICH URLs the rule is for. The dry run already groups the population by
// shape, so the answer is a checkbox per shape.
//
// WHY NOT REGEX, which is what was asked for. valueShape is already a canonical
// form — digit runs to 9xlength, letter runs to a, separators kept — so
// membership is exact string equality on that form. Generating
// ^[A-Za-z]+-[A-Za-z]+-\d{5}$ from "a-a-99999" and matching it would be more
// machinery for less safety: a generated regex still has to be compiled, still
// has to be escaped correctly, and still invites a hand-edited pattern that
// backtracks over millions of URLs. Equality cannot do any of that. The SEO team
// also never has to see or write a pattern, which was the actual requirement.
//
// The structure filter (v1.66) is a DIFFERENT dimension and both can apply at
// once: that one is token-boundary prefix/suffix matching ("only nsn-parts-*"),
// this one is value shape ("only the 5-digit ones"). Neither can express the
// other.

// Shapes cross the piscina thread edge as plain strings, so no resolution step
// is needed — unlike ResolvedStructureFilter, which carries segment indexes
// derived from a template.
export type ShapeFilter = string[];

// Does this URL's path shape appear in the selection? An EMPTY selection means
// unscoped and matches everything, matching applyStructureFilterToRewriter's
// convention — "[] is unscoped, not scoped-to-nothing" is relied on by every
// caller that passes a filter list through unconditionally.
export function urlMatchesShapeFilter(
  rawUrl: string,
  shapes: ShapeFilter
): boolean {
  if (shapes.length === 0) {
    return true;
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  return shapes.includes(valueShape(url.pathname));
}

// AND the shape guard into an existing rewriter: URLs outside the selected
// shapes pass through byte-for-byte (null), exactly like template non-matches
// and out-of-scope structures already do.
export function applyShapeFilterToRewriter(
  rewriter: LocUrlRewriter,
  shapes: ShapeFilter | null
): LocUrlRewriter {
  const selected = shapes ?? [];

  if (selected.length === 0) {
    return rewriter;
  }

  // Set for the membership test — a pattern can carry up to SHAPE_LIMIT shapes
  // and this runs once per <loc> over populations in the millions.
  const set = new Set(selected);

  return (url: string) => {
    let pathname: string;

    try {
      pathname = new URL(url).pathname;
    } catch {
      return null;
    }

    return set.has(valueShape(pathname)) ? rewriter(url) : null;
  };
}

// Parse the wire form. Returns null for anything malformed so the route can 400
// rather than silently narrowing (or widening) an edit — the same all-or-nothing
// posture parseStructureFilters takes.
export function parseShapeFilter(raw: unknown): ShapeFilter | null {
  if (raw === null || raw === undefined) {
    return [];
  }

  if (!Array.isArray(raw)) {
    return null;
  }

  const shapes: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      return null;
    }

    // Bounded: a shape is a normalised path, and anything much longer than a
    // real one is a hand-crafted body rather than a selection from the UI.
    if (entry.length > 512) {
      return null;
    }

    shapes.push(entry);
  }

  return shapes;
}
