// Per-category output filenames for the Sitemap Categorizer tool.
//
// Deliberately NOT built on outputFilenamePattern.ts's renderOutputFilename /
// pickCollisionFreeTemplate: those render a whole batch from ONE user-chosen
// global "{n}" template with collision-driven version renaming. This tool's
// filenames are fully DERIVED (one per category, from categorizer.ts) and
// numbered per category rather than globally, with the first chunk UNSUFFIXED
// rather than "-1" (doc: "aviation-components.xml", then
// "aviation-components-2.xml") — a different enough shape that forcing it
// through the existing template renderer would need a boolean thread through
// collision logic that doesn't apply here (there is nothing for a derived,
// deterministic name to collide with).

export function renderCategoryChunkFilename(
  category: string,
  chunkIndex: number
): string {
  return chunkIndex === 1 ? `${category}.xml` : `${category}-${chunkIndex}.xml`;
}
