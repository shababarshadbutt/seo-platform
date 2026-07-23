import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";

import { streamUrlsetLocs } from "./parser.js";
import { isSameDomain } from "./domain.js";

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
// Memory model (v1.38): NOTHING but URL strings is ever held in memory. Input
// files are read from disk one at a time and parsed as a stream; the URLs a
// file keeps are written straight to a cleaned output file on disk as they are
// read — the full URL list of a file is never buffered, and no cleaned file's
// XML is ever built as an in-memory string. The only unavoidable heap cost is
// the cross-file dedup Set (normalized URL strings) plus the duplicates report.
// This replaces the pre-v1.38 design that buffered every uploaded file, built
// three copies of every URL, and materialised every output file's XML at once,
// which OOM'd at ~2GB on ~124 files.

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
function normalizeForDedup(url: string): string {
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
  const { today, outDir } = options;

  // ---- Pass 1: classify each file (streaming, counters only) -------------
  // Decide keep/drop by root element, validity, and on-domain ratio WITHOUT
  // touching the dedup set or writing anything, so a file that turns out to be
  // wrong-domain never pollutes the cross-file dedup state.
  const dropped: { filename: string; reason: DropReason }[] = [];
  const candidates: CleanerInputFile[] = [];
  let indexFilesDetected = 0;
  let filesProcessed = 0;

  for (let i = 0; i < options.files.length; i += 1) {
    const file = options.files[i];

    options.onProgress?.({
      stage: "parse",
      current: i + 1,
      total: options.files.length,
      message: `Parsing ${file.filename} (${i + 1} of ${options.files.length})`
    });

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

    if (!parsed.isValid) {
      dropped.push({ filename: file.filename, reason: "unparsable" });
      filesProcessed += 1;
      continue;
    }

    // Index files are rebuilt from scratch — set aside, not cleaned.
    if ((parsed.rootElement ?? "").toLowerCase() === "sitemapindex") {
      indexFilesDetected += 1;
      continue;
    }

    filesProcessed += 1;

    // Fewer than half the URLs belong to this domain → wrong-domain file.
    if (total > 0 && matching / total < 0.5) {
      dropped.push({ filename: file.filename, reason: "wrong_domain" });
      continue;
    }

    candidates.push(file);
  }

  // ---- Pass 2: dedup + write cleaned files (streaming, first wins) -------
  options.onProgress?.({ stage: "dedup", message: "Deduplicating URLs…" });

  const keptBy = new Map<string, string>(); // normalized URL -> kept-in filename
  const dupReport = new Map<
    string,
    { url: string; kept_in: string; also_in: string[] }
  >();
  let duplicatesRemoved = 0;

  const survivors: { filename: string; url_count: number; path: string }[] = [];

  for (let i = 0; i < candidates.length; i += 1) {
    const file = candidates[i];

    options.onProgress?.({
      stage: "output",
      current: i + 1,
      total: candidates.length,
      message: `Cleaning ${file.filename} (${i + 1} of ${candidates.length})`
    });

    const outPath = path.join(outDir, file.filename);
    const out = createWriteStream(outPath);
    out.write(URLSET_HEADER);
    let keptCount = 0;

    // onLoc runs synchronously as the parser consumes each chunk. Only
    // on-domain, not-yet-seen URLs are written; the file's URLs are never
    // collected into an array.
    await streamUrlsetLocs(
      createReadStream(file.path),
      isGzipName(file.filename),
      (loc) => {
        const host = hostOf(loc);

        // Filter stray foreign URLs even inside a kept (mostly-on-domain) file.
        if (host === null || !isSameDomain(host, domainHost)) {
          return;
        }

        const key = normalizeForDedup(loc);

        if (!keptBy.has(key)) {
          keptBy.set(key, file.filename);
          out.write(urlEntry(loc, today));
          keptCount += 1;
          return;
        }

        // Duplicate — drop it and record where it lives.
        duplicatesRemoved += 1;
        const keptIn = keptBy.get(key) as string;
        let entry = dupReport.get(key);

        if (!entry) {
          entry = { url: loc, kept_in: keptIn, also_in: [] };
          dupReport.set(key, entry);
        }

        if (!entry.also_in.includes(file.filename)) {
          entry.also_in.push(file.filename);
        }
      }
    );

    if (keptCount === 0) {
      // Nothing survived cleaning — close and remove the empty output file.
      await finishStream(out);
      await unlink(outPath).catch(() => undefined);
      dropped.push({ filename: file.filename, reason: "empty" });
      continue;
    }

    out.write(URLSET_FOOTER);
    await finishStream(out);
    survivors.push({
      filename: file.filename,
      url_count: keptCount,
      path: outPath
    });
  }

  // ---- Rebuild the index -------------------------------------------------
  options.onProgress?.({
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

  for (const row of dupReport.values()) {
    duplicateUrls.push(row);
    reportStream.write(
      `${csvField(row.url)},${csvField(row.kept_in)},${csvField(
        row.also_in.join("; ")
      )}\r\n`
    );
  }

  await finishStream(reportStream);

  // ---- Assemble the manifest --------------------------------------------
  const files: CleanerOutputFile[] = survivors.map((file) => ({
    filename: file.filename,
    path: file.path
  }));

  files.push({ filename: INDEX_FILENAME, path: indexPath });
  files.push({ filename: REPORT_FILENAME, path: reportPath });

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
    index_files_detected: indexFilesDetected
  };

  return { result, files };
}
