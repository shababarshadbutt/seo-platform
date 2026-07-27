import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { sanitizeUploadedFilename } from "./filenames.js";
import {
  parseSitemapSource,
  requestSitemapUrl,
  streamSitemapUrlLocs
} from "./parser.js";

const PARAM_SEGMENT_UNIQUE_THRESHOLD = 100;
const PARAM_SEGMENT_UNIQUE_RATIO_THRESHOLD = 0.6;
const PARAM_SEGMENT_MIN_OBSERVED_URLS = 3;
const PARAM_SEGMENT = "{param}";

type FetchSitemapPreviewResult = {
  filename: string;
  total_urls: number;
  is_index: boolean;
  is_valid: boolean;
  preview_patterns: string[];
  parse_error: string | null;
  had_preamble_stripped: boolean;
};

function isGzipName(value: string) {
  return value.toLowerCase().endsWith(".gz");
}

// The TRUE source filename for a sitemap fetched from a URL: the basename of
// its path. This is what the file is really called on the client's site, so it
// is what publishing must write back — recorded via original_filename
// (migration 031) rather than recovered from our internal stored name later.
// Exported so the ingestion routes use exactly the same rule the download does,
// with no second implementation to drift.
export function sourceFilenameFromUrl(url: string, isDecodedGzip = false) {
  const parsedUrl = new URL(url);
  const baseName = path.posix.basename(parsedUrl.pathname) || "sitemap.xml";
  const decodedBaseName =
    isDecodedGzip && isGzipName(baseName) ? baseName.slice(0, -3) : baseName;
  const withExtension = path.extname(decodedBaseName)
    ? decodedBaseName
    : `${decodedBaseName}.xml`;

  return sanitizeUploadedFilename(withExtension);
}

function downloadedFilename(url: string, isDecodedGzip: boolean) {
  return `fetched-${Date.now()}-${randomUUID()}-${sourceFilenameFromUrl(
    url,
    isDecodedGzip
  )}`;
}

function parseUrlPath(loc: string) {
  try {
    const url = new URL(loc.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.pathname.split("/").filter(Boolean);
  } catch {
    return null;
  }
}

function incrementCount(counts: Map<string, number>, value: string) {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function parameterizedPositionsFromCounts(
  positionCounts: Array<Map<string, number>>
) {
  const parameterizedPositions = new Set<number>();

  positionCounts.forEach((counts, index) => {
    const observedUrlCount = [...counts.values()].reduce(
      (total, count) => total + count,
      0
    );
    const uniqueRatio =
      observedUrlCount === 0 ? 0 : counts.size / observedUrlCount;

    if (
      counts.size > PARAM_SEGMENT_UNIQUE_THRESHOLD ||
      (observedUrlCount >= PARAM_SEGMENT_MIN_OBSERVED_URLS &&
        uniqueRatio >= PARAM_SEGMENT_UNIQUE_RATIO_THRESHOLD)
    ) {
      parameterizedPositions.add(index);
    }
  });

  return parameterizedPositions;
}

function templateForSegments(
  segments: string[],
  parameterizedPositions: ReadonlySet<number>
) {
  if (segments.length === 0) {
    return "/";
  }

  return `/${segments
    .map((segment, index) =>
      parameterizedPositions.has(index) ? PARAM_SEGMENT : segment
    )
    .join("/")}`;
}

async function buildPreviewPatterns(filename: string) {
  const positionCounts: Array<Map<string, number>> = [];

  await streamSitemapUrlLocs(filename, (loc) => {
    const segments = parseUrlPath(loc);

    if (!segments) {
      return;
    }

    segments.forEach((segment, index) => {
      const counts = positionCounts[index] ?? new Map<string, number>();

      incrementCount(counts, segment);
      positionCounts[index] = counts;
    });
  });

  const parameterizedPositions =
    parameterizedPositionsFromCounts(positionCounts);
  const groupedCounts = new Map<string, number>();

  await streamSitemapUrlLocs(filename, (loc) => {
    const segments = parseUrlPath(loc);

    if (!segments) {
      return;
    }

    const template = templateForSegments(segments, parameterizedPositions);

    incrementCount(groupedCounts, template);
  });

  return [...groupedCounts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }

      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5)
    .map(([template]) => template);
}

export async function fetchSitemapPreview(
  sitemapUrl: string
): Promise<FetchSitemapPreviewResult> {
  const response = await requestSitemapUrl(sitemapUrl);
  const shouldDecodeGzip = response.contentEncoding.includes("gzip");
  const filename = downloadedFilename(response.finalUrl, shouldDecodeGzip);
  const filePath = path.join(config.uploadDir, filename);

  await mkdir(config.uploadDir, {
    recursive: true
  });

  await pipeline(
    shouldDecodeGzip ? response.stream.pipe(createGunzip()) : response.stream,
    createWriteStream(filePath)
  );

  const parsed = await parseSitemapSource(filename);
  const isIndex = parsed.rootElement === "sitemapindex";
  const hasSitemapRoot = parsed.rootElement === "urlset" || isIndex;
  const isValid = parsed.isValid && hasSitemapRoot;
  const previewPatterns =
    isValid && !isIndex ? await buildPreviewPatterns(filename) : [];

  return {
    filename,
    total_urls: parsed.totalUrls,
    is_index: isIndex,
    is_valid: isValid,
    preview_patterns: previewPatterns,
    parse_error:
      parsed.parseError ??
      (hasSitemapRoot ? null : "URL did not return a sitemap XML document."),
    had_preamble_stripped: parsed.hadPreambleStripped
  };
}
