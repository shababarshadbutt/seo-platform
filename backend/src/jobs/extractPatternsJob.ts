import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { enqueueSamplePatternsJob } from "../queue/sitemapQueue.js";
import { displaySourceFilename } from "../sitemaps/filenames.js";
import { streamSitemapUrlLocs } from "../sitemaps/parser.js";
import { isSessionCancelled } from "./sessionCompletion.js";

const PARAM_SEGMENT_UNIQUE_THRESHOLD = 100;
const PARAM_SEGMENT_UNIQUE_RATIO_THRESHOLD = 0.6;
const PARAM_SEGMENT_MIN_OBSERVED_URLS = 3;
const PARAM_SEGMENT = "{param}";
const MAX_EXTRACT_URLS_PER_FILE = 500;
const COMMON_CONTENT_SEGMENTS = new Set([
  "blog",
  "blogs",
  "brand",
  "brands",
  "catalog",
  "categories",
  "category",
  "manufacturer",
  "manufacturers",
  "news",
  "part",
  "parts",
  "product",
  "products",
  "service",
  "services",
  "shop",
  "store"
]);
const ARTIFACT_SEGMENT_WORDS = [
  "archive",
  "legacy",
  "migration",
  "old",
  "staging",
  "temp",
  "tmp"
];

type SessionRow = {
  id: string;
  base_url: string;
  sample_size: number;
};

type SitemapFileRow = {
  id: string;
  filename: string;
  is_valid: boolean;
  total_urls: string;
  source_role: SitemapSourceRole;
  source_file: string;
};

type PartialUrlRow = {
  url: string;
};

type SitemapSourceRole = "current" | "legacy";

type ParsedUrlPath = {
  sourceUrl: string;
  path: string;
  segments: string[];
  sourceFile: string;
};

type MismatchedUrl = {
  sitemapFileId: string;
  url: string;
  detectedHost: string;
  expectedHost: string;
};

type SourceFileOccurrence = {
  sourceFile: string;
  occurrenceCount: number;
};

type PatternGroup = {
  template: string;
  totalUrls: number;
  coveragePct: number;
  hasSuspiciousSegment: boolean;
  suspiciousSegmentValue: string | null;
  missingInCurrent: boolean;
  sourceFile: string | null;
  sourceFileOccurrences: SourceFileOccurrence[];
};

type PatternUrlPoolEntry = {
  sourceUrl: string;
  path: string;
  sourceFile: string;
};

type PatternUrlPool = {
  seen: number;
  entries: PatternUrlPoolEntry[];
};

type PositionAnalysis = {
  totalUrls: number;
  positionCounts: Array<Map<string, number>>;
  skippedInvalidLocs: number;
  mismatchedUrlCount: number;
};

type PatternExtraction = {
  patternGroups: PatternGroup[];
  patternUrlPools: Map<string, PatternUrlPoolEntry[]>;
  mismatchedUrls: MismatchedUrl[];
  totalUrls: number;
  skippedInvalidLocs: number;
  mismatchedUrlCount: number;
};

type RawPathGroup = {
  segments: string[];
  totalUrls: number;
  sourceFileCounts: Map<string, number>;
  reservoirPool: PatternUrlPool;
};

type OnlinePatternGroup = {
  totalUrls: number;
  sourceFileCounts: Map<string, number>;
  reservoirPool: PatternUrlPool;
};

type PositionTracker = {
  observedUrlCount: number;
  counts: Map<string, number>;
  parameterized: boolean;
};

type ParsedLocResult =
  | {
      kind: "matched";
      urlPath: ParsedUrlPath;
    }
  | {
      kind: "mismatched";
      mismatch: MismatchedUrl;
    };

function normalizeHost(hostname: string) {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function expectedHostFromBaseUrl(baseUrl: string) {
  return normalizeHost(new URL(baseUrl).hostname);
}

function parseLocForExtraction(
  loc: string,
  baseUrl: string,
  expectedHost: string,
  sitemapFileId: string,
  sourceRole: SitemapSourceRole,
  sourceFile: string
): ParsedLocResult | null {
  const raw = loc.trim();

  if (!raw) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    try {
      url = new URL(raw, baseUrl);
    } catch {
      return null;
    }
  }

  const detectedHost = normalizeHost(url.hostname);

  if (sourceRole === "current" && detectedHost !== expectedHost) {
    return {
      kind: "mismatched",
      mismatch: {
        sitemapFileId,
        url: raw,
        detectedHost,
        expectedHost
      }
    };
  }

  const path = `${url.pathname}${url.search}`;

  return {
    kind: "matched",
    urlPath: {
      sourceUrl: raw,
      path: path || "/",
      segments: url.pathname.split("/").filter(Boolean),
      sourceFile
    }
  };
}

function incrementCount(counts: Map<string, number>, value: string) {
  return addCount(counts, value, 1);
}

function addCount(counts: Map<string, number>, value: string, amount: number) {
  const nextCount = (counts.get(value) ?? 0) + amount;

  counts.set(value, nextCount);

  return nextCount;
}

function templateForPath(
  segments: string[],
  parameterizedPositions: ReadonlySet<number>
) {
  if (segments.length === 0) {
    return "/";
  }

  const templateSegments = segments.map((segment, index) =>
    parameterizedPositions.has(index) ? PARAM_SEGMENT : segment
  );

  return `/${templateSegments.join("/")}`;
}

function staticSegmentsForTemplate(template: string) {
  return new Set(
    template
      .split("/")
      .filter((segment) => segment && segment !== PARAM_SEGMENT)
  );
}

function looksLikeInjectedPathArtifact(segment: string, templateCount: number) {
  const normalized = segment.toLowerCase();

  if (COMMON_CONTENT_SEGMENTS.has(normalized)) {
    return false;
  }

  if (templateCount > 1) {
    return true;
  }

  if (ARTIFACT_SEGMENT_WORDS.some((word) => normalized.includes(word))) {
    return true;
  }

  return normalized.includes("-") && normalized.length >= 12;
}

function withSuspiciousSegmentFlags(
  patternGroups: Array<
    Omit<PatternGroup, "hasSuspiciousSegment" | "suspiciousSegmentValue">
  >
): PatternGroup[] {
  const staticSegmentsByTemplate = new Map<string, Set<string>>();
  const segmentTemplateSets = new Map<string, Set<string>>();

  for (const group of patternGroups) {
    const staticSegments = staticSegmentsForTemplate(group.template);

    staticSegmentsByTemplate.set(group.template, staticSegments);

    for (const segment of staticSegments) {
      const templateSet = segmentTemplateSets.get(segment) ?? new Set<string>();

      templateSet.add(group.template);
      segmentTemplateSets.set(segment, templateSet);
    }
  }

  return patternGroups.map((group) => {
    const suspiciousSegments = [
      ...(staticSegmentsByTemplate.get(group.template) ?? new Set<string>())
    ]
      .filter((segment) =>
        looksLikeInjectedPathArtifact(
          segment,
          segmentTemplateSets.get(segment)?.size ?? 0
        )
      )
      .sort((a, b) => a.localeCompare(b));

    return {
      ...group,
      hasSuspiciousSegment: suspiciousSegments.length > 0,
      suspiciousSegmentValue: suspiciousSegments[0] ?? null
    };
  });
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

function buildPatternGroupsFromCounts(
  groupedCounts: Map<string, number>,
  patternSourceFileCounts: Map<string, Map<string, number>>,
  sessionTotalUrls: number
): PatternGroup[] {
  if (sessionTotalUrls === 0) {
    return [];
  }

  const patternGroups = [...groupedCounts.entries()]
    .map(([template, totalUrls]) => {
      const roundedTotalUrls = Math.max(1, Math.round(totalUrls));
      const sourceFileOccurrences = reconcileSourceFileOccurrences(
        patternSourceFileCounts.get(template),
        roundedTotalUrls
      );

      return {
        template,
        totalUrls: roundedTotalUrls,
        coveragePct: Number(
          ((roundedTotalUrls / sessionTotalUrls) * 100).toFixed(4)
        ),
        missingInCurrent: false,
        sourceFile:
          sourceFileOccurrences.map((entry) => entry.sourceFile).join(", ") ||
          null,
        sourceFileOccurrences
      };
    })
    .sort((a, b) => {
      if (b.totalUrls !== a.totalUrls) {
        return b.totalUrls - a.totalUrls;
      }

      return a.template.localeCompare(b.template);
    });

  return withSuspiciousSegmentFlags(patternGroups);
}

// Turn the raw (possibly weighted / extrapolated) per-file counts into integer
// occurrence counts whose sum is exactly the pattern's total_urls. Any rounding
// drift is absorbed by the largest bucket so the invariant
// SUM(pattern_file_occurrences.occurrence_count) === patterns.total_urls holds.
function reconcileSourceFileOccurrences(
  sourceFileCounts: Map<string, number> | undefined,
  roundedTotalUrls: number
): SourceFileOccurrence[] {
  if (!sourceFileCounts || sourceFileCounts.size === 0) {
    return [];
  }

  const occurrences = [...sourceFileCounts.entries()]
    .map(([sourceFile, count]) => ({
      sourceFile,
      occurrenceCount: Math.max(0, Math.round(count))
    }))
    .sort(
      (a, b) =>
        b.occurrenceCount - a.occurrenceCount ||
        a.sourceFile.localeCompare(b.sourceFile)
    );
  const sum = occurrences.reduce(
    (total, entry) => total + entry.occurrenceCount,
    0
  );
  const drift = roundedTotalUrls - sum;

  if (drift !== 0 && occurrences.length > 0) {
    occurrences[0].occurrenceCount = Math.max(
      0,
      occurrences[0].occurrenceCount + drift
    );
  }

  return occurrences;
}

function patternUrlPoolSize(sampleSize: number) {
  return Math.max(
    sampleSize * config.patternUrlPoolMultiplier,
    config.patternUrlPoolMinSize
  );
}

function addReservoirEntry(
  pool: PatternUrlPool,
  entry: PatternUrlPoolEntry,
  poolSize: number
) {
  pool.seen += 1;

  if (pool.entries.length < poolSize) {
    pool.entries.push(entry);
    return;
  }

  const replacementIndex = Math.floor(Math.random() * pool.seen);

  if (replacementIndex < poolSize) {
    pool.entries[replacementIndex] = entry;
  }
}

function rawPathGroupKey(segments: string[]) {
  return segments.join("\u0000");
}

function mergeSourceFileCounts(
  target: Map<string, number>,
  source: Map<string, number>
) {
  for (const [sourceFile, count] of source.entries()) {
    target.set(sourceFile, (target.get(sourceFile) ?? 0) + count);
  }
}

function segmentsFromTemplate(template: string) {
  return template === "/" ? [] : template.slice(1).split("/");
}

function shouldParameterizeTracker(tracker: PositionTracker) {
  const uniqueRatio =
    tracker.observedUrlCount === 0
      ? 0
      : tracker.counts.size / tracker.observedUrlCount;

  return (
    tracker.counts.size > PARAM_SEGMENT_UNIQUE_THRESHOLD ||
    (tracker.observedUrlCount >= PARAM_SEGMENT_MIN_OBSERVED_URLS &&
      uniqueRatio >= PARAM_SEGMENT_UNIQUE_RATIO_THRESHOLD)
  );
}

function updatePositionTrackers(
  segments: string[],
  positionTrackers: PositionTracker[],
  parameterizedPositions: Set<number>
) {
  let changed = false;

  segments.forEach((segment, index) => {
    const tracker = positionTrackers[index] ?? {
      observedUrlCount: 0,
      counts: new Map<string, number>(),
      parameterized: false
    };

    tracker.observedUrlCount += 1;

    if (!tracker.parameterized) {
      incrementCount(tracker.counts, segment);

      if (shouldParameterizeTracker(tracker)) {
        tracker.parameterized = true;
        tracker.counts.clear();
        parameterizedPositions.add(index);
        changed = true;
      }
    }

    positionTrackers[index] = tracker;
  });

  return changed;
}

function mergeReservoirPool(
  target: PatternUrlPool,
  source: PatternUrlPool,
  poolSize: number
) {
  for (const entry of source.entries) {
    addReservoirEntry(target, entry, poolSize);
  }
}

function rebuildOnlinePatternGroups(
  groups: Map<string, OnlinePatternGroup>,
  parameterizedPositions: ReadonlySet<number>,
  poolSize: number
) {
  const rebuilt = new Map<string, OnlinePatternGroup>();

  for (const [template, group] of groups.entries()) {
    const nextTemplate = templateForPath(
      segmentsFromTemplate(template),
      parameterizedPositions
    );
    const target = rebuilt.get(nextTemplate) ?? {
      totalUrls: 0,
      sourceFileCounts: new Map<string, number>(),
      reservoirPool: {
        seen: 0,
        entries: []
      }
    };

    target.totalUrls += group.totalUrls;
    mergeSourceFileCounts(target.sourceFileCounts, group.sourceFileCounts);
    mergeReservoirPool(target.reservoirPool, group.reservoirPool, poolSize);
    rebuilt.set(nextTemplate, target);
  }

  return rebuilt;
}

async function loadPartialUrlLocs(sitemapFileId: string) {
  const result = await pool.query<PartialUrlRow>(
    `
      SELECT url
      FROM sitemap_partial_urls
      WHERE sitemap_file_id = $1
      ORDER BY loc_order ASC
    `,
    [sitemapFileId]
  );

  return result.rows.map((row) => row.url);
}

async function streamParsedUrlPaths(
  files: SitemapFileRow[],
  baseUrl: string,
  expectedHost: string,
  onUrlPath: (urlPath: ParsedUrlPath, weight: number) => void,
  onMismatchedUrl?: (mismatch: MismatchedUrl) => void,
  options: {
    maxUrlsPerFile?: number;
  } = {}
) {
  let skippedInvalidLocs = 0;
  let mismatchedUrlCount = 0;

  for (const file of files) {
    const locs = file.is_valid ? null : await loadPartialUrlLocs(file.id);
    const fileTotalUrls = Number(file.total_urls);
    const maxUrlsPerFile = options.maxUrlsPerFile;
    const shouldSampleFile =
      maxUrlsPerFile !== undefined &&
      Number.isFinite(fileTotalUrls) &&
      fileTotalUrls > maxUrlsPerFile;
    const fileWeight = shouldSampleFile ? fileTotalUrls / maxUrlsPerFile : 1;
    let processedLocCount = 0;
    const handleLoc = (loc: string) => {
      if (
        maxUrlsPerFile !== undefined &&
        processedLocCount >= maxUrlsPerFile
      ) {
        return false;
      }

      processedLocCount += 1;
      const parsedLoc = parseLocForExtraction(
        loc,
        baseUrl,
        expectedHost,
        file.id,
        file.source_role,
        file.source_file
      );

      if (!parsedLoc) {
        skippedInvalidLocs += 1;
        return;
      }

      if (parsedLoc.kind === "mismatched") {
        mismatchedUrlCount += fileWeight;
        onMismatchedUrl?.(parsedLoc.mismatch);
        return undefined;
      }

      onUrlPath(parsedLoc.urlPath, fileWeight);

      return undefined;
    };

    if (locs) {
      for (const loc of locs) {
        if (handleLoc(loc) === false) {
          break;
        }
      }
    } else {
      await streamSitemapUrlLocs(file.filename, handleLoc);
    }
  }

  return {
    skippedInvalidLocs,
    mismatchedUrlCount: Math.round(mismatchedUrlCount)
  };
}

async function analyzeSegmentPositions(
  files: SitemapFileRow[],
  baseUrl: string,
  expectedHost: string
): Promise<PositionAnalysis> {
  const positionCounts: Array<Map<string, number>> = [];
  let totalUrls = 0;
  const streamResult = await streamParsedUrlPaths(
    files,
    baseUrl,
    expectedHost,
    (urlPath, weight) => {
      totalUrls += weight;

      urlPath.segments.forEach((segment, index) => {
        const counts = positionCounts[index] ?? new Map<string, number>();

        incrementCount(counts, segment);
        positionCounts[index] = counts;
      });
    }
  );

  return {
    totalUrls,
    positionCounts,
    skippedInvalidLocs: streamResult.skippedInvalidLocs,
    mismatchedUrlCount: streamResult.mismatchedUrlCount
  };
}

async function extractPatternGroupsAndPools(
  files: SitemapFileRow[],
  baseUrl: string,
  expectedHost: string,
  parameterizedPositions: ReadonlySet<number>,
  sessionTotalUrls: number,
  poolSize: number
): Promise<PatternExtraction> {
  const groupedCounts = new Map<string, number>();
  const reservoirPools = new Map<string, PatternUrlPool>();
  const patternSourceFileCounts = new Map<string, Map<string, number>>();
  const mismatchedUrls: MismatchedUrl[] = [];
  const streamResult = await streamParsedUrlPaths(
    files,
    baseUrl,
    expectedHost,
    (urlPath) => {
      const template = templateForPath(urlPath.segments, parameterizedPositions);
      const seenForPattern = incrementCount(groupedCounts, template);
      const sourceCounts = patternSourceFileCounts.get(template) ?? new Map();

      incrementCount(sourceCounts, urlPath.sourceFile);
      patternSourceFileCounts.set(template, sourceCounts);

      const pool = reservoirPools.get(template) ?? {
        seen: 0,
        entries: []
      };

      pool.seen = seenForPattern - 1;
      addReservoirEntry(
        pool,
        {
          sourceUrl: urlPath.sourceUrl,
          path: urlPath.path,
          sourceFile: urlPath.sourceFile
        },
        poolSize
      );
      reservoirPools.set(template, pool);
    },
    (mismatch) => {
      mismatchedUrls.push(mismatch);
    }
  );
  const patternUrlPools = new Map<string, PatternUrlPoolEntry[]>();

  for (const [template, reservoirPool] of reservoirPools.entries()) {
    patternUrlPools.set(template, reservoirPool.entries);
  }

  return {
    patternGroups: buildPatternGroupsFromCounts(
      groupedCounts,
      patternSourceFileCounts,
      sessionTotalUrls
    ),
    patternUrlPools,
    mismatchedUrls,
    totalUrls: sessionTotalUrls,
    skippedInvalidLocs: streamResult.skippedInvalidLocs,
    mismatchedUrlCount: streamResult.mismatchedUrlCount
  };
}

async function extractPatternGroupsSinglePass(
  files: SitemapFileRow[],
  baseUrl: string,
  expectedHost: string,
  poolSize: number
): Promise<PatternExtraction> {
  const positionTrackers: PositionTracker[] = [];
  let onlineGroups = new Map<string, OnlinePatternGroup>();
  const parameterizedPositions = new Set<number>();
  const mismatchedUrls: MismatchedUrl[] = [];
  let totalUrls = 0;

  const streamResult = await streamParsedUrlPaths(
    files,
    baseUrl,
    expectedHost,
    (urlPath, weight) => {
      totalUrls += weight;

      if (
        updatePositionTrackers(
          urlPath.segments,
          positionTrackers,
          parameterizedPositions
        )
      ) {
        onlineGroups = rebuildOnlinePatternGroups(
          onlineGroups,
          parameterizedPositions,
          poolSize
        );
      }

      const template = templateForPath(
        urlPath.segments,
        parameterizedPositions
      );
      const group = onlineGroups.get(template) ?? {
        totalUrls: 0,
        sourceFileCounts: new Map<string, number>(),
        reservoirPool: {
          seen: 0,
          entries: []
        }
      };

      group.totalUrls += weight;
      addCount(group.sourceFileCounts, urlPath.sourceFile, weight);
      addReservoirEntry(
        group.reservoirPool,
        {
          sourceUrl: urlPath.sourceUrl,
          path: urlPath.path,
          sourceFile: urlPath.sourceFile
        },
        poolSize
      );
      onlineGroups.set(template, group);
    },
    (mismatch) => {
      mismatchedUrls.push(mismatch);
    },
    {
      maxUrlsPerFile: MAX_EXTRACT_URLS_PER_FILE
    }
  );
  const groupedCounts = new Map<string, number>();
  const patternSourceFileCounts = new Map<string, Map<string, number>>();

  for (const [template, group] of onlineGroups.entries()) {
    groupedCounts.set(template, group.totalUrls);
    patternSourceFileCounts.set(template, group.sourceFileCounts);
  }

  const patternUrlPools = new Map<string, PatternUrlPoolEntry[]>();

  for (const [template, group] of onlineGroups.entries()) {
    patternUrlPools.set(template, group.reservoirPool.entries);
  }

  return {
    patternGroups: buildPatternGroupsFromCounts(
      groupedCounts,
      patternSourceFileCounts,
      totalUrls
    ),
    patternUrlPools,
    mismatchedUrls,
    totalUrls,
    skippedInvalidLocs: streamResult.skippedInvalidLocs,
    mismatchedUrlCount: streamResult.mismatchedUrlCount
  };
}

async function persistPatternGroups(
  sessionId: string,
  sourceRole: SitemapSourceRole,
  patternGroups: PatternGroup[],
  patternUrlPools: Map<string, PatternUrlPoolEntry[]>,
  mismatchedUrls: MismatchedUrl[]
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        DELETE FROM sampled_urls
        USING patterns
        WHERE sampled_urls.pattern_id = patterns.id
          AND patterns.session_id = $1
          AND patterns.source_role = $2
      `,
      [sessionId, sourceRole]
    );
    await client.query(
      `
        DELETE FROM pattern_urls
        USING patterns
        WHERE pattern_urls.pattern_id = patterns.id
          AND patterns.session_id = $1
          AND patterns.source_role = $2
      `,
      [sessionId, sourceRole]
    );
    await client.query(
      `
        DELETE FROM pattern_file_occurrences
        USING patterns
        WHERE pattern_file_occurrences.pattern_id = patterns.id
          AND patterns.session_id = $1
          AND patterns.source_role = $2
      `,
      [sessionId, sourceRole]
    );

    if (sourceRole === "current") {
      await client.query(
        `
          DELETE FROM mismatched_urls
          USING sitemap_files
          WHERE mismatched_urls.sitemap_file_id = sitemap_files.id
            AND sitemap_files.session_id = $1
            AND sitemap_files.source_role = 'current'
        `,
        [sessionId]
      );
      await client.query(
        `
          UPDATE sitemap_files
          SET mismatched_url_count = 0
          WHERE session_id = $1 AND source_role = 'current'
        `,
        [sessionId]
      );
    }

    if (patternGroups.length === 0) {
      await client.query(
        "DELETE FROM patterns WHERE session_id = $1 AND source_role = $2",
        [sessionId, sourceRole]
      );
    } else {
      await client.query(
        `
          DELETE FROM patterns
          WHERE session_id = $1
            AND source_role = $2
            AND NOT (template = ANY($3::text[]))
        `,
        [sessionId, sourceRole, patternGroups.map((group) => group.template)]
      );
    }

    const patternIds = new Map<string, string>();

    for (const group of patternGroups) {
      const patternResult = await client.query<{ id: string }>(
        `
          INSERT INTO patterns (
            session_id,
            source_role,
            template,
            total_urls,
            coverage_pct,
            confidence_pct,
            status,
            has_suspicious_segment,
            suspicious_segment_value,
            redirect_pct,
            missing_in_current,
            source_file
          )
          VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, NULL, $8, $9)
          ON CONFLICT (session_id, source_role, template)
          DO UPDATE SET
            total_urls = EXCLUDED.total_urls,
            coverage_pct = EXCLUDED.coverage_pct,
            confidence_pct = NULL,
            status = NULL,
            has_suspicious_segment = EXCLUDED.has_suspicious_segment,
            suspicious_segment_value = EXCLUDED.suspicious_segment_value,
            redirect_pct = NULL,
            missing_in_current = EXCLUDED.missing_in_current,
            source_file = EXCLUDED.source_file
          RETURNING id
        `,
        [
          sessionId,
          sourceRole,
          group.template,
          group.totalUrls,
          group.coveragePct,
          group.hasSuspiciousSegment,
          group.suspiciousSegmentValue,
          group.missingInCurrent,
          group.sourceFile
        ]
      );

      patternIds.set(group.template, patternResult.rows[0].id);
    }

    for (const group of patternGroups) {
      const patternId = patternIds.get(group.template);
      const entries = patternUrlPools.get(group.template) ?? [];

      if (!patternId || entries.length === 0) {
        continue;
      }

      await client.query(
        `
          INSERT INTO pattern_urls (
            session_id,
            pattern_id,
            source_url,
            path
          )
          SELECT $1, $2, item.source_url, item.path
          FROM UNNEST($3::text[], $4::text[]) AS item(source_url, path)
        `,
        [
          sessionId,
          patternId,
          entries.map((entry) => entry.sourceUrl),
          entries.map((entry) => entry.path)
        ]
      );
    }

    for (const group of patternGroups) {
      const patternId = patternIds.get(group.template);

      if (!patternId || group.sourceFileOccurrences.length === 0) {
        continue;
      }

      await client.query(
        `
          INSERT INTO pattern_file_occurrences (
            pattern_id,
            source_file,
            occurrence_count
          )
          SELECT $1, item.source_file, item.occurrence_count
          FROM UNNEST($2::text[], $3::bigint[])
            AS item(source_file, occurrence_count)
        `,
        [
          patternId,
          group.sourceFileOccurrences.map((entry) => entry.sourceFile),
          group.sourceFileOccurrences.map((entry) => entry.occurrenceCount)
        ]
      );
    }

    if (sourceRole === "current" && mismatchedUrls.length > 0) {
      await client.query(
        `
          INSERT INTO mismatched_urls (
            sitemap_file_id,
            url,
            detected_host,
            expected_host
          )
          SELECT
            item.sitemap_file_id,
            item.url,
            item.detected_host,
            item.expected_host
          FROM UNNEST(
            $1::uuid[],
            $2::text[],
            $3::text[],
            $4::text[]
          ) AS item(sitemap_file_id, url, detected_host, expected_host)
        `,
        [
          mismatchedUrls.map((mismatch) => mismatch.sitemapFileId),
          mismatchedUrls.map((mismatch) => mismatch.url),
          mismatchedUrls.map((mismatch) => mismatch.detectedHost),
          mismatchedUrls.map((mismatch) => mismatch.expectedHost)
        ]
      );

      const mismatchCounts = mismatchedUrls.reduce((counts, mismatch) => {
        counts.set(
          mismatch.sitemapFileId,
          (counts.get(mismatch.sitemapFileId) ?? 0) + 1
        );

        return counts;
      }, new Map<string, number>());

      await client.query(
        `
          UPDATE sitemap_files
          SET mismatched_url_count = item.mismatch_count
          FROM UNNEST($1::uuid[], $2::bigint[])
            AS item(sitemap_file_id, mismatch_count)
          WHERE sitemap_files.id = item.sitemap_file_id
        `,
        [
          [...mismatchCounts.keys()],
          [...mismatchCounts.values()]
        ]
      );
    }

    await client.query(
      "UPDATE sessions SET status = 'EXTRACTED' WHERE id = $1",
      [sessionId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hasPendingSitemapFiles(sessionId: string) {
  const result = await pool.query(
    `
      SELECT 1
      FROM sitemap_files
      WHERE session_id = $1
        AND parsed_at IS NULL
      LIMIT 1
    `,
    [sessionId]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

async function loadExtractableFiles(
  sessionId: string,
  sourceRole: SitemapSourceRole
) {
  const result = await pool.query<SitemapFileRow>(
    `
      SELECT id, filename, is_valid, total_urls, source_role
      FROM sitemap_files
      WHERE session_id = $1
        AND source_role = $2
        AND parsed_at IS NOT NULL
        AND is_index = FALSE
        AND (
          (is_valid = TRUE AND is_empty = FALSE)
          OR EXISTS (
            SELECT 1
            FROM sitemap_partial_urls
            WHERE sitemap_partial_urls.sitemap_file_id = sitemap_files.id
          )
        )
      ORDER BY filename ASC, id ASC
    `,
      [sessionId, sourceRole]
  );

  return result.rows.map((row) => ({
    ...row,
    source_file: displaySourceFilename(sessionId, row.filename)
  }));
}

async function updateMissingContentFlags(sessionId: string) {
  await pool.query(
    `
      UPDATE patterns AS legacy_patterns
      SET missing_in_current = NOT EXISTS (
        SELECT 1
        FROM patterns AS current_patterns
        WHERE current_patterns.session_id = legacy_patterns.session_id
          AND current_patterns.source_role = 'current'
          AND current_patterns.template = legacy_patterns.template
      )
      WHERE legacy_patterns.session_id = $1
        AND legacy_patterns.source_role = 'legacy'
    `,
    [sessionId]
  );
}

export async function processExtractPatternsJob(
  data: { sitemap_file_id: string; session_id: string },
  logger: FastifyBaseLogger
) {
  if (await isSessionCancelled(data.session_id)) {
    logger.info(
      { session_id: data.session_id },
      "extract patterns job skipped — session cancelled"
    );
    return;
  }

  const sessionResult = await pool.query<SessionRow>(
    `
      SELECT id, base_url, sample_size
      FROM sessions
      WHERE id = $1
    `,
    [data.session_id]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new Error(`Session not found: ${data.session_id}`);
  }

  logger.info(
    {
      session_id: data.session_id,
      sitemap_file_id: data.sitemap_file_id
    },
    "extract patterns job started"
  );

  await pool.query("UPDATE sessions SET status = 'EXTRACTING' WHERE id = $1", [
    data.session_id
  ]);

  try {
    const expectedHost = expectedHostFromBaseUrl(session.base_url);
    const extractionSummaries: Array<{
      sourceRole: SitemapSourceRole;
      fileCount: number;
      totalUrls: number;
      mismatchedUrlCount: number;
      patternCount: number;
      suspiciousPatternCount: number;
      skippedInvalidLocs: number;
    }> = [];

    for (const sourceRole of ["current", "legacy"] as const) {
      const files = await loadExtractableFiles(data.session_id, sourceRole);
      const extraction = await extractPatternGroupsSinglePass(
        files,
        session.base_url,
        expectedHost,
        patternUrlPoolSize(session.sample_size)
      );
      const skippedInvalidLocs = extraction.skippedInvalidLocs;

      if (skippedInvalidLocs > 0) {
        logger.warn(
          {
            source_role: sourceRole,
            skipped_invalid_locs: skippedInvalidLocs
          },
          "skipped invalid sitemap loc values during pattern extraction"
        );
      }

      await persistPatternGroups(
        data.session_id,
        sourceRole,
        extraction.patternGroups,
        extraction.patternUrlPools,
        extraction.mismatchedUrls
      );

      extractionSummaries.push({
        sourceRole,
        fileCount: files.length,
        totalUrls: extraction.totalUrls,
        mismatchedUrlCount: extraction.mismatchedUrlCount,
        patternCount: extraction.patternGroups.length,
        suspiciousPatternCount: extraction.patternGroups.filter(
          (group) => group.hasSuspiciousSegment
        ).length,
        skippedInvalidLocs
      });
    }

    await updateMissingContentFlags(data.session_id);

    const hasPendingFiles = await hasPendingSitemapFiles(data.session_id);

    if (!hasPendingFiles) {
      await enqueueSamplePatternsJob({
        session_id: data.session_id,
        sitemap_file_id: data.sitemap_file_id
      });
    }

    logger.info(
      {
        session_id: data.session_id,
        sitemap_file_id: data.sitemap_file_id,
        extraction_summaries: extractionSummaries,
        pattern_url_pool_size: patternUrlPoolSize(session.sample_size),
        sample_job_enqueued: !hasPendingFiles
      },
      "extract patterns job completed"
    );
  } catch (error) {
    await pool.query("UPDATE sessions SET status = 'FAILED' WHERE id = $1", [
      data.session_id
    ]);
    throw error;
  }
}
