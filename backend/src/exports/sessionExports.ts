import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Parser } from "@json2csv/plainjs";
import ExcelJS from "exceljs";
import { chromium } from "playwright-core";

import { config } from "../config.js";
import { pool } from "../db/pool.js";

export type ExportFormat = "csv" | "xlsx" | "pdf";

type SessionExportRow = {
  id: string;
  name: string;
  base_url: string;
  status: string;
  created_at: string | Date;
  total_urls: string;
  mismatched_url_count: string;
};

type PatternExportRow = {
  id: string;
  source_role: string;
  template: string;
  total_urls: string;
  coverage_pct: string;
  confidence_pct: string;
  status: string;
  has_suspicious_segment: boolean;
  suspicious_segment_value: string | null;
  redirect_pct: string;
  missing_in_current: boolean;
  source_file: string | null;
  original_template: string | null;
  sampled_count: string;
  hit_count: string;
  miss_count: string;
};

type SampleExportRow = {
  pattern_id: string;
  pattern_template: string;
  url: string;
  http_status: number | null;
  response_ms: number | null;
  is_hit: boolean;
  is_soft_404: boolean;
  checked_at: string | Date | null;
  final_url: string | null;
  redirect_count: number;
  http_status_category: string | null;
  source_file: string | null;
};

type MismatchExportRow = {
  filename: string;
  url: string;
  detected_host: string;
  expected_host: string;
  created_at: string | Date;
};

type SessionExportData = {
  session: SessionExportRow;
  patterns: PatternExportRow[];
  samples: SampleExportRow[];
  mismatches: MismatchExportRow[];
};

export type GeneratedExport = {
  filePath: string;
  fileName: string;
  mimeType: string;
};

export class SessionExportNotFoundError extends Error {
  constructor() {
    super("session not found");
  }
}

function numberValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function roundOne(value: number) {
  return Number(value.toFixed(1));
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toISOString();
}

function formatHumanUtcDate(value: string | Date | null | undefined) {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((current, part) => {
      current[part.type] = part.value;
      return current;
    }, {});

  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} UTC`;
}

function dateStamp(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);

  return date.toISOString().slice(0, 10);
}

function safeFilenamePart(value: string) {
  const cleaned = value
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return cleaned || "session";
}

function exportFilename(data: SessionExportData, format: ExportFormat) {
  const prefix = `${safeFilenamePart(data.session.name)}-${dateStamp(
    data.session.created_at
  )}`;

  if (format === "csv") {
    return `${prefix}-patterns.csv`;
  }

  return `${prefix}-report.${format}`;
}

function healthScore(patterns: PatternExportRow[]) {
  const currentPatterns = patterns.filter(
    (pattern) => pattern.source_role === "current"
  );
  const coverageTotal = currentPatterns.reduce(
    (total, pattern) => total + numberValue(pattern.coverage_pct),
    0
  );

  if (coverageTotal <= 0) {
    return 0;
  }

  const weightedTotal = currentPatterns.reduce(
    (total, pattern) =>
      total +
      numberValue(pattern.confidence_pct) * numberValue(pattern.coverage_pct),
    0
  );

  return Math.round(weightedTotal / coverageTotal);
}

function patternCounts(patterns: PatternExportRow[]) {
  const currentPatterns = patterns.filter(
    (pattern) => pattern.source_role === "current"
  );

  return {
    healthy: currentPatterns.filter((pattern) => pattern.status === "GOOD")
      .length,
    warning: currentPatterns.filter((pattern) => pattern.status === "WARNING")
      .length,
    broken: currentPatterns.filter((pattern) => pattern.status === "BAD").length
  };
}

const PATTERN_SAMPLE_URL_PREVIEW_COUNT = 3;

// First N sampled URLs per pattern, preserving the samples query ordering.
function sampleUrlsByPattern(samples: SampleExportRow[], limit: number) {
  const byPattern = new Map<string, string[]>();

  for (const sample of samples) {
    const urls = byPattern.get(sample.pattern_id) ?? [];

    if (urls.length < limit) {
      urls.push(sample.url);
      byPattern.set(sample.pattern_id, urls);
    }
  }

  return byPattern;
}

function patternTableRows(
  patterns: PatternExportRow[],
  samples: SampleExportRow[]
) {
  const sampleUrls = sampleUrlsByPattern(
    samples,
    PATTERN_SAMPLE_URL_PREVIEW_COUNT
  );

  return patterns.map((pattern) => ({
    Role: pattern.source_role === "legacy" ? "Legacy" : "Current",
    Pattern: pattern.template,
    // Blank unless the pattern was renamed; the Excel Patterns sheet surfaces
    // this column (the CSV field list omits it to stay compact).
    "Original Template": pattern.original_template ?? "",
    "Source File": pattern.source_file ?? "",
    // Occurrences, not distinct URLs — the same URL can appear in multiple files.
    "URL Occurrences": numberValue(pattern.total_urls),
    "Coverage %": roundOne(numberValue(pattern.coverage_pct)),
    Sampled: numberValue(pattern.sampled_count),
    Hit: numberValue(pattern.hit_count),
    Miss: numberValue(pattern.miss_count),
    "Confidence %": roundOne(numberValue(pattern.confidence_pct)),
    "Redirect %": roundOne(numberValue(pattern.redirect_pct)),
    Status: pattern.status,
    "Missing In Current": pattern.missing_in_current ? "Yes" : "No",
    "Suspicious Segment": pattern.has_suspicious_segment
      ? pattern.suspicious_segment_value ?? "Yes"
      : "No",
    "Sample URLs": (sampleUrls.get(pattern.id) ?? []).join(", ")
  }));
}

function sampleTableRows(samples: SampleExportRow[]) {
  return samples.map((sample) => ({
    Pattern: sample.pattern_template,
    "Source File": sample.source_file ?? "",
    URL: sample.url,
    "HTTP Status": sample.http_status ?? "",
    "Response Time (ms)": sample.response_ms ?? "",
    Category: sample.http_status_category ?? "",
    "Soft-404": sample.is_soft_404 ? "Yes" : "No",
    "Final URL": sample.final_url ?? "",
    "Redirect Count": sample.redirect_count,
    Hit: sample.is_hit ? "Yes" : "No",
    "Checked At": formatDate(sample.checked_at)
  }));
}

function mismatchTableRows(mismatches: MismatchExportRow[]) {
  return mismatches.map((mismatch) => ({
    URL: mismatch.url,
    "Detected Host": mismatch.detected_host,
    "Expected Host": mismatch.expected_host,
    "Sitemap File": mismatch.filename,
    "Found At": formatDate(mismatch.created_at)
  }));
}

function autosizeColumns(worksheet: ExcelJS.Worksheet) {
  worksheet.columns.forEach((column) => {
    let maxLength = 12;

    if (typeof column.eachCell === "function") {
      column.eachCell({ includeEmpty: true }, (cell) => {
        const text = String(cell.value ?? "");

        maxLength = Math.max(maxLength, Math.min(text.length, 60));
      });
    }

    column.width = maxLength + 2;
  });
}

function addObjectSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: Record<string, string | number>[]
) {
  const worksheet = workbook.addWorksheet(name);
  const headers = rows[0] ? Object.keys(rows[0]) : [];

  worksheet.columns = headers.map((header) => ({
    header,
    key: header
  }));
  worksheet.addRows(rows);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  autosizeColumns(worksheet);
}

async function loadSessionExportData(
  sessionId: string
): Promise<SessionExportData> {
  const sessionResult = await pool.query<SessionExportRow>(
    `
      SELECT
        sessions.id,
        sessions.name,
        sessions.base_url,
        sessions.status,
        sessions.created_at,
        COALESCE(
          SUM(sitemap_files.total_urls)
            FILTER (WHERE sitemap_files.source_role = 'current'),
          0
        )::bigint AS total_urls,
        COALESCE(
          SUM(sitemap_files.mismatched_url_count)
            FILTER (WHERE sitemap_files.source_role = 'current'),
          0
        )::bigint
          AS mismatched_url_count
      FROM sessions
      LEFT JOIN sitemap_files
        ON sitemap_files.session_id = sessions.id
      WHERE sessions.id = $1
      GROUP BY sessions.id
    `,
    [sessionId]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new SessionExportNotFoundError();
  }

  const patternsResult = await pool.query<PatternExportRow>(
    `
      SELECT
        patterns.id,
        patterns.source_role,
        patterns.template,
        patterns.total_urls,
        patterns.coverage_pct,
        patterns.confidence_pct,
        patterns.status,
        patterns.has_suspicious_segment,
        patterns.suspicious_segment_value,
        patterns.redirect_pct,
        patterns.missing_in_current,
        patterns.source_file,
        (
          SELECT old_template
          FROM pattern_renames
          WHERE pattern_renames.pattern_id = patterns.id
          ORDER BY renamed_at DESC
          LIMIT 1
        ) AS original_template,
        COUNT(sampled_urls.id)::bigint AS sampled_count,
        COUNT(sampled_urls.id) FILTER (WHERE sampled_urls.is_hit)::bigint
          AS hit_count,
        COUNT(sampled_urls.id) FILTER (
          WHERE sampled_urls.id IS NOT NULL AND NOT sampled_urls.is_hit
        )::bigint AS miss_count
      FROM patterns
      LEFT JOIN sampled_urls
        ON sampled_urls.pattern_id = patterns.id
      WHERE patterns.session_id = $1
      GROUP BY patterns.id
      ORDER BY
        CASE patterns.source_role WHEN 'current' THEN 0 ELSE 1 END,
        patterns.missing_in_current DESC,
        patterns.total_urls DESC,
        patterns.template ASC
    `,
    [sessionId]
  );

  const samplesResult = await pool.query<SampleExportRow>(
    `
      SELECT
        patterns.id AS pattern_id,
        patterns.template AS pattern_template,
        sampled_urls.url,
        sampled_urls.http_status,
        sampled_urls.response_ms,
        sampled_urls.is_hit,
        sampled_urls.is_soft_404,
        sampled_urls.checked_at,
        sampled_urls.final_url,
        sampled_urls.redirect_count,
        sampled_urls.http_status_category,
        sampled_urls.source_file
      FROM sampled_urls
      INNER JOIN patterns
        ON patterns.id = sampled_urls.pattern_id
      WHERE patterns.session_id = $1
      ORDER BY patterns.template ASC, sampled_urls.checked_at ASC, sampled_urls.id ASC
    `,
    [sessionId]
  );

  const mismatchesResult = await pool.query<MismatchExportRow>(
    `
      SELECT
        sitemap_files.filename,
        mismatched_urls.url,
        mismatched_urls.detected_host,
        mismatched_urls.expected_host,
        mismatched_urls.created_at
      FROM mismatched_urls
      INNER JOIN sitemap_files
        ON sitemap_files.id = mismatched_urls.sitemap_file_id
      WHERE sitemap_files.session_id = $1
      ORDER BY mismatched_urls.created_at ASC, mismatched_urls.id ASC
    `,
    [sessionId]
  );

  return {
    session,
    patterns: patternsResult.rows,
    samples: samplesResult.rows,
    mismatches: mismatchesResult.rows
  };
}

async function generateCsvExport(data: SessionExportData, filePath: string) {
  const parser = new Parser({
    fields: [
      "Role",
      "Pattern",
      "Source File",
      "URL Occurrences",
      "Coverage %",
      "Sampled",
      "Hit",
      "Miss",
      "Confidence %",
      "Redirect %",
      "Status",
      "Missing In Current",
      "Suspicious Segment",
      "Sample URLs"
    ]
  });
  const csv = parser.parse(patternTableRows(data.patterns, data.samples));

  await writeFile(filePath, csv, "utf8");
}

async function generateExcelExport(data: SessionExportData, filePath: string) {
  const workbook = new ExcelJS.Workbook();
  const counts = patternCounts(data.patterns);
  const summary = workbook.addWorksheet("Summary");

  workbook.creator = "Sitemap Migration Health Checker";
  workbook.created = new Date();
  summary.columns = [
    {
      header: "Metric",
      key: "metric",
      width: 28
    },
    {
      header: "Value",
      key: "value",
      width: 48
    }
  ];
  summary.addRows([
    { metric: "Session name", value: data.session.name },
    { metric: "Base URL", value: data.session.base_url },
    { metric: "Date", value: formatHumanUtcDate(data.session.created_at) },
    { metric: "Health score", value: healthScore(data.patterns) },
    { metric: "Total URLs", value: numberValue(data.session.total_urls) },
    { metric: "Healthy patterns", value: counts.healthy },
    { metric: "Warning patterns", value: counts.warning },
    { metric: "Broken patterns", value: counts.broken },
    {
      metric: "Missing legacy patterns",
      value: data.patterns.filter((pattern) => pattern.missing_in_current).length
    },
    {
      metric: "Mismatched URLs",
      value: numberValue(data.session.mismatched_url_count)
    }
  ]);
  summary.getRow(1).font = { bold: true };

  addObjectSheet(
    workbook,
    "Patterns",
    patternTableRows(data.patterns, data.samples)
  );
  addObjectSheet(workbook, "Sampled URLs", sampleTableRows(data.samples));

  if (data.mismatches.length > 0) {
    addObjectSheet(workbook, "Mismatched URLs", mismatchTableRows(data.mismatches));
  }

  const buffer = await workbook.xlsx.writeBuffer();

  await writeFile(filePath, Buffer.from(buffer));
}

function chromiumExecutablePath() {
  const candidates = [
    config.chromiumPath,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome"
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => existsSync(candidate));
}

async function generatePdfExport(data: SessionExportData, filePath: string) {
  const executablePath = chromiumExecutablePath();

  if (!executablePath) {
    throw new Error("Chromium executable was not found");
  }

  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1400
      }
    });
    const baseUrl = config.frontendUrl.replace(/\/$/, "");

    if (config.pdfBackendUrl) {
      const apiBaseUrl = new URL(config.pdfBackendUrl);

      await page.route("**/api/**", async (route) => {
        const requestUrl = new URL(route.request().url());

        if (!requestUrl.pathname.startsWith("/api/")) {
          await route.continue();
          return;
        }

        requestUrl.protocol = apiBaseUrl.protocol;
        requestUrl.host = apiBaseUrl.host;
        await route.continue({
          url: requestUrl.toString()
        });
      });
    }

    await page.goto(`${baseUrl}/sessions/${data.session.id}/results?print=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120000
    });
    await page.waitForSelector('[data-export-ready="true"]', {
      timeout: 120000
    });
    await page.emulateMedia({
      media: "print"
    });
    await page.pdf({
      path: filePath,
      format: "A4",
      landscape: false,
      printBackground: true,
      margin: {
        top: "0.35in",
        right: "0.3in",
        bottom: "0.35in",
        left: "0.3in"
      }
    });
  } finally {
    await browser.close();
  }
}

export async function generateSessionExport(
  sessionId: string,
  format: ExportFormat
): Promise<GeneratedExport> {
  const data = await loadSessionExportData(sessionId);
  const fileName = exportFilename(data, format);
  const filePath = path.join(config.exportDir, fileName);

  await mkdir(config.exportDir, {
    recursive: true
  });

  if (format === "csv") {
    await generateCsvExport(data, filePath);
  } else if (format === "xlsx") {
    await generateExcelExport(data, filePath);
  } else {
    await generatePdfExport(data, filePath);
  }

  await pool.query(
    `
      INSERT INTO exports (session_id, type, file_path)
      VALUES ($1, $2, $3)
    `,
    [sessionId, format, filePath]
  );

  return {
    filePath,
    fileName,
    mimeType:
      format === "csv"
        ? "text/csv; charset=utf-8"
        : format === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "application/pdf"
  };
}
