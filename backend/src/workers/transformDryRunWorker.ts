import {
  TransformDryRun,
  type DryRunPartial
} from "../sitemaps/transformDryRun.js";
import { scanSitemapLocs } from "../sitemaps/rewriteLocs.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";
import { parseStructure } from "../sitemaps/transformStructure.js";
import {
  urlMatchesStructureFilters,
  type ResolvedStructureFilter
} from "../sitemaps/structureClusters.js";

// piscina worker: streams ONE sitemap file and reports what a structure
// transform WOULD do to it, off the worker PROCESS's main thread.
//
// WHY THIS EXISTS AT ALL. The dry run started life as a read-only loop on the
// main thread. Reading files concurrently did not help: the file reads overlap
// happily, but the per-URL work behind them — a URL parse, transformUrl's
// segment walk, the result shape — is JavaScript, and JavaScript runs on one
// thread. Measured, the scan spent 2.7s of 12.5s actually reading and the rest
// waiting on itself. The apply had already been through exactly this and solved
// it with jobs/fileRewritePool.ts; this is the same solution for the read side.
//
// Like fileRewriteWorker, the spec that crosses the thread edge is plain
// structured-clone-friendly data: the RAW structure strings rather than parsed
// objects (parseStructure is cheap and deterministic, closures are not
// transferable) and FULLY RESOLVED structure filters (path-segment indexes, not
// param ordinals) so no template parsing happens here.
//
// It does NO database access and writes NOTHING. It returns a DryRunPartial,
// which the caller merges — see mergeDryRunPartials for why the merge, and not
// this file, is where collisions across files are found.

export type TransformDryRunInput = {
  inputPath: string;
  isGzip: boolean;
  currentStructure: string;
  newStructure: string;
  // The pattern's template, for the "is this URL in scope at all" test.
  template: string;
  structureFilters: ResolvedStructureFilter[];
};

export type TransformDryRunOutput = {
  partial: DryRunPartial;
  // A file that could not be read is reported, not thrown: one missing file must
  // not lose the measurement of every other file, which is the same choice the
  // occurrence breakdown makes.
  failed: boolean;
};

export default async function transformDryRunTask(
  input: TransformDryRunInput
): Promise<TransformDryRunOutput> {
  const current = parseStructure(input.currentStructure);
  const next = parseStructure(input.newStructure);
  const dryRun = new TransformDryRun({
    current,
    next,
    matchesPattern: (url, pathname) =>
      pathMatchesTemplate(pathname, input.template) &&
      urlMatchesStructureFilters(url, input.structureFilters)
  });

  let failed = false;

  try {
    await scanSitemapLocs({
      inputPath: input.inputPath,
      isGzip: input.isGzip,
      visit: (url) => dryRun.observe(url)
    });
  } catch {
    failed = true;
  }

  return { partial: dryRun.partial(), failed };
}
