import { writeProvisionalOnDomainFile } from "../sitemaps/cleaner.js";

// piscina worker: Pass 2, redesigned (v1.45). Streams ONE kept file, filters to
// on-domain <loc>s, and writes them to a PROVISIONAL file on disk — one
// "<dedupKey>\t<loc>" line per URL, in file order — computing the (expensive)
// dedup key normalization here, off the main thread. Returns only the
// provisional path + count: NO URL strings cross the thread boundary.
//
// The main thread later reads each provisional file back FROM DISK (not via
// IPC), in strict original file order, and applies the cross-file
// "first-occurrence-wins" dedup + writes the final cleaned file. Because the
// key is already computed and the URLs travel via disk rather than
// structured-clone, this avoids the IPC cost that made the v1.44 attempt slower
// than sequential, while keeping the output byte-identical (exact-string dedup,
// no hashing / collision risk).

export type CleanerParseInput = {
  inputPath: string;
  provisionalPath: string;
  isGzip: boolean;
  domainHost: string;
};

export type CleanerParseResult = {
  provisionalPath: string;
  count: number;
  // Worker-side timing, returned so the main thread can attribute the run's
  // cost between sax CPU and disk wait even though the work happened here.
  // These are plain numbers, so they add nothing meaningful to the
  // structured-clone cost the v1.44 design was reverted for.
  saxMs: number;
  ioWaitMs: number;
  bytesRead: number;
  flushMs: number;
};

export default async function parse(
  input: CleanerParseInput
): Promise<CleanerParseResult> {
  const result = await writeProvisionalOnDomainFile(
    input.inputPath,
    input.provisionalPath,
    input.isGzip,
    input.domainHost
  );

  return { provisionalPath: input.provisionalPath, ...result };
}
