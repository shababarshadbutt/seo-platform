import {
  resolvePatternScanTargets,
  scanPatternFiles
} from "../sitemaps/patternFileScan.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";
import {
  urlMatchesStructureFilters,
  type ResolvedStructureFilter
} from "../sitemaps/structureClusters.js";
import { valueShape } from "../sitemaps/transformDryRun.js";
import { ShapeReservoir } from "./shapeStrata.js";

// Sample a pattern's URLs per SHAPE in one streaming pass, without ever building
// the population.
//
// WHAT THIS REPLACES, and why. Stratified verification was first built on top of
// enumeratePopulation: read EVERY sitemap file in the session, build a Map of the
// whole population, then sample it. Probing dropped to ~1,150 requests and the
// enumeration became nearly the entire wall clock — and below
// POPULATION_PARALLEL_THRESHOLD (8 files) it runs inline on one thread, so a
// "quick shape check" on a 3-file session sat for 15 minutes reading gigabytes in
// order to then look at 1,150 URLs. The reported symptom.
//
// The population never needed to exist. This reads only the files the pattern's
// URLs actually live in (pattern_file_occurrences, via resolvePatternScanTargets,
// which also resolves to the CORRECTED copy of each file rather than a stale
// name), counts each shape as it streams, and keeps a bounded reservoir per
// shape. Memory is O(shapes x sampleSize) — at most 25 x 50 with the existing
// SHAPE_LIMIT — instead of O(population).
//
// Reuses patternFileScan rather than adding a fourth file walker: the per-file
// occurrence breakdown and the transform dry run already stream exactly these
// files at exactly this concurrency, and the comment there is explicit that both
// share it so they cannot drift.

export type ShapeSampleResult = {
  reservoir: ShapeReservoir;
  filesScanned: number;
  filesSkipped: number;
};

export async function sampleShapesForPattern(options: {
  sessionId: string;
  patternId: string;
  sourceRole: string;
  template: string;
  // The v1.66 "Limit this edit to" scope, already resolved. Applied here so a
  // scoped run samples only the structures it will act on.
  structureFilters: ResolvedStructureFilter[];
  sampleSize?: number;
  // Reported with the SAME shape as enumeratePopulation's callback, so the
  // client's existing "Scanning sitemap files: N of M" progress works unchanged.
  onProgress?: (filesDone: number, filesTotal: number) => void;
}): Promise<ShapeSampleResult> {
  const targets = await resolvePatternScanTargets({
    patternId: options.patternId,
    sessionId: options.sessionId,
    sourceRole: options.sourceRole
  });

  // Published before any streaming so the client can switch from an
  // indeterminate spinner to a real bar immediately, matching enumeration.
  options.onProgress?.(0, targets.length);

  const reservoir = new ShapeReservoir({ sampleSize: options.sampleSize });

  const scan = await scanPatternFiles({
    targets,
    visit: (url) => {
      let pathname: string;

      try {
        pathname = new URL(url).pathname;
      } catch {
        // Not probeable and not classifiable.
        return;
      }

      // pattern_file_occurrences says this FILE carries some of the pattern; it
      // says nothing about an individual <loc>, so each one is still matched
      // against the template.
      if (!pathMatchesTemplate(pathname, options.template)) {
        return;
      }

      if (
        options.structureFilters.length > 0 &&
        !urlMatchesStructureFilters(url, options.structureFilters)
      ) {
        return;
      }

      reservoir.offer(valueShape(pathname), url);
    },
    onFileDone: (done) => options.onProgress?.(done, targets.length)
  });

  return {
    reservoir,
    filesScanned: scan.filesScanned,
    filesSkipped: scan.filesSkipped
  };
}
