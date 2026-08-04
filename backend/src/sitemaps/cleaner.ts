import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGzip } from "node:zlib";
import path from "node:path";

import { streamUrlsetLocs } from "./parser.js";
import { isSameDomain } from "./domain.js";
import {
  CLEANER_MAX_WORKERS,
  CLEANER_PARALLEL_THRESHOLD,
  runCleanerClassify,
  runCleanerParse
} from "../jobs/cleanerPool.js";
import {
  admitDedupRun,
  chargeDedupBytes,
  dedupEntryCost,
  releaseDedupRun
} from "./dedupBudget.js";

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
// Memory model (v1.38): only URL strings are ever held in memory. Files are
// read one at a time and streamed; a file's kept URLs are written straight to
// disk. The only unavoidable heap cost is the cross-file dedup index.
//
// Memory model (v1.48): that "only unavoidable cost" was unbounded, and past
// ~25-30M unique URLs it reached V8's heap limit and ABORTED the process,
// killing every concurrent run. Two things changed:
//
//   - The dedup index is now BYTE-ACCOUNTED against a process-wide budget
//     derived from the live heap limit (sitemaps/dedupBudget.ts). Crossing it
//     fails the run with a message naming the real numbers instead of taking
//     the whole API down. Still in memory — moving `keptBy` to a disk-backed
//     store is a separate, larger change.
//   - The duplicates report is now STREAMED to its CSV as duplicates are found.
//     It used to accumulate a full Map<url, {url, kept_in, also_in[]}> (~250 B
//     per duplicated URL) AND then a second complete array copy of the same
//     data to return to the caller — so a run with few unique URLs but tens of
//     millions of duplicates blew the heap no matter what a unique-URL ceiling
//     said. Nothing about the report is held now beyond the current row.
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
}

export interface CleanerResult {
  files_processed: number;
  files_kept: number;
  files_dropped: number;
  dropped_files: { filename: string; reason: DropReason }[];
  duplicates_removed: number;
  // NOTE: there is deliberately no `duplicate_urls` array here any more. It was
  // a second complete in-memory copy of the duplicates report, built purely to
  // ship to the browser so the browser could rebuild the CSV that this module
  // had ALREADY written to disk. The frontend downloads that file instead (see
  // GET /api/cleaner/report/:token), so the rows exist in exactly one place.
  // `duplicates_removed` is what the UI needs to know whether the report is
  // worth offering, and it counts occurrences, matching the CSV's rows.
  output_files: { filename: string; url_count: number }[];
  // Uploaded <sitemapindex> files are excluded from cleaning and replaced by a
  // freshly rebuilt index; surfaced separately so the count stays honest.
  index_files_detected: number;
  // The filename the rebuilt index was written under. Carries through whatever
  // the INPUT index was actually called (a client's live index may be
  // "sitemap.xml" or "sitemap_index.xml"), falling back to sitemap-index.xml
  // only when the set had no index to begin with. Publishing overwrites the
  // live structure in place, so inventing a new index name here would strand
  // the original object and leave search engines pointed at a stale file.
  index_filename: string;
  // ---- URL-count-level stats (match the reference Streamlit report) ----
  // Sum, across every surviving/kept file, of its on-domain URL count BEFORE
  // cross-file dedup ("Total URLs (kept files)").
  total_urls_kept_files: number;
  // Sum of output_files[].url_count — the deduped URLs actually written
  // ("Clean URLs remaining"). In the common case (no file emptied by dedup)
  // total_urls_kept_files - clean_urls_remaining === duplicates_removed. That
  // identity does NOT hold when a file is emptied entirely by dedup: it leaves
  // the survivors set, so its URLs drop out of total_urls_kept_files while its
  // duplicates remain counted in duplicates_removed. reduction_pct is measured
  // against all candidates precisely so it stays correct in that case.
  clean_urls_remaining: number;
  // duplicates_removed as a share of every on-domain URL that entered dedup
  // (all candidate files, including any later emptied) * 100 ("Reduction %").
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

export type CleanerProgress = (event: {
  stage: "parse" | "dedup" | "index" | "output";
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

// Duplicates report, written as duplicates are found.
//
// Rows are batched into a small string buffer and flushed at BUFFER_FLUSH_BYTES.
// The batching is not for speed, it is for bounded memory: considerLoc runs
// inside a sax callback and cannot await, so it cannot honour stream
// backpressure. Handing every row straight to createWriteStream would let
// Node's internal write queue grow without limit whenever the parser outruns
// the disk — which would reintroduce the unbounded heap growth this replaced,
// just one layer down. A fixed-size buffer plus `write()`'s own queue is bounded
// in practice because a CSV append is far cheaper than the XML parse feeding it.
//
// FORMAT CHANGE (v1.48): one row per duplicate OCCURRENCE, header
// `url,kept_in_file,duplicate_in_file`. It was previously one row per duplicated
// URL with a "; "-joined `duplicate_in_files` list — and building that list is
// precisely what required the whole report to stay resident until the run ended.
// The occurrence form also matches `duplicates_removed` 1:1, which the grouped
// form did not.
const REPORT_BUFFER_FLUSH_BYTES = 64 * 1024;

function openDuplicateReport(reportPath: string): DuplicateReportSink & {
  close: () => Promise<void>;
} {
  const stream = createWriteStream(reportPath);
  stream.write("url,kept_in_file,duplicate_in_file\r\n");

  let buffer = "";
  let closed = false;

  const flush = () => {
    if (buffer.length > 0) {
      stream.write(buffer);
      buffer = "";
    }
  };

  return {
    writeRow: (url, keptIn, duplicateIn) => {
      buffer += `${csvField(url)},${csvField(keptIn)},${csvField(
        duplicateIn
      )}\r\n`;

      if (buffer.length >= REPORT_BUFFER_FLUSH_BYTES) {
        flush();
      }
    },
    // Idempotent: the success path closes this before the manifest lists the
    // file, and the caller ALSO registers it as a cleanup for the throwing
    // paths. Closing twice must not reject or double-end the stream.
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      flush();
      await finishStream(stream);
    }
  };
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

// Give a candidate a collision-free OUTPUT filename. Two uploaded files can
// legitimately share a basename — the route flattens ZIP paths through
// baseName(), so `a/sitemap.xml` and `b/sitemap.xml` both arrive as
// "sitemap.xml" — and before this, both wrote to the same outDir path: the
// second silently overwrote the first, losing its URLs while the summary still
// counted both files and all their URLs. Suffix the duplicate instead
// (sitemap.xml, sitemap-2.xml), keeping any .xml / .xml.gz extension intact so
// the rebuilt index and the ZIP both reference a file that actually exists.
export function uniqueOutputName(desired: string, used: Set<string>): string {
  if (!used.has(desired)) {
    used.add(desired);

    return desired;
  }

  // Split off the full extension so the suffix lands on the stem:
  // "a.xml.gz" -> stem "a", ext ".xml.gz".
  const lower = desired.toLowerCase();
  const ext = lower.endsWith(".xml.gz")
    ? desired.slice(-7)
    : path.extname(desired);
  const stem = ext ? desired.slice(0, desired.length - ext.length) : desired;

  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;

    if (!used.has(candidate)) {
      used.add(candidate);

      return candidate;
    }
  }
}

// Open the sink a cleaned file is written through. When the output name ends
// in .gz the bytes must actually BE gzip — the cleaner accepts .xml.gz input
// (streamUrlsetLocs gunzips it) but used to write the cleaned result as plain
// XML under the same .gz name, producing a file that any consumer trying to
// decompress it — Google, or this tool's own re-ingest on handoff — fails on.
// `done` resolves only once the underlying FILE is closed, not merely when the
// gzip transform has ended, so callers never unlink or ZIP a partial file.
function openCleanedSink(outPath: string): {
  sink: NodeJS.WritableStream;
  done: () => Promise<void>;
} {
  const fileStream = createWriteStream(outPath);

  if (!isGzipName(outPath)) {
    return { sink: fileStream, done: () => finishStream(fileStream) };
  }

  const gzip = createGzip();
  const closed = new Promise<void>((resolve, reject) => {
    fileStream.on("error", reject);
    gzip.on("error", reject);
    fileStream.on("close", () => resolve());
  });
  gzip.pipe(fileStream);

  return {
    sink: gzip,
    done: () => {
      gzip.end();

      return closed;
    }
  };
}

// ---- Worker-safe primitives (imported by the piscina workers) -----------

export type CleanerClassification = {
  isValid: boolean;
  rootElement: string | null;
  total: number;
  matching: number;
};

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
    matching
  };
}

// Pass 2 core (worker side): stream a kept file, keep only on-domain locs, and
// write "<dedupKey>\t<loc>" lines to a provisional file in file order — the
// expensive key normalization happens here, off the main thread. Returns the
// count of on-domain locs written. The provisional file is the ONLY thing that
// crosses to the main thread (via disk, not IPC).
export async function writeProvisionalOnDomainFile(
  inputPath: string,
  provisionalPath: string,
  isGzip: boolean,
  domainHost: string
): Promise<number> {
  const out = createWriteStream(provisionalPath);
  let count = 0;

  await streamUrlsetLocs(createReadStream(inputPath), isGzip, (loc) => {
    const host = hostOf(loc);

    if (host === null || !isSameDomain(host, domainHost)) {
      return;
    }

    out.write(`${normalizeForDedup(loc)}\t${loc}\n`);
    count += 1;
  });

  await finishStream(out);

  return count;
}

// ---- Cross-file dedup: the single source of truth -----------------------

// Sink for duplicate rows. Written as they are found so no report data
// accumulates on the heap. `write` is synchronous-looking on purpose:
// considerLoc is called from inside a sax callback and cannot await.
export type DuplicateReportSink = {
  writeRow: (url: string, keptIn: string, duplicateIn: string) => void;
};

// How many entries to accumulate locally before syncing the shared ledger.
// The hot path is then a counter increment; the process-wide total trails by at
// most this many entries (~1 MB), which the budget's 45% margin absorbs.
const LEDGER_SYNC_INTERVAL = 4096;

export type DedupState = {
  keptBy: Map<string, string>; // normalized URL -> kept-in filename
  duplicatesRemoved: number;
  // Ledger identity + byte accounting. Bytes, not a URL count, because a
  // 100-char corpus costs ~1.7x a 60-char one for the same count.
  runId: string;
  bytes: number;
  unsyncedBytes: number;
  unsyncedEntries: number;
  report: DuplicateReportSink | null;
};

export function createDedupState(
  options: { runId?: string; report?: DuplicateReportSink } = {}
): DedupState {
  const runId = options.runId ?? `dedup-${Math.random().toString(36).slice(2)}`;

  return {
    keptBy: new Map(),
    duplicatesRemoved: 0,
    runId,
    bytes: 0,
    unsyncedBytes: 0,
    unsyncedEntries: 0,
    report: options.report ?? null
  };
}

// Push any locally-accumulated bytes into the shared ledger. Throws
// CleanerCapacityError when this run would push the PROCESS-WIDE total over
// budget. Called on the batch boundary and once more at the end of a run.
export function syncDedupLedger(state: DedupState): void {
  if (state.unsyncedBytes === 0) {
    return;
  }

  const delta = state.unsyncedBytes;
  state.unsyncedBytes = 0;
  state.unsyncedEntries = 0;
  chargeDedupBytes(state.runId, delta, state.keptBy.size);
}

// Decide ONE on-domain loc against the running cross-file dedup state
// (first-occurrence-across-files wins), given its precomputed dedup `key`.
// Returns true when this loc is the first sighting and should be written; false
// when it's a duplicate (recorded in the report). Mutates `state`. This is
// deliberately the only implementation of the dedup rule so the sequential and
// parallel Pass-2 paths are byte-identical (both use normalizeForDedup — inline
// on the sequential path, in the worker on the parallel path).
export function considerLoc(
  state: DedupState,
  loc: string,
  key: string,
  filename: string
): boolean {
  if (!state.keptBy.has(key)) {
    state.keptBy.set(key, filename);

    // Charge the entry we just added. Accumulated locally and synced to the
    // shared ledger every LEDGER_SYNC_INTERVAL entries; the sync is what throws
    // CleanerCapacityError, so the run stops HERE — incrementally, mid-Pass-2 —
    // rather than after the heap is already gone. A pre-flight estimate cannot
    // do this: the unique count is not known until dedup has actually run.
    const cost = dedupEntryCost(key.length);
    state.bytes += cost;
    state.unsyncedBytes += cost;
    state.unsyncedEntries += 1;

    if (state.unsyncedEntries >= LEDGER_SYNC_INTERVAL) {
      syncDedupLedger(state);
    }

    return true;
  }

  state.duplicatesRemoved += 1;

  // Streamed, not accumulated. One row per duplicate OCCURRENCE, which is why
  // the report no longer needs a Map keyed by URL to collect an `also_in` list:
  // collecting that list is exactly what forced the whole report to be resident
  // until the run ended. Occurrence rows also line up 1:1 with
  // duplicates_removed, which the old URL-grouped rows did not.
  state.report?.writeRow(loc, state.keptBy.get(key) as string, filename);

  return false;
}

type SurvivorFile = {
  filename: string;
  url_count: number;
  path: string;
  onDomainCount: number;
};

// A file that survived Pass 1 and will be cleaned. `outputName` is its
// collision-free output filename (usually identical to file.filename).
export type CleanerCandidate = {
  file: CleanerInputFile;
  outputName: string;
  onDomainCount: number;
};

// Write one candidate's cleaned output: header, one <url> per kept loc, footer.
// The on-domain (loc, key) pairs are supplied by `produce` via `emit`, which
// runs each through the shared dedup decision. A file with nothing kept is
// removed and reported empty. Identical for the sequential and parallel paths.
// `outputName` is the collision-free name this file is written under (see
// uniqueOutputName); it may differ from file.filename when two uploads shared a
// basename. Dedup attribution uses it too, so the duplicates report points at a
// file that actually exists in the output.
async function writeCandidateFile(
  file: CleanerInputFile,
  outputName: string,
  outDir: string,
  today: string,
  state: DedupState,
  produce: (emit: (loc: string, key: string) => void) => void | Promise<unknown>
): Promise<{ kept: boolean; url_count: number; path: string }> {
  const outPath = path.join(outDir, outputName);
  const { sink, done } = openCleanedSink(outPath);
  sink.write(URLSET_HEADER);
  let keptCount = 0;

  const emit = (loc: string, key: string) => {
    if (considerLoc(state, loc, key, outputName)) {
      sink.write(urlEntry(loc, today));
      keptCount += 1;
    }
  };

  await produce(emit);

  if (keptCount === 0) {
    await done();
    await unlink(outPath).catch(() => undefined);

    return { kept: false, url_count: 0, path: outPath };
  }

  sink.write(URLSET_FOOTER);
  await done();

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

    rl.on("line", (line) => {
      if (!line) {
        return;
      }

      const tab = line.indexOf("\t");

      if (tab < 0) {
        return;
      }

      onPair(line.slice(tab + 1), line.slice(0, tab));
    });
    rl.on("close", () => resolve());
    rl.on("error", reject);
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
  candidates: CleanerCandidate[];
  concurrency: number;
  today: string;
  outDir: string;
  state: DedupState;
  survivors: SurvivorFile[];
  dropped: { filename: string; reason: DropReason }[];
  loadProvisional: (
    candidate: CleanerCandidate,
    index: number
  ) => Promise<string>;
  onProgress?: CleanerProgress;
  cleanupProvisional?: boolean;
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
    cleanupProvisional = true
  } = options;
  const window = Math.max(1, options.concurrency);
  const inFlight = new Map<number, Promise<string>>();

  const dispatch = (index: number) => {
    if (index < candidates.length) {
      inFlight.set(index, loadProvisional(candidates[index], index));
    }
  };

  for (let k = 0; k < Math.min(window, candidates.length); k += 1) {
    dispatch(k);
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const { file, outputName, onDomainCount } = candidates[i];
    const provisionalPath = await (inFlight.get(i) as Promise<string>);
    inFlight.delete(i);
    dispatch(i + window);

    onProgress?.({
      stage: "output",
      current: i + 1,
      total: candidates.length,
      message: `Cleaning ${file.filename} (${i + 1} of ${candidates.length})`
    });

    const result = await writeCandidateFile(
      file,
      outputName,
      outDir,
      today,
      state,
      (emit) => readProvisionalPairs(provisionalPath, emit)
    );

    if (cleanupProvisional) {
      await unlink(provisionalPath).catch(() => undefined);
    }

    if (result.kept) {
      survivors.push({
        filename: outputName,
        url_count: result.url_count,
        path: result.path,
        onDomainCount
      });
    } else {
      dropped.push({ filename: file.filename, reason: "empty" });
    }
  }
}

export type CleanSitemapsOptions = {
  files: CleanerInputFile[];
  domain: string;
  subfolder: string;
  today: string;
  // Directory the cleaned output files (+ index + report) are written into.
  outDir: string;
  onProgress?: CleanerProgress;
  // Ledger identity. Supplied by the SFTP path (which already has a runId);
  // minted here for the upload path, which does not.
  runId?: string;
};

// Admission + release wrapper around the clean itself.
//
// The release is in a `finally` for a reason: a charge that outlives its run
// permanently shrinks the shared budget for every later run, and only a restart
// recovers it — the exact class of failure this accounting exists to prevent. So
// every exit path (success, CleanerCapacityError, parse failure, abort) gives the
// bytes back.
export async function cleanSitemaps(
  options: CleanSitemapsOptions
): Promise<CleanerOutput> {
  const runId = options.runId ?? `cleaner-${randomUUID()}`;

  // Refuse up front when the runs already in flight leave no room, rather than
  // pulling and parsing for minutes and dying on the first dedup entry.
  admitDedupRun(runId);

  // Resources the clean opens that must be released even when it throws — which
  // it now can, mid-stream, on a budget refusal.
  const cleanups: (() => Promise<void>)[] = [];

  try {
    return await cleanSitemapsInner(options, runId, cleanups);
  } finally {
    for (const cleanup of cleanups) {
      await cleanup().catch(() => undefined);
    }

    releaseDedupRun(runId);
  }
}

async function cleanSitemapsInner(
  options: CleanSitemapsOptions,
  runId: string,
  cleanups: (() => Promise<void>)[]
): Promise<CleanerOutput> {
  const domainHost = new URL(options.domain).host;
  const { today, outDir, files, onProgress } = options;
  const parallel = files.length >= CLEANER_PARALLEL_THRESHOLD;

  // ---- Pass 1: classify each file (streaming, counters only) -------------
  // Decide keep/drop by root element, validity, and on-domain ratio WITHOUT
  // touching the dedup set or writing anything. On large sets this runs across
  // the worker pool (no shared state); results are assembled in file order
  // below so dropped/candidates ordering stays deterministic.
  let classifications: CleanerClassification[];

  if (parallel) {
    let done = 0;
    classifications = await runBoundedByIndex(
      files.length,
      CLEANER_MAX_WORKERS,
      async (index) => {
        const file = files[index];
        const result = await runCleanerClassify({
          filename: file.filename,
          path: file.path,
          domainHost
        });
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
      const file = files[i];
      onProgress?.({
        stage: "parse",
        current: i + 1,
        total: files.length,
        message: `Parsing ${file.filename} (${i + 1} of ${files.length})`
      });
      classifications.push(await classifyCleanerFile(file, domainHost));
    }
  }

  const dropped: { filename: string; reason: DropReason }[] = [];
  // Each candidate carries its on-domain URL count from Pass 1 so the
  // "Total URLs (kept files)" stat can be summed without re-counting.
  const candidates: CleanerCandidate[] = [];
  // Output filenames claimed so far, so two uploads sharing a basename get
  // distinct output files instead of one silently overwriting the other.
  const usedOutputNames = new Set<string>();
  // Name of the first uploaded <sitemapindex>, reused for the rebuilt index.
  let detectedIndexName: string | null = null;
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

    // Index files are rebuilt from scratch — set aside, not cleaned. The FIRST
    // one's name is reused for the rebuilt index so the output replaces the
    // original in place rather than introducing a differently-named file.
    if ((info.rootElement ?? "").toLowerCase() === "sitemapindex") {
      indexFilesDetected += 1;

      if (!detectedIndexName) {
        detectedIndexName = file.filename;
      }

      continue;
    }

    filesProcessed += 1;

    // Fewer than half the URLs belong to this domain → wrong-domain file.
    if (info.total > 0 && info.matching / info.total < 0.5) {
      dropped.push({ filename: file.filename, reason: "wrong_domain" });
      continue;
    }

    candidates.push({
      file,
      outputName: uniqueOutputName(file.filename, usedOutputNames),
      onDomainCount: info.matching
    });
  }

  // ---- Pass 2: dedup + write cleaned files (streaming, first wins) -------
  onProgress?.({ stage: "dedup", message: "Deduplicating URLs…" });

  // The duplicates CSV is opened BEFORE Pass 2 now, not written from a Map
  // afterwards, so a duplicate is on disk moments after it is found and nothing
  // about the report is retained.
  const reportPath = path.join(outDir, REPORT_FILENAME);
  const report = openDuplicateReport(reportPath);
  const state = createDedupState({ runId, report });
  const survivors: SurvivorFile[] = [];

  // Pass 2 can now throw where it previously could not: exceeding the dedup
  // budget aborts mid-stream, after this write stream is already open. Register
  // the close so it happens on EVERY exit path — leaking one file descriptor per
  // refused run would be fd exhaustion arrived at by way of the guard meant to
  // prevent an outage. close() is idempotent, so the success path below still
  // closes it at the right moment (before the manifest lists it).
  cleanups.push(() => report.close());

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
        }).then((r) => r.provisionalPath),
      onProgress
    });
  } else {
    for (let i = 0; i < candidates.length; i += 1) {
      const { file, outputName, onDomainCount } = candidates[i];

      onProgress?.({
        stage: "output",
        current: i + 1,
        total: candidates.length,
        message: `Cleaning ${file.filename} (${i + 1} of ${candidates.length})`
      });

      const result = await writeCandidateFile(
        file,
        outputName,
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
          )
      );

      if (result.kept) {
        survivors.push({
          filename: outputName,
          url_count: result.url_count,
          path: result.path,
          onDomainCount
        });
      } else {
        dropped.push({ filename: file.filename, reason: "empty" });
      }
    }
  }

  // Final sync: charge whatever the last partial batch accumulated, so a run
  // that ends just under a batch boundary is still accounted for while it lives.
  syncDedupLedger(state);

  const duplicatesRemoved = state.duplicatesRemoved;

  // Report rows are all written by now (they were emitted during Pass 2); close
  // the file before it is listed in the manifest and packed into the ZIP.
  await report.close();

  // ---- Rebuild the index -------------------------------------------------
  onProgress?.({
    stage: "index",
    message: "Building sitemap-index.xml…"
  });

  // Reuse the uploaded index's own name; only fall back to the canonical
  // sitemap-index.xml when the set genuinely had no index to preserve. Guard
  // against it colliding with a cleaned child file of the same name.
  const indexFilename =
    detectedIndexName && !usedOutputNames.has(detectedIndexName)
      ? detectedIndexName
      : INDEX_FILENAME;
  const indexPath = path.join(outDir, indexFilename);
  const indexXml = buildIndexXml(
    options.domain,
    options.subfolder,
    survivors.map((file) => file.filename),
    today
  );
  const indexStream = createWriteStream(indexPath);
  indexStream.write(indexXml);
  await finishStream(indexStream);

  // (The duplicates report was written during Pass 2 and closed above.)

  // ---- Assemble the manifest --------------------------------------------
  const outputManifest: CleanerOutputFile[] = survivors.map((file) => ({
    filename: file.filename,
    path: file.path
  }));

  outputManifest.push({ filename: indexFilename, path: indexPath });
  outputManifest.push({ filename: REPORT_FILENAME, path: reportPath });

  const totalUrlsKeptFiles = survivors.reduce(
    (sum, file) => sum + file.onDomainCount,
    0
  );
  const cleanUrlsRemaining = survivors.reduce(
    (sum, file) => sum + file.url_count,
    0
  );
  // Reduction is measured against every on-domain URL that ENTERED dedup, not
  // just those in surviving files. A file wiped out entirely by dedup leaves
  // its duplicates in the numerator but takes its URLs out of a survivors-only
  // denominator — which reported e.g. 2 duplicates over 2 surviving URLs =
  // "100% reduction" for an input that was really 4 URLs and 50% duplicated.
  const totalUrlsCandidateFiles = candidates.reduce(
    (sum, candidate) => sum + candidate.onDomainCount,
    0
  );
  const reductionPct =
    totalUrlsCandidateFiles > 0
      ? (duplicatesRemoved / totalUrlsCandidateFiles) * 100
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
    index_filename: indexFilename,
    total_urls_kept_files: totalUrlsKeptFiles,
    clean_urls_remaining: cleanUrlsRemaining,
    reduction_pct: reductionPct
  };

  return { result, files: outputManifest };
}
