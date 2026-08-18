import { createWriteStream } from "node:fs";
import { once } from "node:events";

import { streamSitemapUrlLocs } from "../sitemaps/parser.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";

// piscina worker: scan ONE sitemap file for the URLs belonging to a set of
// patterns, and write the matches to a provisional file on disk.
//
// WHY THE MATCHES GO TO DISK AND NOT BACK OVER IPC.
//
// This is the same shape as the Cleaner's Pass 2 (cleanerParseWorker), and it is
// deliberately copied rather than reinvented, because the obvious version of
// this worker is the one that was already measured and REJECTED there: returning
// the URL strings from the thread made the parallel path SLOWER than sequential,
// since every match pays a structured-clone across the thread boundary. A
// pattern verification enumerates against files holding tens of millions of
// <loc> values, so that cost is paid at exactly the scale where it hurts most.
//
// What crosses the boundary here is a path and a count. The main thread reads
// the provisional files back in strict file order, which is also what keeps the
// result identical to the sequential scan — "first matching template wins" and
// "first file to claim a URL owns it" both depend on order.
//
// The expensive part — parsing every <loc> in the file and testing it against
// the templates — happens here, and only the tiny matching subset is written.

export type PatternPopulationInput = {
  // STORED name of the sitemap file, as held in sitemap_files.filename —
  // resolved against config.uploadDir by streamSitemapUrlLocs, exactly as the
  // sequential enumerator passes it. Not an absolute path: handing this an
  // absolute one silently looks for it *inside* the upload dir.
  storedFilename: string;
  // Where to write the matches for this file.
  provisionalPath: string;
  // The patterns being enumerated, in the caller's priority order.
  patterns: Array<{ id: string; template: string }>;
};

export type PatternPopulationResult = {
  provisionalPath: string;
  count: number;
};

export default async function scan(
  input: PatternPopulationInput
): Promise<PatternPopulationResult> {
  const out = createWriteStream(input.provisionalPath);
  let count = 0;

  await streamSitemapUrlLocs(input.storedFilename, (loc) => {
    let pathname: string;

    try {
      pathname = new URL(loc).pathname;
    } catch {
      // Not a parseable absolute URL — it can't be probed or matched.
      return;
    }

    // First matching pattern wins, matching the sequential enumerator exactly.
    const matched = input.patterns.find((pattern) =>
      pathMatchesTemplate(pathname, pattern.template)
    );

    if (!matched) {
      return;
    }

    // "<patternId>\t<loc>". A <loc> cannot contain a tab or a newline — it comes
    // out of the XML parser as the text of one element, and a URL carrying
    // either would not be a URL — so this needs no escaping and the reader can
    // split on the first tab.
    out.write(`${matched.id}\t${loc}\n`);
    count += 1;
  });

  out.end();
  // Wait for the file to be fully flushed before reporting it. The main thread
  // reads this path immediately on resolve, and a partially written provisional
  // file would silently shrink the population.
  await once(out, "finish");

  return { provisionalPath: input.provisionalPath, count };
}
