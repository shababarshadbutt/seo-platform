import { Readable } from "node:stream";

import { parseSitemapStream } from "./parser.js";
import { isSameDomain } from "./domain.js";

// Sitemap Cleaner — a stateless port of the SEO team's Streamlit script
// (sitemap_dashboard_4.py). Given a set of uploaded XML sitemap files it:
//   1. parses each file (sax, via parseSitemapStream)
//   2. drops files whose URLs mostly belong to another domain, and filters
//      stray foreign URLs out of the files it keeps
//   3. removes duplicate URLs across all files (first occurrence wins)
//   4. drops files left empty after cleaning
//   5. rebuilds a fresh sitemap-index.xml pointing at the survivors
//   6. emits the cleaned files, the index, and a duplicates CSV report
// Nothing is persisted — the caller streams the outputs back as a ZIP.

export type DropReason = "empty" | "wrong_domain" | "unparsable";

export interface CleanerInputFile {
  filename: string;
  buffer: Buffer;
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

export interface CleanerOutputFile {
  filename: string;
  content: string;
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

    let path = parsed.pathname;

    if (path.length > 1 && path.endsWith("/")) {
      path = path.slice(0, -1);
    }

    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function buildUrlsetXml(locs: string[]) {
  const entries = locs
    .map((loc) => `  <url>\n    <loc>${escapeXml(loc)}</loc>\n  </url>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
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

function buildReportCsv(
  rows: { url: string; kept_in: string; also_in: string[] }[]
) {
  const header = "url,kept_in_file,duplicate_in_files";
  const lines = rows.map(
    (row) =>
      `${csvField(row.url)},${csvField(row.kept_in)},${csvField(
        row.also_in.join("; ")
      )}`
  );

  return `${[header, ...lines].join("\r\n")}\r\n`;
}

export async function cleanSitemaps(options: {
  files: CleanerInputFile[];
  domain: string;
  subfolder: string;
  today: string;
  onProgress?: CleanerProgress;
}): Promise<CleanerOutput> {
  const domainHost = new URL(options.domain).host;

  // ---- Steps 1 & 2: parse + domain filter -------------------------------
  const regular: { filename: string; locs: string[] }[] = [];
  const dropped: { filename: string; reason: DropReason }[] = [];
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

    let parsed;

    try {
      parsed = await parseSitemapStream(
        Readable.from(file.buffer),
        isGzipName(file.filename),
        { collectUrlLocs: true }
      );
    } catch {
      parsed = null;
    }

    if (!parsed || !parsed.isValid) {
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

    const locs = parsed.urlLocs ?? [];
    const matching = locs.filter((loc) => {
      const host = hostOf(loc);

      return host !== null && isSameDomain(host, domainHost);
    });

    // Fewer than half the URLs belong to this domain → wrong-domain file.
    if (locs.length > 0 && matching.length / locs.length < 0.5) {
      dropped.push({ filename: file.filename, reason: "wrong_domain" });
      continue;
    }

    // Keep only the on-domain URLs (stray foreign URLs filtered even in mixed
    // files). Empty files are detected after dedup (Step 4).
    regular.push({ filename: file.filename, locs: matching });
  }

  // ---- Step 3: deduplicate across all files (first occurrence wins) ------
  options.onProgress?.({ stage: "dedup", message: "Deduplicating URLs…" });

  const keptBy = new Map<string, string>(); // normalized URL -> kept-in filename
  const dupReport = new Map<
    string,
    { url: string; kept_in: string; also_in: string[] }
  >();
  let duplicatesRemoved = 0;

  const cleaned: { filename: string; urls: string[] }[] = [];

  for (const file of regular) {
    const urls: string[] = [];

    for (const loc of file.locs) {
      const key = normalizeForDedup(loc);

      if (!keptBy.has(key)) {
        keptBy.set(key, file.filename);
        urls.push(loc);
        continue;
      }

      // Duplicate — remove it and record where it lives.
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

    cleaned.push({ filename: file.filename, urls });
  }

  // ---- Step 4: drop files left empty after cleaning ---------------------
  const survivors: { filename: string; urls: string[] }[] = [];

  for (const file of cleaned) {
    if (file.urls.length === 0) {
      dropped.push({ filename: file.filename, reason: "empty" });
    } else {
      survivors.push(file);
    }
  }

  // ---- Step 5: rebuild the index ---------------------------------------
  options.onProgress?.({
    stage: "index",
    message: "Building sitemap-index.xml…"
  });

  const indexXml = buildIndexXml(
    options.domain,
    options.subfolder,
    survivors.map((file) => file.filename),
    options.today
  );

  // ---- Step 6: assemble outputs ----------------------------------------
  options.onProgress?.({ stage: "output", message: "Writing cleaned files…" });

  const duplicateUrls = Array.from(dupReport.values());
  const outputFiles: CleanerOutputFile[] = survivors.map((file) => ({
    filename: file.filename,
    content: buildUrlsetXml(file.urls)
  }));

  outputFiles.push({ filename: INDEX_FILENAME, content: indexXml });
  outputFiles.push({
    filename: REPORT_FILENAME,
    content: buildReportCsv(duplicateUrls)
  });

  const result: CleanerResult = {
    files_processed: filesProcessed,
    files_kept: survivors.length,
    files_dropped: dropped.length,
    dropped_files: dropped,
    duplicates_removed: duplicatesRemoved,
    duplicate_urls: duplicateUrls,
    output_files: survivors.map((file) => ({
      filename: file.filename,
      url_count: file.urls.length
    })),
    index_files_detected: indexFilesDetected
  };

  return { result, files: outputFiles };
}
