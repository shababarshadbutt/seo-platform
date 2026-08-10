import {
  captureStructureValues,
  type ParsedStructure
} from "./transform-structure";

// Warn when a new static segment repeats text that is ALREADY inside an adjacent
// param's real captured value.
//
// THE REPORTED BUG. A pattern /nsn/{param} whose values look like
// "niin-parts-503" gets edited to /nsn/niin-parts/{A}, and the result is
// ".../nsn/niin-parts/niin-parts-503/" — the literal appears twice. The transform
// is doing exactly what it was told; the user just could not see the collision
// until after applying, because the preview showed the rewritten URL without
// remarking on it.
//
// WARN AND SUGGEST — never auto-strip, never block. Preview and Fix stay enabled.
// Auto-stripping would silently rewrite a value the user may have meant to keep
// (a segment that legitimately repeats a token is unusual but not wrong), and
// blocking would turn a heads-up into a dead end of the kind the 0-param error
// already taught us to avoid.
//
// FALSE POSITIVES ARE THE DESIGN CONSTRAINT. A plain substring test fires on any
// edit that happens to share a few characters, and a warning that cries wolf on
// every edit gets ignored — at which point it is worse than nothing. Two rules
// keep it honest:
//
//   1. ANCHORED, not "contains". The captured value must START or END with the
//      static text. That is what "the segment I just added is already the
//      prefix/suffix of this value" means. Mid-string coincidences do not fire.
//      (Same bidirectional-anchor reasoning as sitemaps/structureClusters.ts.)
//   2. MINIMUM LENGTH. Short statics like "a", "of", "v2" collide by chance far
//      too often to be evidence of anything.
const MIN_SEGMENT_LENGTH = 3;

// Characters treated as token separators when extending a strip suggestion to
// swallow the joining character — so "niin-parts" inside "niin-parts-503"
// suggests stripping "niin-parts-" rather than leaving a leading "-503".
const SEPARATORS = new Set(["-", "_", ".", "~"]);

export type SegmentDuplication = {
  // The static segment in the NEW structure, e.g. "niin-parts".
  segmentValue: string;
  // The adjacent param it duplicates into, e.g. "A".
  paramName: string;
  // That param's real captured value, e.g. "niin-parts-503".
  capturedValue: string;
  // Where the static text sits inside the captured value.
  anchor: "prefix" | "suffix";
  // A ready-to-paste replacement for the new structure's param token, e.g.
  // "{A|niin-parts-|}", so the suggestion is actionable rather than advisory.
  suggestedParamToken: string;
};

// Build the strip text: the duplicated literal plus the separator that joins it
// to the rest of the value, so stripping leaves a clean value rather than one
// with a dangling separator.
function stripTextFor(
  segmentValue: string,
  capturedValue: string,
  anchor: "prefix" | "suffix"
): string {
  if (anchor === "prefix") {
    const nextChar = capturedValue.charAt(segmentValue.length);

    return SEPARATORS.has(nextChar) ? `${segmentValue}${nextChar}` : segmentValue;
  }

  const prevChar = capturedValue.charAt(
    capturedValue.length - segmentValue.length - 1
  );

  return SEPARATORS.has(prevChar) ? `${prevChar}${segmentValue}` : segmentValue;
}

// Scan `urls` for the first static/param duplication the new structure would
// produce. Returns null when there is nothing worth warning about.
//
// First match wins rather than collecting all of them: this drives one banner,
// and the fix for one such collision usually resolves the rest (they come from
// the same edit).
export function findSegmentDuplication(
  urls: string[],
  current: ParsedStructure,
  next: ParsedStructure
): SegmentDuplication | null {
  for (const url of urls) {
    const values = captureStructureValues(url, current);

    if (!values) {
      continue;
    }

    for (let index = 0; index < next.segments.length; index += 1) {
      const segment = next.segments[index];

      if (
        segment.type !== "static" ||
        segment.value.length < MIN_SEGMENT_LENGTH
      ) {
        continue;
      }

      // ADJACENT ONLY: the segment immediately before or after. A static two
      // positions away does not sit next to the value it would repeat, so the
      // "duplicated text" reading does not hold there.
      const neighbours = [next.segments[index - 1], next.segments[index + 1]];

      for (const neighbour of neighbours) {
        if (!neighbour || neighbour.type !== "param") {
          continue;
        }

        const capturedValue = values.get(neighbour.name);

        if (!capturedValue || capturedValue === segment.value) {
          // An exact equality is a different situation (the value IS the
          // segment), not a duplication inside a longer value.
          continue;
        }

        const anchor = capturedValue.startsWith(segment.value)
          ? "prefix"
          : capturedValue.endsWith(segment.value)
            ? "suffix"
            : null;

        if (!anchor) {
          continue;
        }

        const stripText = stripTextFor(segment.value, capturedValue, anchor);

        return {
          segmentValue: segment.value,
          paramName: neighbour.name,
          capturedValue,
          anchor,
          suggestedParamToken: `{${neighbour.name}|${stripText}|}`
        };
      }
    }
  }

  return null;
}
