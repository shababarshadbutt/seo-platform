import type { SkippedShape } from "./api";

// TURNING A SHORTFALL REPORT INTO SOMETHING AN SEO CAN ACT ON (v1.81).
//
// WHY THIS EXISTS. A fix rewrites a URL only when a confirmed destination or an
// AGREED per-shape rule reaches it, so on a wide pattern it routinely lands on a
// fraction of the population. The backend now measures that shortfall and returns
// it grouped by valueShape — "/a/a-a-9999/ x 9,541" — which is exactly right as a
// key and completely useless as a sentence. The operator is looking at a sitemap
// that still contains /nsn/nsn-parts-9558/ and wants to know why THAT URL was not
// touched; the normalised shape identifies nothing.
//
// So every line leads with a real example URL and the number of URLs it stands
// for. The shape itself is deliberately NOT shown: it is an internal key, it
// looks like a typo, and the example already tells the reader which family of
// URLs the line is about.
//
// In lib/ rather than in the JSX because results/page.tsx has no component test
// harness — the same reason fix-accept-count.ts and verify-advice.ts live here.

// Lines to show. More than a handful stops being a summary and starts being a
// report nobody reads standing at a toast; the biggest shapes are the ones worth
// naming, and the backend already sorts them that way.
export const SKIPPED_SHAPE_LINES = 5;

export function skippedShapeLines(
  shapes: SkippedShape[],
  options: { limit?: number; truncated?: boolean } = {}
): string[] {
  const limit = options.limit ?? SKIPPED_SHAPE_LINES;
  const shown = shapes.slice(0, limit);
  const lines = shown.map(
    (entry) =>
      `${entry.count.toLocaleString("en-US")} like ${entry.example}`
  );

  // Two different reasons the list can be incomplete, and they must not be
  // conflated into one vague "…and more":
  //   * more shapes existed than we show HERE (this is a top-5 of what came back);
  //   * more shapes existed than the backend's own histogram could hold.
  // Either way the honest statement is that the list is not exhaustive, and
  // saying so is what stops it being read as "these are the only ones".
  const hiddenHere = shapes.length - shown.length;

  if (hiddenHere > 0) {
    lines.push(
      `…and ${hiddenHere.toLocaleString("en-US")} more URL group${
        hiddenHere === 1 ? "" : "s"
      }`
    );
  } else if (options.truncated) {
    lines.push("…and more URL groups than could be listed");
  }

  return lines;
}

// The headline above those lines. Kept beside them so the count and the list can
// never describe different things.
export function skippedSummary(input: {
  applied: number;
  skipped: number;
  filesEdited?: number | null;
  filesInPattern?: number | null;
}): string {
  const total = input.applied + input.skipped;
  const scope =
    input.filesEdited != null && input.filesInPattern != null
      ? ` across ${input.filesEdited.toLocaleString(
          "en-US"
        )} of ${input.filesInPattern.toLocaleString("en-US")} files`
      : "";

  return `${input.applied.toLocaleString("en-US")} of ${total.toLocaleString(
    "en-US"
  )} URLs in this pattern updated${scope}. ${input.skipped.toLocaleString(
    "en-US"
  )} were left unchanged — no confirmed destination or agreed rewrite rule covers them:`;
}
