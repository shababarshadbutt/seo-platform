import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import { streamUrlsetLocs } from "./parser.js";
import { isSameDomain } from "./domain.js";
import type { CleanerMetrics } from "./cleanerMetrics.js";
import {
  CLEANER_MAX_WORKERS,
  CLEANER_PARALLEL_THRESHOLD,
  runCleanerClassify,
  runCleanerParse
} from "../jobs/cleanerPool.js";

// Sitemap Cleaner — a stateless port of the SEO team's Streamlit script
// (sitemap_dashboard_4.py). Given a set of uploaded XML sitemap files it:
//   1. parses each file (sax, streaming)
//   2. drops files whose URLs mostly belong to another domain, and filters
//      stray foreign URLs out of the files it keeps
//   3. removes duplicate URLs across all files (first occurrence wins)
//   4. drops files left empty after cleaning
//   5. rebuilds a fresh sitemap-index.xml pointing at the survivors
//   6. emits the cleaned files, the index, and a duplicates CSV report
//
// Memory model (v1.38, tightened in v1.52): only URL strings are ever held in
// memory. Files are read one at a time and streamed; a file's kept URLs are
// written straight to disk. The ONLY unbounded structure left is the cross-file
// dedup map (`keptBy`), ~130 bytes per unique URL.
//
// The duplicates report used to be the second, and it was the larger: a map of
// {url, kept_in, also_in[]} per distinct duplicated URL at ~370 bytes each,
// retained for the whole run purely to ship to the browser. A real 1,605-file /
// 4.3 GB / ~35M-URL corpus aborted the API with `FATAL ERROR: Reached heap
// limit` a third of the way through Pass 2. It is now streamed to disk as it is
// found and served from there.
//
// `keptBy` is SHARDED across 32 Maps (see DedupIndex). That is not a memory
// optimisation — a single V8 Map is capped at 2^24 entries, and the same corpus
// hit that cap with `RangeError: Map maximum size exceeded` once it had enough
// heap to get that far. Sharding puts the ceiling back under the control of
// --max-old-space-size, which can be tuned; the 2^24 constant cannot.
//
// Concurrency model (v1.45): on large file sets both passes run across a
// piscina worker pool.
//   - Pass 1 (classify) has no shared state → runs unordered; workers return
//     only tiny per-file counts.
//   - Pass 2 workers stream their file, filter to on-domain locs, and write a
//     PROVISIONAL "<dedupKey>\t<loc>" file to disk (computing the expensive key
//     normalization off the main thread), returning only a path + count. The
//     main thread then reads those provisional files back FROM DISK, strictly
//     in original file order, and applies the cross-file "first-occurrence
//     wins" dedup + writes the final files. No URL strings cross the worker
//     boundary (that structured-clone cost sank the reverted v1.44 attempt),
//     and the dedup uses exact strings, so the output is byte-identical to the
//     sequential run regardless of the order the workers finish in.

export type DropReason = "empty" | "wrong_domain" | "unparsable";

// An uploaded sitemap, already spilled to a temp file on disk by the route.
export interface CleanerInputFile {
  filename: string;
  path: string;
  /**
   * Name to write into out/ and the ZIP, when it must differ from `filename`.
   *
   * Two selected files can share a base name — one `sitemap.xml` per
   * subdirectory is the norm in folder uploads. Without this the second write
   * silently truncates the first, the rebuilt index lists the same <loc> twice,
   * and the duplicates report says `kept_in: "sitemap.xml"` without saying
   * which. The batched route assigns a deduplicated name in canonical order
   * (see cleanerRunFiles.assignOutputNames); omitted, behaviour is unchanged.
   */
  outputName?: string;
}

/** The name a file is written and reported under. */
export function outputNameOf(file: CleanerInputFile): string {
  return file.outputName ?? file.filename;
}

export interface CleanerResult {
  files_processed: number;
  files_kept: number;
  files_dropped: number;
  dropped_files: { filename: string; reason: DropReason }[];
  duplicates_removed: number;
  // NOTE: there is deliberately no `duplicate_urls` array here.
  //
  // It was a second complete in-memory copy of the duplicates report, built
  // solely so the browser could rebuild a CSV this module had ALREADY written to
  // disk. Two failure modes, both hit in production: it was the largest single
  // consumer of the heap on a big corpus (~370 bytes per distinct duplicated
  // URL), and JSON.stringify of the `done` frame hit V8's ~512 MB string cap at
  // roughly 3-4M rows — a RangeError that publishFrame silently swallowed,
  // leaving the SSE stream open with no `done` and no `error`.
  //
  // The rows live in exactly one place now: REPORT_FILENAME on disk, served by
  // GET /api/cleaner/report/:token. `duplicates_removed` counts occurrences and
  // matches the CSV's row count, which is all the UI needs to decide whether the
  // report is worth offering.
  output_files: { filename: string; url_count: number }[];
  // Uploaded <sitemapindex> files are excluded from cleaning and replaced by a
  // freshly rebuilt index; surfaced separately so the count stays honest.
  index_files_detected: number;
  // ---- URL-count-level stats (match the reference Streamlit report) ----
  // Sum, across every surviving/kept file, of its on-domain URL count BEFORE
  // cross-file dedup ("Total URLs (kept files)").
  total_urls_kept_files: number;
  // Sum of output_files[].url_count — the deduped URLs actually written
  // ("Clean URLs remaining"). In the common case (no file emptied by dedup)
  // total_urls_kept_files - clean_urls_remaining === duplicates_removed.
  clean_urls_remaining: number;
  // duplicates_removed / total_urls_kept_files * 100 ("Reduction %").
  reduction_pct: number;
}

// A generated output file, referenced by its on-disk path rather than its
// content, so the route can stream it into the ZIP / handoff without ever
// holding the bytes in memory.
export interface CleanerOutputFile {
  filename: string;
  path: string;
}

export interface CleanerOutput {
  result: CleanerResult;
  files: CleanerOutputFile[];
}

// Every stage a run can announce. The route contributes upload/unzip/start/
// cleanup/zip; the engine contributes the rest.
//
// Widening this (v1.50) is a PREREQUISITE FOR TRUSTWORTHY TIMING, not just
// nicer UI: StageTimer attributes elapsed time to whichever stage was last
// announced, so a phase that announces nothing has its cost silently charged
// to its predecessor. `select` and `report` exist here because those two loops
// were previously invisible in both the UI and the numbers.
export type CleanerStage =
  | "upload"
  | "unzip"
  | "start"
  | "parse"
  | "select"
  | "dedup"
  | "output"
  | "index"
  | "report"
  | "cleanup"
  | "zip";

export type CleanerProgress = (event: {
  stage: CleanerStage;
  message: string;
  current?: number;
  total?: number;
}) => void;

export const INDEX_FILENAME = "sitemap-index.xml";
export const REPORT_FILENAME = "duplicates-report.csv";

const URLSET_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
const URLSET_FOOTER = "</urlset>\n";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function csvField(value: string) {
  // Quote when the value contains a delimiter, quote, or newline; double any
  // embedded quotes (RFC 4180).
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function isGzipName(filename: string) {
  return filename.toLowerCase().endsWith(".gz");
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Canonical form used for cross-file dedup: lowercase scheme + host, drop query
// and fragment, strip a single trailing slash. Path case is preserved (URL
// paths are case-sensitive). Falls back to the raw lowercased string for values
// that don't parse as URLs so they still dedup against themselves.
export function normalizeForDedup(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";

    let pathname = parsed.pathname;

    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

// One <url> block, byte-identical to the pre-v1.38 buildUrlsetXml join: every
// surviving <url> gets a fresh <lastmod> of today (after <loc>).
function urlEntry(loc: string, today: string) {
  return `  <url>\n    <loc>${escapeXml(
    loc
  )}</loc>\n    <lastmod>${today}</lastmod>\n  </url>\n`;
}

function buildIndexXml(
  domain: string,
  subfolder: string,
  filenames: string[],
  today: string
) {
  const base = domain.replace(/\/+$/, "");
  const sub = subfolder.replace(/^\/+|\/+$/g, "");

  const entries = filenames
    .map((filename) => {
      const loc = sub ? `${base}/${sub}/${filename}` : `${base}/${filename}`;

      return `  <sitemap>\n    <loc>${escapeXml(
        loc
      )}</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

// Await a writable stream fully flushing and closing. Rejects on any stream
// error so a disk-full / permission failure surfaces instead of hanging.
function finishStream(stream: import("node:fs").WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });
}

// ---- Worker-safe primitives (imported by the piscina workers) -----------

export type CleanerClassification = {
  isValid: boolean;
  rootElement: string | null;
  total: number;
  matching: number;
  // Timing carried back from the (possibly off-thread) parse, so the run-level
  // log can separate sax CPU from disk wait even though the work happened in a
  // piscina worker. Optional so the ordering test's fixtures stay valid.
  saxMs?: number;
  ioWaitMs?: number;
  bytesRead?: number;
};

// Fold one parse's timing into the run metrics under a pass prefix. Kept in one
// place so pass 1 and pass 2 report identically-named fields.
export function recordParseTiming(
  metrics: CleanerMetrics | undefined,
  pass: "pass1" | "pass2",
  timing: { saxMs?: number; ioWaitMs?: number; bytesRead?: number }
) {
  if (!metrics) {
    return;
  }

  metrics.add(`${pass}.sax_ms`, timing.saxMs ?? 0);
  metrics.add(`${pass}.io_wait_ms`, timing.ioWaitMs ?? 0);
  metrics.inc(`${pass}.bytes_read`, timing.bytesRead ?? 0);
}

// Pass 1 core: stream a file and count total vs on-domain <loc>s + report
// validity / root element. No shared state.
export async function classifyCleanerFile(
  file: CleanerInputFile,
  domainHost: string
): Promise<CleanerClassification> {
  let total = 0;
  let matching = 0;

  const parsed = await streamUrlsetLocs(
    createReadStream(file.path),
    isGzipName(file.filename),
    (loc) => {
      total += 1;
      const host = hostOf(loc);

      if (host !== null && isSameDomain(host, domainHost)) {
        matching += 1;
      }
    }
  );

  return {
    isValid: parsed.isValid,
    rootElement: parsed.rootElement,
    total,
    matching,
    saxMs: parsed.saxMs,
    ioWaitMs: parsed.ioWaitMs,
    bytesRead: parsed.bytesRead
  };
}

// Pass 2 core (worker side): stream a kept file, keep only on-domain locs, and
// write "<dedupKey>\t<loc>" lines to a provisional file in file order — the
// expensive key normalization happens here, off the main thread. Returns the
// count of on-domain locs written. The provisional file is the ONLY thing that
// crosses to the main thread (via disk, not IPC).
export type ProvisionalWriteResult = {
  count: number;
  saxMs: number;
  ioWaitMs: number;
  bytesRead: number;
  /** Time closing the provisional write stream — a pure metadata/flush cost. */
  flushMs: number;
};

export async function writeProvisionalOnDomainFile(
  inputPath: string,
  provisionalPath: string,
  isGzip: boolean,
  domainHost: string
): Promise<ProvisionalWriteResult> {
  const out = createWriteStream(provisionalPath);
  let count = 0;

  const parsed = await streamUrlsetLocs(createReadStream(inputPath), isGzip, (loc) => {
    const host = hostOf(loc);

    if (host === null || !isSameDomain(host, domainHost)) {
      return;
    }

    out.write(`${normalizeForDedup(loc)}\t${loc}\n`);
    count += 1;
  });

  // Timed separately from the parse: the provisional hop's real cost is
  // metadata operations (create + flush + later open/read/unlink), not bytes,
  // and lumping the flush into "write" would hide that.
  const flushStartedAt = process.hrtime.bigint();

  await finishStream(out);

  return {
    count,
    saxMs: parsed.saxMs,
    ioWaitMs: parsed.ioWaitMs,
    bytesRead: parsed.bytesRead,
    flushMs: Number(process.hrtime.bigint() - flushStartedAt) / 1e6
  };
}

// ---- Cross-file dedup: the single source of truth -----------------------

// V8's hard maximum for a SINGLE Map is 2^24 entries.
//
// MEASURED on a real 1,605-file / 4.3 GB corpus: with a 4 GB heap the process
// OOM-aborted first (uncatchable — no error frame, the UI just froze); given
// 12 GB it reached this cap instead and threw `RangeError: Map maximum size
// exceeded`. No --max-old-space-size lifts it, because it is a count limit, not
// a memory limit.
const V8_MAX_MAP_ENTRIES = 16_777_216;

// So the dedup index is SHARDED across several Maps. Each shard is an ordinary
// Map well under the cap, and the ceiling becomes heap-bound again rather than
// count-bound.
//
// Correctness rests on one property, which must survive any edit here:
// `dedupShardOf` is pure in the KEY, so every occurrence of a URL lands in the
// same shard. Sharding therefore loses no comparison a single Map would have
// made, and because URLs are still fed in canonical (candidateIndex, ordinal)
// order, the first sighting seen inside a shard IS the globally first sighting.
// The hash only decides which Map a key is filed into — comparison inside a
// shard is still exact-string, so a hash collision costs nothing but a slightly
// fuller shard. Output is byte-identical, which cleaner.test.ts pins.
const DEDUP_SHARDS = 32;

// Total capacity before anything is at risk. 32 x 2^24 is ~537M unique URLs, far
// beyond what the heap allows first — which is the point: the binding limit goes
// back to being memory, which can be tuned, instead of a constant that cannot.
export const MAX_DEDUP_ENTRIES = DEDUP_SHARDS * V8_MAX_MAP_ENTRIES;

// djb2-xor. Not used for equality, only for placement.
function dedupShardOf(key: string): number {
  let hash = 5381;

  for (let i = 0; i < key.length; i += 1) {
    hash = (((hash << 5) + hash) ^ key.charCodeAt(i)) | 0;
  }

  return (hash >>> 0) % DEDUP_SHARDS;
}

/** The sharded cross-file dedup index. Behaves as one Map<string, string>. */
export class DedupIndex {
  private readonly shards: Map<string, string>[] = Array.from(
    { length: DEDUP_SHARDS },
    () => new Map<string, string>()
  );

  private count = 0;

  get size(): number {
    return this.count;
  }

  get(key: string): string | undefined {
    return this.shards[dedupShardOf(key)].get(key);
  }

  /** Insert if absent. Returns the existing value, or null when it was new. */
  claim(key: string, filename: string): string | null {
    const shard = this.shards[dedupShardOf(key)];
    const existing = shard.get(key);

    if (existing !== undefined) {
      return existing;
    }

    if (shard.size >= V8_MAX_MAP_ENTRIES) {
      throw new CleanerCapacityError(this.count);
    }

    shard.set(key, filename);
    this.count += 1;

    return null;
  }
}

/**
 * The corpus has more unique URLs than one Map can hold.
 *
 * Distinct from an out-of-memory abort, and much better behaved: this is a
 * normal throwable, so the run fails with a message instead of taking the API
 * process — and every other run on it — down.
 */
export class CleanerCapacityError extends Error {
  constructor(readonly uniqueUrls: number) {
    super(
      `This file set has more than ${uniqueUrls.toLocaleString()} unique URLs, which is the maximum a single cleaning run can deduplicate ` +
        `(a JavaScript Map is capped at 16,777,216 entries — raising the server's memory does NOT lift this). ` +
        `Split the sitemaps into smaller batches and clean them separately.`
    );
    this.name = "CleanerCapacityError";
  }
}

/** Receives one CSV row per duplicate occurrence, as it is found. */
export type DuplicateReportSink = (row: {
  url: string;
  kept_in: string;
  duplicate_in: string;
}) => void;

export type DedupState = {
  keptBy: DedupIndex; // normalized URL -> kept-in filename, sharded
  duplicatesRemoved: number;
  /**
   * Where duplicate rows go. Streaming rather than accumulating is the point.
   *
   * There USED to be a `dupReport: Map<string, {url, kept_in, also_in[]}>` here,
   * retained for the whole run alongside `keptBy`. It was the larger of the two
   * by far — roughly 370 bytes per distinct duplicated URL (the object, a second
   * copy of the raw loc, and a 16-slot backing array for `also_in`) against
   * ~130 bytes for a `keptBy` entry. On a 35M-URL corpus that was multiple GB,
   * and it existed only so the finished result could carry a `duplicate_urls`
   * array to the browser — so the browser could rebuild the CSV this module had
   * already written to disk.
   *
   * It killed the API. A real 1,605-file / 4.3 GB run aborted the process with
   * `FATAL ERROR: Reached heap limit` about a third of the way through Pass 2,
   * which is uncatchable, so no error frame was ever sent and the UI simply
   * froze. The rows now exist in exactly one place: the CSV on disk, served by
   * GET /api/cleaner/report/:token.
   */
  report: DuplicateReportSink;
};

export function createDedupState(report: DuplicateReportSink): DedupState {
  return { keptBy: new DedupIndex(), duplicatesRemoved: 0, report };
}

// Decide ONE on-domain loc against the running cross-file dedup state
// (first-occurrence-across-files wins), given its precomputed dedup `key`.
// Returns true when this loc is the first sighting and should be written; false
// when it's a duplicate (streamed to the report). Mutates `state`. This is
// deliberately the only implementation of the dedup rule so the sequential and
// parallel Pass-2 paths are byte-identical (both use normalizeForDedup — inline
// on the sequential path, in the worker on the parallel path).
export function considerLoc(
  state: DedupState,
  loc: string,
  key: string,
  filename: string
): boolean {
  // One lookup+insert instead of has/get/set: `claim` returns null when the key
  // was new, or the filename that already owns it.
  const keptIn = state.keptBy.claim(key, filename);

  if (keptIn === null) {
    return true;
  }

  state.duplicatesRemoved += 1;
  // One row per OCCURRENCE. The old grouped form needed `also_in.includes()`
  // before every append — a linear scan that went quadratic for a URL appearing
  // in thousands of files — and could not be written until the whole run had
  // finished, which is precisely why it had to be held in memory.
  state.report({ url: loc, kept_in: keptIn, duplicate_in: filename });

  return false;
}

type SurvivorFile = {
  filename: string;
  url_count: number;
  path: string;
  onDomainCount: number;
};

// Write one candidate's cleaned output: header, one <url> per kept loc, footer.
// The on-domain (loc, key) pairs are supplied by `produce` via `emit`, which
// runs each through the shared dedup decision. A file with nothing kept is
// removed and reported empty. Identical for the sequential and parallel paths.
async function writeCandidateFile(
  file: CleanerInputFile,
  outDir: string,
  today: string,
  state: DedupState,
  produce: (emit: (loc: string, key: string) => void) => void | Promise<unknown>
): Promise<{ kept: boolean; url_count: number; path: string }> {
  const outPath = path.join(outDir, outputNameOf(file));
  const out = createWriteStream(outPath);
  out.write(URLSET_HEADER);
  let keptCount = 0;

  const emit = (loc: string, key: string) => {
    if (considerLoc(state, loc, key, outputNameOf(file))) {
      out.write(urlEntry(loc, today));
      keptCount += 1;
    }
  };

  await produce(emit);

  if (keptCount === 0) {
    await finishStream(out);
    await unlink(outPath).catch(() => undefined);

    return { kept: false, url_count: 0, path: outPath };
  }

  out.write(URLSET_FOOTER);
  await finishStream(out);

  return { kept: true, url_count: keptCount, path: outPath };
}

// Read a provisional "<key>\t<loc>" file line by line, calling onPair in order.
function readProvisionalPairs(
  provisionalPath: string,
  onPair: (loc: string, key: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(provisionalPath),
      crlfDelay: Infinity
    });

    // A throw out of a readline "line" listener does NOT reject this promise —
    // it escapes as an uncaughtException and takes the whole API process down.
    // Measured: a corpus with more than 2^24 unique URLs makes `considerLoc`
    // throw `RangeError: Map maximum size exceeded` from in here, and the
    // service died with it, killing every other in-flight run. Converting the
    // throw into a rejection is what turns "the backend vanished" into "this run
    // failed, with a reason".
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      rl.close();
      reject(error);
    };

    rl.on("line", (line) => {
      if (settled || !line) {
        return;
      }

      const tab = line.indexOf("\t");

      if (tab < 0) {
        return;
      }

      try {
        onPair(line.slice(tab + 1), line.slice(0, tab));
      } catch (error) {
        fail(error);
      }
    });
    rl.on("close", () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    rl.on("error", fail);
  });
}

// Run `task` for indices [0, count) with at most `concurrency` in flight;
// results are written back by index (order-independent). Used by Pass 1.
async function runBoundedByIndex<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;

  const runner = async () => {
    for (;;) {
      const index = next;
      next += 1;

      if (index >= count) {
        return;
      }

      results[index] = await task(index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, () => runner())
  );

  return results;
}

// ---- Pass 2 parallel engine (exported for the ordering test) ------------

// Apply the cross-file dedup + write across `candidates` while each candidate's
// provisional file is produced (in workers) concurrently, up to `concurrency`
// in flight. CRITICAL: provisional files are CONSUMED strictly in original
// candidate order — one that finishes early is buffered until its turn — so the
// dedup state and written bytes are identical to a sequential run no matter the
// completion order. `loadProvisional` is injectable so the test can drive it
// with out-of-order-completing mocks.
export async function writeCandidatesParallel(options: {
  candidates: { file: CleanerInputFile; onDomainCount: number }[];
  concurrency: number;
  today: string;
  outDir: string;
  state: DedupState;
  survivors: SurvivorFile[];
  dropped: { filename: string; reason: DropReason }[];
  loadProvisional: (
    candidate: { file: CleanerInputFile; onDomainCount: number },
    index: number
  ) => Promise<string>;
  onProgress?: CleanerProgress;
  cleanupProvisional?: boolean;
  metrics?: CleanerMetrics;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    candidates,
    today,
    outDir,
    state,
    survivors,
    dropped,
    loadProvisional,
    onProgress,
    cleanupProvisional = true,
    metrics,
    signal
  } = options;
  const window = Math.max(1, options.concurrency);
  const inFlight = new Map<number, Promise<string>>();
  // Total on-domain URLs across all candidates is known from Pass 1, so the
  // dedup stage can report a real denominator instead of a bare spinner.
  const totalOnDomain = candidates.reduce((sum, c) => sum + c.onDomainCount, 0);
  let urlsSeen = 0;
  let lastDedupEmit = 0;

  const dispatch = (index: number) => {
    if (index < candidates.length) {
      inFlight.set(index, loadProvisional(candidates[index], index));
    }
  };

  for (let k = 0; k < Math.min(window, candidates.length); k += 1) {
    dispatch(k);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    signal?.throwIfAborted();

    const { file, onDomainCount } = candidates[i];

    // THE diagnostic number for this whole release. Time the main thread spends
    // blocked here is time the 4-thread pool could not keep ahead of it:
    //   ~0    -> workers are fine; the main-thread merge (provisional read +
    //            dedup + final write) is the bottleneck.
    //   large -> the pool is the bottleneck and CLEANER_MAX_WORKERS is the lever.
    // Without this you cannot tell those two apart, and they have opposite fixes.
    const endWait = metrics?.start("pass2.worker_wait_ms");
    const provisionalPath = await (inFlight.get(i) as Promise<string>);
    endWait?.();

    inFlight.delete(i);
    dispatch(i + window);

    onProgress?.({
      stage: "output",
      current: i + 1,
      total: candidates.length,
      message: `Cleaning ${file.filename} (${i + 1} of ${candidates.length})`
    });

    const endCandidate = metrics?.start("pass2.candidate_ms");
    let readMs = 0;
    const result = await writeCandidateFile(file, outDir, today, state, async (emit) => {
      const endRead = metrics?.start("pass2.read_provisional_ms");

      await readProvisionalPairs(provisionalPath, (loc, key) => {
        emit(loc, key);
        urlsSeen += 1;
      });

      readMs = endRead?.() ?? 0;
    });
    const candidateMs = endCandidate?.() ?? 0;

    // Everything in the candidate that was NOT reading the provisional back:
    // the dedup Map work plus the final XML write. Splitting these is what
    // decides whether the provisional hop is worth removing.
    metrics?.add("pass2.dedup_and_write_ms", Math.max(0, candidateMs - readMs));

    // Throttled so a multi-million-URL run does not emit a frame per URL.
    const nowMs = Date.now();

    if (totalOnDomain > 0 && nowMs - lastDedupEmit >= 250) {
      lastDedupEmit = nowMs;
      onProgress?.({
        stage: "dedup",
        current: Math.min(urlsSeen, totalOnDomain),
        total: totalOnDomain,
        message: `Deduplicated ${urlsSeen} of ${totalOnDomain} URLs`
      });
    }

    if (cleanupProvisional) {
      const endUnlink = metrics?.start("pass2.unlink_provisional_ms");

      await unlink(provisionalPath).catch(() => undefined);
      endUnlink?.();
    }

    if (result.kept) {
      survivors.push({
        filename: outputNameOf(file),
        url_count: result.url_count,
        path: result.path,
        onDomainCount
      });
    } else {
      dropped.push({ filename: outputNameOf(file), reason: "empty" });
    }
  }
}

export async function cleanSitemaps(options: {
  files: CleanerInputFile[];
  domain: string;
  subfolder: string;
  today: string;
  // Directory the cleaned output files (+ index + report) are written into.
  outDir: string;
  onProgress?: CleanerProgress;
  // Explicit spans. Authoritative over StageTimer, which can only attribute
  // time to whichever stage was last announced to the browser.
  metrics?: CleanerMetrics;
  // Checked between files so an abandoned run stops promptly instead of
  // running to completion with nobody watching.
  signal?: AbortSignal;
  /**
   * Overrides the file-count threshold decision.
   *
   * The batched route MUST set this. `files.length >= CLEANER_PARALLEL_THRESHOLD`
   * is evaluated from whatever subset reached this call, and under batching that
   * is wrong twice over: a 50-file batch falls under the 200 default, and even
   * at completion the candidate list is smaller than the declared total after
   * drops. Either would silently force a large run onto the sequential path —
   * no error, no log line, just the measured ~13% gone.
   */
  parallel?: boolean;
  /**
   * Pass-1 results, aligned index-for-index with `files`.
   *
   * Supplied by the batched route, which classifies each batch as it lands so
   * the work overlaps the upload. When present Pass 1 is skipped entirely and a
   * single summary `parse` frame is emitted, so the stage still announces itself
   * and StageTimer does not misattribute.
   */
  classifications?: CleanerClassification[];
}): Promise<CleanerOutput> {
  const domainHost = new URL(options.domain).host;
  const { today, outDir, files, onProgress, metrics, signal } = options;
  const parallel =
    options.parallel ?? files.length >= CLEANER_PARALLEL_THRESHOLD;

  metrics?.inc("files", files.length);

  // ---- Pass 1: classify each file (streaming, counters only) -------------
  // Decide keep/drop by root element, validity, and on-domain ratio WITHOUT
  // touching the dedup set or writing anything. On large sets this runs across
  // the worker pool (no shared state); results are assembled in file order
  // below so dropped/candidates ordering stays deterministic.
  let classifications: CleanerClassification[];
  const endPass1 = metrics?.start("stage.pass1_ms");

  if (options.classifications) {
    // Pass 1 already ran, per batch, while the upload was still arriving.
    // Announce the stage anyway: every stage must report at least once or its
    // wall clock is charged to whichever stage preceded it, and the progress
    // contract test enforces exactly that.
    if (options.classifications.length !== files.length) {
      throw new Error(
        `classifications length ${options.classifications.length} does not match files length ${files.length}`
      );
    }

    classifications = options.classifications;
    onProgress?.({
      stage: "parse",
      current: files.length,
      total: files.length,
      message: `Read ${files.length} of ${files.length} files`
    });
  } else if (parallel) {
    let done = 0;
    classifications = await runBoundedByIndex(
      files.length,
      CLEANER_MAX_WORKERS,
      async (index) => {
        signal?.throwIfAborted();

        const file = files[index];
        const endFile = metrics?.start("pass1.file_wall_ms");
        const result = await runCleanerClassify({
          filename: file.filename,
          path: file.path,
          domainHost
        });
        const fileMs = endFile?.() ?? 0;

        metrics?.observe("pass1.file_ms", fileMs);
        recordParseTiming(metrics, "pass1", result);
        done += 1;
        onProgress?.({
          stage: "parse",
          current: done,
          total: files.length,
          message: `Parsed ${done} of ${files.length} files`
        });

        return result;
      }
    );
  } else {
    classifications = [];
    for (let i = 0; i < files.length; i += 1) {
      signal?.throwIfAborted();

      const file = files[i];
      onProgress?.({
        stage: "parse",
        current: i + 1,
        total: files.length,
        message: `Parsing ${file.filename} (${i + 1} of ${files.length})`
      });

      const endFile = metrics?.start("pass1.file_wall_ms");
      const result = await classifyCleanerFile(file, domainHost);

      metrics?.observe("pass1.file_ms", endFile?.() ?? 0);
      recordParseTiming(metrics, "pass1", result);
      classifications.push(result);
    }
  }

  endPass1?.();

  const endSelect = metrics?.start("stage.select_ms");

  onProgress?.({
    stage: "select",
    current: 0,
    total: files.length,
    message: `Choosing which of ${files.length} sitemaps to clean…`
  });

  const dropped: { filename: string; reason: DropReason }[] = [];
  // Each candidate carries its on-domain URL count from Pass 1 so the
  // "Total URLs (kept files)" stat can be summed without re-counting.
  const candidates: { file: CleanerInputFile; onDomainCount: number }[] = [];
  let indexFilesDetected = 0;
  let filesProcessed = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const info = classifications[i];

    if (!info.isValid) {
      dropped.push({ filename: file.filename, reason: "unparsable" });
      filesProcessed += 1;
      continue;
    }

    // Index files are rebuilt from scratch — set aside, not cleaned.
    if ((info.rootElement ?? "").toLowerCase() === "sitemapindex") {
      indexFilesDetected += 1;
      continue;
    }

    filesProcessed += 1;

    // Fewer than half the URLs belong to this domain → wrong-domain file.
    if (info.total > 0 && info.matching / info.total < 0.5) {
      dropped.push({ filename: file.filename, reason: "wrong_domain" });
      continue;
    }

    candidates.push({ file, onDomainCount: info.matching });
  }

  endSelect?.();
  metrics?.inc("candidates", candidates.length);

  // ---- Pass 2: dedup + write cleaned files (streaming, first wins) -------
  onProgress?.({ stage: "dedup", message: "Deduplicating URLs…" });

  // The duplicates report is opened BEFORE Pass 2 and written as duplicates are
  // found, rather than assembled afterwards from an in-memory map. See the note
  // on DedupState: that map was what exhausted the heap on a real corpus.
  const reportPath = path.join(outDir, REPORT_FILENAME);
  const reportStream = createWriteStream(reportPath);

  reportStream.write("url,kept_in_file,duplicate_in_file\r\n");

  let reportRows = 0;
  let reportBackpressure = false;
  // Rows are written DURING Pass 2, so their cost belongs to Pass 2 and is
  // already counted there. Timing from here to the close would double-count the
  // whole of Pass 2 — measured at 80% of the run, indistinguishable from
  // stage.pass2_ms. This span covers only the flush.

  const state = createDedupState((row) => {
    // Return value ignored deliberately: honouring backpressure here would mean
    // making considerLoc async, which sits in the innermost per-URL loop of the
    // whole engine. Node buffers the excess, and at ~70 bytes a row that buffer
    // is orders of magnitude smaller than the map this replaced. The flag is
    // recorded so a future change can tell whether it ever actually mattered.
    reportBackpressure =
      !reportStream.write(
        `${csvField(row.url)},${csvField(row.kept_in)},${csvField(
          row.duplicate_in
        )}\r\n`
      ) || reportBackpressure;
    reportRows += 1;
  });
  const survivors: SurvivorFile[] = [];
  const endPass2 = metrics?.start("stage.pass2_ms");

  if (parallel) {
    await writeCandidatesParallel({
      candidates,
      concurrency: CLEANER_MAX_WORKERS,
      today,
      outDir,
      state,
      survivors,
      dropped,
      loadProvisional: (candidate, index) =>
        runCleanerParse({
          inputPath: candidate.file.path,
          provisionalPath: path.join(outDir, `.p${index}.provisional`),
          isGzip: isGzipName(candidate.file.filename),
          domainHost
        }).then((r) => {
          recordParseTiming(metrics, "pass2", r);
          metrics?.add("pass2.worker_flush_ms", r.flushMs);

          return r.provisionalPath;
        }),
      onProgress,
      metrics,
      signal
    });
  } else {
    for (let i = 0; i < candidates.length; i += 1) {
      signal?.throwIfAborted();

      const { file, onDomainCount } = candidates[i];

      onProgress?.({
        stage: "output",
        current: i + 1,
        total: candidates.length,
        message: `Cleaning ${file.filename} (${i + 1} of ${candidates.length})`
      });

      const endCandidate = metrics?.start("pass2.candidate_ms");
      const result = await writeCandidateFile(
        file,
        outDir,
        today,
        state,
        (emit) =>
          streamUrlsetLocs(
            createReadStream(file.path),
            isGzipName(file.filename),
            (loc) => {
              const host = hostOf(loc);

              // Filter stray foreign URLs even inside a kept (mostly-on-domain)
              // file, then dedup the survivors. Key computed inline here (the
              // sequential path has no worker to offload it to).
              if (host !== null && isSameDomain(host, domainHost)) {
                emit(loc, normalizeForDedup(loc));
              }
            }
          ).then((parsed) => {
            recordParseTiming(metrics, "pass2", parsed);

            return parsed;
          })
      );

      metrics?.observe("pass2.file_ms", endCandidate?.() ?? 0);

      if (result.kept) {
        survivors.push({
          filename: outputNameOf(file),
          url_count: result.url_count,
          path: result.path,
          onDomainCount
        });
      } else {
        dropped.push({ filename: outputNameOf(file), reason: "empty" });
      }
    }
  }

  endPass2?.();

  const duplicatesRemoved = state.duplicatesRemoved;

  metrics?.inc("urls_kept", state.keptBy.size);
  metrics?.inc("duplicates_removed", duplicatesRemoved);

  // ---- Rebuild the index -------------------------------------------------
  const endIndex = metrics?.start("stage.index_ms");

  onProgress?.({
    stage: "index",
    current: 0,
    total: survivors.length,
    message: `Rebuilding sitemap-index.xml for ${survivors.length} files…`
  });

  const indexPath = path.join(outDir, INDEX_FILENAME);
  const indexXml = buildIndexXml(
    options.domain,
    options.subfolder,
    survivors.map((file) => file.filename),
    today
  );
  const indexStream = createWriteStream(indexPath);
  indexStream.write(indexXml);
  await finishStream(indexStream);

  onProgress?.({
    stage: "index",
    current: survivors.length,
    total: survivors.length,
    message: "Rebuilt sitemap-index.xml"
  });
  endIndex?.();

  // ---- Close the duplicates report ---------------------------------------
  // The rows were written during Pass 2; only the flush happens here. The stage
  // still ANNOUNCES itself, because StageTimer charges an unannounced phase to
  // whichever stage preceded it and the progress contract asserts every stage
  // reports at least once.
  onProgress?.({
    stage: "report",
    current: reportRows,
    total: reportRows,
    message:
      reportRows > 0
        ? `Wrote the duplicates report — ${reportRows} rows`
        : "No duplicates to report"
  });

  const endReport = metrics?.start("stage.report_ms");

  await finishStream(reportStream);
  metrics?.inc("report.rows", reportRows);

  if (reportBackpressure) {
    metrics?.inc("report.backpressure");
  }

  endReport?.();

  // ---- Assemble the manifest --------------------------------------------
  const outputManifest: CleanerOutputFile[] = survivors.map((file) => ({
    filename: file.filename,
    path: file.path
  }));

  outputManifest.push({ filename: INDEX_FILENAME, path: indexPath });
  outputManifest.push({ filename: REPORT_FILENAME, path: reportPath });

  const totalUrlsKeptFiles = survivors.reduce(
    (sum, file) => sum + file.onDomainCount,
    0
  );
  const cleanUrlsRemaining = survivors.reduce(
    (sum, file) => sum + file.url_count,
    0
  );
  const reductionPct =
    totalUrlsKeptFiles > 0
      ? (duplicatesRemoved / totalUrlsKeptFiles) * 100
      : 0;

  const result: CleanerResult = {
    files_processed: filesProcessed,
    files_kept: survivors.length,
    files_dropped: dropped.length,
    dropped_files: dropped,
    duplicates_removed: duplicatesRemoved,
    output_files: survivors.map((file) => ({
      filename: file.filename,
      url_count: file.url_count
    })),
    index_files_detected: indexFilesDetected,
    total_urls_kept_files: totalUrlsKeptFiles,
    clean_urls_remaining: cleanUrlsRemaining,
    reduction_pct: reductionPct
  };

  return { result, files: outputManifest };
}
