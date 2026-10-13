import { pathMatchesTemplate, scanSitemapLocs } from "../sitemaps/rewriteLocs.js";
import {
  urlMatchesStructureFilters,
  type ResolvedStructureFilter
} from "../sitemaps/structureClusters.js";

// piscina worker: streams ONE sitemap file and counts how many <loc> entries
// satisfy a structure scope, off the worker PROCESS's main thread.
//
// WHY THIS EXISTS. scopedPatternSourceFileBreakdown (routes/sessions.ts) used to
// run this count inline with only async-I/O concurrency (SCOPED_BREAKDOWN_CONCURRENCY),
// which never gave it real CPU parallelism — the per-URL work (a URL parse,
// pathMatchesTemplate, urlMatchesStructureFilters) is JavaScript, and JavaScript
// runs on one thread. transformDryRunWorker.ts hit and solved this exact problem
// for the transform dry-run scan; this is the same solution applied here.
//
// Like transformDryRunWorker, the spec that crosses the thread edge is plain
// structured-clone-friendly data: FULLY RESOLVED structure filters (path-segment
// indexes, not param ordinals) so no template parsing happens on the caller's
// side per file, just the template string itself (cheap and deterministic to
// re-check here).
//
// It does NO database access and writes NOTHING.

export type SourceFileScanInput = {
  inputPath: string;
  isGzip: boolean;
  template: string;
  resolvedFilters: ResolvedStructureFilter[];
};

export type SourceFileScanOutput = {
  occurrences: number;
  // A file that could not be read is reported, not thrown — one missing file
  // must not lose the count for every other file, matching the inline scan's
  // own try/catch-per-file behaviour (scopedPatternSourceFileBreakdown's
  // `skipped.unreadable`).
  failed: boolean;
};

export default async function sourceFileScanTask(
  input: SourceFileScanInput
): Promise<SourceFileScanOutput> {
  const matchesUrl = (url: string): boolean => {
    let pathname: string;

    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }

    return (
      pathMatchesTemplate(pathname, input.template) &&
      urlMatchesStructureFilters(url, input.resolvedFilters)
    );
  };

  let occurrences = 0;

  try {
    await scanSitemapLocs({
      inputPath: input.inputPath,
      isGzip: input.isGzip,
      visit: (url) => {
        if (matchesUrl(url)) {
          occurrences += 1;
        }
      }
    });
  } catch {
    return { occurrences: 0, failed: true };
  }

  return { occurrences, failed: false };
}
