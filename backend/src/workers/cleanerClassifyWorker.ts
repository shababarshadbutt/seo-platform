import { classifyCleanerFile } from "../sitemaps/cleaner.js";

// piscina worker: classify ONE uploaded sitemap file (Pass 1) off the server
// process's main thread. Streams the file, counts total vs on-domain <loc>s,
// reports validity + root element. No shared state, so many files classify in
// parallel. Returns only tiny fixed-size counts — no URL strings cross the
// thread boundary (that was the reverted v1.44 attempt's bottleneck). Reuses
// the exact classifyCleanerFile() the sequential path calls, so the result is
// identical regardless of thread.

export type CleanerClassifyInput = {
  filename: string;
  path: string;
  domainHost: string;
};

export type CleanerClassifyResult = {
  isValid: boolean;
  rootElement: string | null;
  total: number;
  matching: number;
  // Worker-side parse timing, carried back so the run log can split sax CPU
  // from disk wait. Still fixed-size scalars — no URL strings cross the
  // boundary, which is the constraint the v1.45 redesign was built around.
  saxMs?: number;
  ioWaitMs?: number;
  bytesRead?: number;
};

export default async function classify(
  input: CleanerClassifyInput
): Promise<CleanerClassifyResult> {
  return classifyCleanerFile(
    { filename: input.filename, path: input.path },
    input.domainHost
  );
}
