import {
  scanPatternFiles,
  type PatternScanTarget
} from "../sitemaps/patternFileScan.js";
import {
  mergeDryRunPartials,
  TransformDryRun,
  type DryRunPartial,
  type DryRunTotals
} from "../sitemaps/transformDryRun.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";
import { parseStructure } from "../sitemaps/transformStructure.js";
import {
  urlMatchesStructureFilters,
  type ResolvedStructureFilter
} from "../sitemaps/structureClusters.js";
import {
  DRY_RUN_PARALLEL_THRESHOLD,
  runDryRunScanJob
} from "./dryRunScanPool.js";

// Measure a transform over a pattern's whole population, inline for small
// patterns and across a worker pool for large ones.
//
// The two paths differ ONLY in where the per-URL work happens. Both build the
// same TransformDryRun from the same structure strings, and both end in
// mergeDryRunPartials — a single-file inline scan merges a list of one. That is
// what makes "the parallel answer equals the serial answer" a property of the
// shape of this code rather than a coincidence to be re-checked by hand.

export type DryRunScanResult = {
  totals: DryRunTotals;
  filesScanned: number;
  filesSkipped: number;
  // Reported so the job's log line says which path ran; a parallel scan that
  // silently fell back to inline is otherwise invisible.
  parallel: boolean;
};

export type DryRunScanOptions = {
  targets: PatternScanTarget[];
  currentStructure: string;
  newStructure: string;
  template: string;
  structureFilters: ResolvedStructureFilter[];
  // patterns.total_urls — what the path choice is made on. See
  // DRY_RUN_PARALLEL_THRESHOLD for why this and not the file count.
  totalUrls: number;
  onFileDone?: (done: number) => void | Promise<void>;
};

async function scanInline(
  options: DryRunScanOptions
): Promise<DryRunScanResult> {
  const dryRun = new TransformDryRun({
    current: parseStructure(options.currentStructure),
    next: parseStructure(options.newStructure),
    matchesPattern: (url, pathname) =>
      pathMatchesTemplate(pathname, options.template) &&
      urlMatchesStructureFilters(url, options.structureFilters)
  });
  const scan = await scanPatternFiles({
    targets: options.targets,
    visit: (url) => dryRun.observe(url),
    onFileDone: options.onFileDone
  });

  return {
    totals: mergeDryRunPartials([dryRun.partial()]),
    filesScanned: scan.filesScanned,
    filesSkipped: scan.filesSkipped,
    parallel: false
  };
}

async function scanPooled(
  options: DryRunScanOptions
): Promise<DryRunScanResult> {
  const partials: DryRunPartial[] = [];
  let done = 0;
  let skipped = 0;

  // ONE TASK PER FILE, not one task per fixed-size chunk of files. Piscina holds
  // them in a queue and hands the next one to whichever thread is free, so a
  // thread that draws a 200-URL file immediately picks up another instead of
  // idling while a neighbour grinds through 500,000. Sitemap files in one
  // session routinely differ by two orders of magnitude in size, so a chunked
  // split would spend most of its time waiting on its unluckiest chunk.
  //
  // The pool is fixed-size (DRY_RUN_MAX_WORKERS), so submitting 823 tasks starts
  // 4 threads, not 823.
  await Promise.all(
    options.targets.map(async (target) => {
      try {
        const result = await runDryRunScanJob({
          inputPath: target.inputPath,
          isGzip: target.isGzip,
          currentStructure: options.currentStructure,
          newStructure: options.newStructure,
          template: options.template,
          structureFilters: options.structureFilters
        });

        partials.push(result.partial);

        if (result.failed) {
          skipped += 1;
        }
      } catch {
        // A thread that died outright, rather than a file it could not read.
        // Counted the same way: the measurement is short by this file and says
        // so, instead of failing entirely.
        skipped += 1;
      }

      done += 1;
      await options.onFileDone?.(done);
    })
  );

  return {
    totals: mergeDryRunPartials(partials),
    filesScanned: done - skipped,
    filesSkipped: skipped,
    parallel: true
  };
}

export function scanTransformDryRun(
  options: DryRunScanOptions
): Promise<DryRunScanResult> {
  // One file cannot be split across threads, so a single-file pattern gains
  // nothing from the pool however many URLs it holds.
  const worthParallelising =
    options.targets.length > 1 &&
    options.totalUrls >= DRY_RUN_PARALLEL_THRESHOLD;

  return worthParallelising ? scanPooled(options) : scanInline(options);
}
