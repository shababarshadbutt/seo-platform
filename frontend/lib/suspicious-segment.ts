// The Update Pattern modal's "auto-place a strip on the suspicious segment"
// pre-population (v1.41 Feature 1). Extracted from results/page.tsx so the
// guess-or-say-nothing rule below is unit tested rather than only exercised by
// clicking through the modal.

// Which {param} position (0 = A, 1 = B, …) holds the suspicious segment, found
// by scanning sampled URLs' values at each param slot. Returns null when no
// sampled value contains it (e.g. it's a static segment, not inside a param, or
// the pattern's own samples just don't happen to contain it — a pattern's
// "suspicious segment" flag is computed across the wider pattern group, so it
// is not guaranteed to appear in THIS modal's sample set).
export function findSuspiciousPosition(
  template: string,
  suspiciousSegment: string,
  sampledUrls: string[]
): number | null {
  const templateSegments = template.split("/").filter(Boolean);
  const paramPositions = templateSegments
    .map((segment, index) => (segment === "{param}" ? index : -1))
    .filter((index) => index !== -1);

  for (const url of sampledUrls) {
    let urlSegments: string[];

    try {
      urlSegments = new URL(url).pathname.split("/").filter(Boolean);
    } catch {
      continue;
    }

    for (let i = 0; i < paramPositions.length; i += 1) {
      const value = urlSegments[paramPositions[i]] ?? "";

      if (value.includes(suspiciousSegment)) {
        return i;
      }
    }
  }

  return null;
}

// Place a strip expression on the placeholder at `suspiciousPosition`, e.g.
// ("/manufacturer/{A}/{B}/", "parts-catalog", 0) -> "/manufacturer/{A|-parts-catalog|}/{B}/".
function buildNewUrlStructure(
  convertedTemplate: string,
  suspiciousSegment: string,
  suspiciousPosition: number
): string {
  const letter = String.fromCharCode(65 + suspiciousPosition);

  return convertedTemplate.replace(
    `{${letter}}`,
    `{${letter}|-${suspiciousSegment}|}`
  );
}

export type SuspiciousStripSuggestion = {
  newStructure: string;
  note: string;
};

// The modal's single entry point: given the pattern's suspicious segment value
// and its converted (A/B/C) template, either produce a verified strip
// suggestion or produce nothing at all.
//
// Previously, when findSuspiciousPosition returned null (the segment could not
// be pinpointed in any sampled URL), the caller fell back to position 0 anyway
// and applied a strip there — so the modal would auto-fill "New URL structure"
// with e.g. "{A|-nsn|}" and a note reading '"-nsn" ... couldn't pinpoint the
// segment, so edit if this is incorrect' EVEN WHEN "-nsn" does not appear
// anywhere in "A" (or any other segment) of any sampled URL. A suggestion the
// tool itself admits may be wrong, applied anyway, is worse than no suggestion:
// it looks like a real edit was auto-drafted rather than a blind guess. So a
// null detection now means no strip is placed and no note is shown — the New
// URL structure field is left as a plain copy of the current structure, same
// as a pattern with no suspicious segment at all.
export function buildSuspiciousStripSuggestion(
  convertedTemplate: string,
  template: string,
  suspiciousSegment: string,
  sampledUrls: string[]
): SuspiciousStripSuggestion | null {
  const position = findSuspiciousPosition(template, suspiciousSegment, sampledUrls);

  if (position === null) {
    return null;
  }

  const letter = String.fromCharCode(65 + position);

  return {
    newStructure: buildNewUrlStructure(convertedTemplate, suspiciousSegment, position),
    note: `Auto-detected: "-${suspiciousSegment}" appears in segment ${letter}. Edit if this is incorrect.`
  };
}
