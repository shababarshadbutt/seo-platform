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
// disk. The only unavoidable heap cost is the cross-file dedup Set plus the
// duplicates report.
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
  duplicate_urls: { url: string; kept_in: string; also_in: string[] }[];
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

export type DedupState = {
  keptBy: Map<string, string>; // normalized URL -> kept-in filename
  dupReport: Map<string, { url: string; kept_in: string; also_in: string[] }>;
  duplicatesRemoved: number;
};

export function createDedupState(): DedupState {
  return { keptBy: new Map(), dupReport: new Map(), duplicatesRemoved: 0 };
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

    return true;
  }

  state.duplicatesRemoved += 1;
  const keptIn = state.keptBy.get(key) as string;
  let entry = state.dupReport.get(key);

  if (!entry) {
    entry = { url: loc, kept_in: keptIn, also_in: [] };
    state.dupReport.set(key, entry);
  }

  if (!entry.also_in.includes(filename)) {
    entry.also_in.push(filename);
  }

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

export async function cleanSitemaps(options: {
  files: CleanerInputFile[];
  domain: string;
  subfolder: string;
  today: string;
  // Directory the cleaned output files (+ index + report) are written into.
  outDir: string;
  onProgress?: CleanerProgress;
}): Promise<CleanerOutput> {
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

    candidates.push({
      file,
      outputName: uniqueOutputName(file.filename, usedOutputNames),
      onDomainCount: info.matching
    });
  }

  // ---- Pass 2: dedup + write cleaned files (streaming, first wins) -------
  onProgress?.({ stage: "dedup", message: "Deduplicating URLs…" });

  const state = createDedupState();
  const survivors: SurvivorFile[] = [];

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

  const duplicatesRemoved = state.duplicatesRemoved;

  // ---- Rebuild the index -------------------------------------------------
  onProgress?.({
    stage: "index",
    message: "Building sitemap-index.xml…"
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

  // ---- Write the duplicates report (streamed, never one big string) ------
  const reportPath = path.join(outDir, REPORT_FILENAME);
  const reportStream = createWriteStream(reportPath);
  reportStream.write("url,kept_in_file,duplicate_in_files\r\n");

  const duplicateUrls: { url: string; kept_in: string; also_in: string[] }[] =
    [];

  for (const row of state.dupReport.values()) {
    duplicateUrls.push(row);
    reportStream.write(
      `${csvField(row.url)},${csvField(row.kept_in)},${csvField(
        row.also_in.join("; ")
      )}\r\n`
    );
  }

  await finishStream(reportStream);

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
    duplicate_urls: duplicateUrls,
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
