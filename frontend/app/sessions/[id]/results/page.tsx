"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowUpDown,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FileText,
  Folder,
  Info,
  Layers,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Slash,
  Trash2,
  TriangleAlert,
  Undo2,
  Wrench,
  XCircle
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable
} from "@tanstack/react-table";

import {
  applyPatternRedirects,
  getRedirectCandidates,
  deleteRedirectUrls,
  chooseDownloadFolder,
  downloadCorrectedSitemap,
  downloadSessionExport,
  fetchSitemapsZipBlob,
  getDownloadFolderName,
  getDownloadPreview,
  saveDownloadZip,
  supportsDirectoryPicker,
  friendlyApiErrorMessage,
  ApiError,
  getBulkReplaceStatus,
  getMismatchedUrls,
  getPatternSamples,
  getPatternSourceFiles,
  getPatterns,
  getProblemUrlCount,
  getSession,
  getDeleteProblemUrlsStatus,
  getTrailingSlashStatus,
  numberValue,
  renamePatternTemplate,
  restoreDeletedUrls,
  restoreSampledUrlToFiles,
  resumeSession,
  transformPatternStructure,
  undoFindReplace,
  undoPatternTransform,
  undoTrailingSlashes,
  DRAWER_SAMPLES_TIMEOUT_MS,
  type BulkReplaceStatus,
  type DownloadPreview,
  type ExportFormat,
  type MismatchedUrl,
  type Pattern,
  type PatternSourceFile,
  type RedirectCandidate,
  type RedirectCandidatesResponse,
  type PatternStructureJob,
  type SampledUrl,
  type SessionResponse
} from "@/lib/api";
import {
  summarisePatternJobSkips,
  usePatternStructureJob,
  waitForPatternStructureJob
} from "@/lib/use-pattern-structure-job";
import {
  countTemplateParams,
  parseStructure,
  StructureSyntaxError,
  transformUrl,
  validateStructures,
  type ParsedStructure
} from "@/lib/transform-structure";
import {
  BulkReplaceDialog,
  type BulkReplacePattern
} from "@/components/bulk-replace-dialog";
import { DeleteUrlDialog } from "@/components/delete-url-dialog";
import { ProblemUrlsDialog } from "@/components/problem-urls-dialog";
import { FixTrailingSlashesDialog } from "@/components/fix-trailing-slashes-dialog";
import { PatternJobPanel } from "@/components/pattern-job-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { formatEta } from "@/lib/format";
import { cn } from "@/lib/utils";

type PatternStatus = "GOOD" | "WARNING" | "BAD" | "UNKNOWN";
type StatusFilter = "ALL" | "GOOD" | "WARNING" | "BAD";

// Per-column layout hints consumed by the table th/td renderers. A fixed
// `width` pins the column; `minWidth` (used by the flexible template column)
// lets it grow to fill leftover space while staying readable. `sticky` freezes
// the column to the left edge during horizontal scroll.
type PatternColumnMeta = {
  width?: string;
  minWidth?: string;
  sticky?: boolean;
};

type PatternRow = {
  id: string;
  sourceRole: "current" | "legacy";
  template: string;
  totalUrls: number;
  coveragePct: number;
  sampledCount: number;
  hitCount: number;
  missCount: number;
  confidencePct: number;
  redirectPct: number;
  status: PatternStatus;
  soft404Count: number;
  hasSoft404: boolean;
  hasSuspiciousSegment: boolean;
  suspiciousSegmentValue: string | null;
  missingInCurrent: boolean;
  redirectArtifactSegment: string | null;
  sourceFile: string | null;
  originalTemplate: string | null;
  transformOriginalTemplate: string | null;
  hasRedirects: boolean;
};

type SamplesByPattern = Record<string, SampledUrl[]>;

// Rows per page in the Fix Redirect URLs modal — caps the DOM so a pattern with
// thousands of URLs never freezes the tab. (v1.42)
const FIX_MODAL_PAGE_SIZE = 200;

type FixAction = "fix" | "delete" | "skip";

// Default per-row action in the Fix Redirect URLs modal (v1.42.1):
//   • inferred (unsampled) → Skip — its destination is a guess AND it can't be
//     deleted anyway, so it's excluded from both actions until reviewed;
//   • verified + not-found destination → Delete;
//   • verified + normal → Fix.
function defaultFixAction(candidate: RedirectCandidate): FixAction {
  if (!candidate.is_sampled) {
    return "skip";
  }

  return candidate.destination_not_found ? "delete" : "fix";
}

// Plain-language summary of the discovered rewrite rule, so the one-click
// summary says what it will DO rather than making the reader infer it from a
// list of URLs. Mirrors the two RedirectRule shapes in redirectRule.ts.
function describeRedirectRule(
  rule: NonNullable<RedirectCandidatesResponse["rule"]>
): string {
  if (rule.kind === "insert") {
    return `Insert "${rule.insert}" after "${rule.prefix}"`;
  }

  return rule.replace === ""
    ? `Remove "${rule.find}" from the URL`
    : `Replace "${rule.find}" with "${rule.replace}"`;
}

const statusColors: Record<PatternStatus, string> = {
  GOOD: "#10B981",
  WARNING: "#F59E0B",
  BAD: "#EF4444",
  UNKNOWN: "#64748b"
};

const statusLabels: Record<PatternStatus, string> = {
  GOOD: "Healthy",
  WARNING: "Warning",
  BAD: "Broken",
  UNKNOWN: "Not scored"
};

function normalizeStatus(status: string | null): PatternStatus {
  if (status === "GOOD" || status === "WARNING" || status === "BAD") {
    return status;
  }

  return "UNKNOWN";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

// Rebuilds the success toast from the finished job's recorded result, so the
// wording is unchanged from when these routes answered synchronously.
function patternJobSuccessMessage(job: PatternStructureJob) {
  const result = (job.result ?? {}) as Record<string, unknown>;

  if (job.kind === "pattern-transform") {
    const urls = Number(result.urls_transformed ?? 0);
    const files = Number(result.files_rewritten ?? 0);

    return `Transformed ${formatNumber(urls)} URL${
      urls === 1 ? "" : "s"
    } across ${formatNumber(files)} file${files === 1 ? "" : "s"}`;
  }

  if (job.kind === "pattern-transform-undo") {
    return "URL structure transformation reverted";
  }

  if (result.undo === true) {
    return "Pattern name reverted";
  }

  const occurrences = Number(result.occurrence_count ?? 0);
  const files = Number(result.source_files_count ?? 0);

  return `Pattern renamed — ${formatNumber(
    occurrences
  )} occurrences across ${formatNumber(files)} file${files === 1 ? "" : "s"}`;
}

// When a trailing-slash fix was last applied — shown in the re-run warning.
function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function displayFilename(sessionId: string, filename: string) {
  const sessionPrefix = `${sessionId}-`;
  const uuidPrefix =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
  const withoutSession = filename.startsWith(sessionPrefix)
    ? filename.slice(sessionPrefix.length)
    : filename;

  // New stored names are "<role>-<name>"; legacy stored names were "<uuid>-<name>".
  return withoutSession.replace(/^(current|legacy)-/i, "").replace(uuidPrefix, "");
}

function roundOne(value: number) {
  return Number(value.toFixed(1));
}

function scoreColorClass(score: number) {
  if (score >= 80) {
    return "text-emerald-700";
  }

  if (score >= 50) {
    return "text-amber-700";
  }

  return "text-red-700";
}

function scoreBorderClass(score: number) {
  if (score >= 80) {
    return "border-l-emerald-500";
  }

  if (score >= 50) {
    return "border-l-amber-500";
  }

  return "border-l-red-500";
}

function scoreRingColor(score: number) {
  if (score >= 80) {
    return "#10B981";
  }

  if (score >= 50) {
    return "#F59E0B";
  }

  return "#EF4444";
}

function statusBadgeVariant(status: PatternStatus) {
  if (status === "GOOD") {
    return "success";
  }

  if (status === "WARNING") {
    return "warning";
  }

  if (status === "BAD") {
    return "destructive";
  }

  return "secondary";
}

function categoryLabel(category: SampledUrl["http_status_category"]) {
  if (category === "soft_404") {
    return "Soft-404";
  }

  return category ?? "unknown";
}

function effectiveSampleCategory(sample: SampledUrl) {
  return sample.is_soft_404 ? "soft_404" : sample.http_status_category;
}

// Friendly explanation for a sample that received no HTTP status (v1.39 Fix 2).
// An SSL/cert failure almost always means a corporate SSL-inspection proxy, so
// point the user straight at the fix; everything else reads as a timeout.
function noResponseMessage(sample: SampledUrl) {
  if (sample.error_reason === "ssl_cert") {
    return "SSL certificate error — corporate proxy detected. Add NODE_TLS_REJECT_UNAUTHORIZED=0 to docker-compose.yml";
  }

  return "No response (timeout) — server unreachable or connection blocked";
}

function sampleTone(sample: SampledUrl) {
  const category = effectiveSampleCategory(sample);

  if (category === "success") {
    return {
      borderClass: "border-l-emerald-500",
      badgeVariant: "success" as const,
      icon: "✓"
    };
  }

  if (category === "redirect") {
    return {
      borderClass: "border-l-amber-500",
      badgeVariant: "warning" as const,
      icon: "↗"
    };
  }

  if (category === "soft_404") {
    return {
      borderClass: "border-l-orange-500",
      badgeVariant: "soft404" as const,
      icon: "⚠"
    };
  }

  if (category === "failure") {
    return {
      borderClass: "border-l-red-500",
      badgeVariant: "destructive" as const,
      icon: "✕"
    };
  }

  return {
    borderClass: "border-l-slate-300",
    badgeVariant: "secondary" as const,
    icon: "⚠"
  };
}

// Convert a pattern template's {param} placeholders to positional {A}, {B},
// {C}… names for the Update Pattern modal's structure fields, so the SEO team
// doesn't have to retype a structure that's already on screen. Every static
// segment and the trailing slash are preserved untouched. (v1.40)
//   /manufacturer/{param}/{param}/       -> /manufacturer/{A}/{B}/
//   /rfq/{param}/{param}/{param}/{param}/ -> /rfq/{A}/{B}/{C}/{D}/
function convertParamToABC(template: string): string {
  let index = 0;

  return template.replace(/\{param\}/g, () => {
    const letter = String.fromCharCode(65 + index);

    index += 1;

    return `{${letter}}`;
  });
}

// Which {param} position (0 = A, 1 = B, …) holds the suspicious segment, found
// by scanning sampled URLs' values at each param slot. Returns null when no
// sampled value contains it (e.g. it's a static segment, not inside a param) —
// the caller then falls back to the first placeholder. (v1.41 Feature 1)
function findSuspiciousPosition(
  template: string,
  suspiciousSegment: string,
  sampledUrls: string[]
): number | null {
  const templateSegments = template.split("/").filter(Boolean);
  const paramPositions = templateSegments
    .map((segment, index) => (segment === "{param}" ? index : -1))
    .filter((index) => index !== -1);

  for (const url of sampledUrls) {
    let urlSegments: string[];

    try {
      urlSegments = new URL(url).pathname.split("/").filter(Boolean);
    } catch {
      continue;
    }

    for (let i = 0; i < paramPositions.length; i += 1) {
      const value = urlSegments[paramPositions[i]] ?? "";

      if (value.includes(suspiciousSegment)) {
        return i;
      }
    }
  }

  return null;
}

// Place a strip expression on the placeholder at `suspiciousPosition`, e.g.
// ("/manufacturer/{A}/{B}/", "parts-catalog", 0) -> "/manufacturer/{A|-parts-catalog|}/{B}/".
// (v1.41 Feature 1)
function buildNewUrlStructure(
  convertedTemplate: string,
  suspiciousSegment: string,
  suspiciousPosition: number
): string {
  const letter = String.fromCharCode(65 + suspiciousPosition);

  return convertedTemplate.replace(
    `{${letter}}`,
    `{${letter}|-${suspiciousSegment}|}`
  );
}

// Infer a pattern template from a set of URLs: segments that are identical
// across all URLs stay static, segments that vary become {param}. Used to
// pre-fill the new name from redirect destinations. (v1.41 Feature 2)
//   [".../product/", ".../product/"]                 -> "/product/"
//   [".../manufacturer/acme/", ".../manufacturer/bosch/"] -> "/manufacturer/{param}/"
function extractPatternFromUrls(urls: string[]): string | null {
  if (urls.length === 0) {
    return null;
  }

  const segmentArrays = urls.map((url) => {
    try {
      return new URL(url).pathname.split("/").filter(Boolean);
    } catch {
      return url.split("/").filter(Boolean);
    }
  });
  const maxLen = Math.max(...segmentArrays.map((segments) => segments.length));

  if (maxLen === 0) {
    return "/";
  }

  const patternSegments: string[] = [];

  for (let i = 0; i < maxLen; i += 1) {
    const values = segmentArrays
      .map((segments) => segments[i])
      .filter((value): value is string => Boolean(value));
    const allSame = values.every((value) => value === values[0]);

    patternSegments.push(allSame ? values[0] : "{param}");
  }

  return `/${patternSegments.join("/")}/`;
}

function staticSegmentsForTemplate(template: string) {
  return new Set(
    template
      .split("/")
      .filter((segment) => segment && segment !== "{param}")
  );
}

function pathSegments(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    return new URL(value).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function redirectArtifactSegment(template: string, samples: SampledUrl[]) {
  const staticSegments = staticSegmentsForTemplate(template);

  if (staticSegments.size === 0) {
    return null;
  }

  const redirectedSamples = samples.filter(
    (sample) => numberValue(sample.redirect_count) > 0 && sample.final_url
  );

  if (redirectedSamples.length === 0) {
    return null;
  }

  const strippedCounts = new Map<string, number>();

  for (const sample of redirectedSamples) {
    const finalSegments = new Set(pathSegments(sample.final_url));

    for (const segment of pathSegments(sample.url)) {
      if (staticSegments.has(segment) && !finalSegments.has(segment)) {
        strippedCounts.set(segment, (strippedCounts.get(segment) ?? 0) + 1);
      }
    }
  }

  const threshold = Math.max(1, Math.ceil(redirectedSamples.length * 0.5));
  const [segment] =
    Array.from(strippedCounts.entries())
      .filter(([, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];

  return segment ?? null;
}

function buildRows(patterns: Pattern[], samplesByPattern: SamplesByPattern) {
  return patterns.map<PatternRow>((pattern) => {
    const samples = samplesByPattern[pattern.id] ?? [];
    const hitCount = samples.filter((sample) => sample.is_hit).length;
    const soft404Count = samples.filter((sample) => sample.is_soft_404).length;

    return {
      id: pattern.id,
      sourceRole: pattern.source_role,
      template: pattern.template,
      totalUrls: numberValue(pattern.total_urls),
      coveragePct: numberValue(pattern.coverage_pct),
      sampledCount: samples.length,
      hitCount,
      missCount: samples.length - hitCount,
      confidencePct: numberValue(pattern.confidence_pct),
      redirectPct: numberValue(pattern.redirect_pct),
      status: normalizeStatus(pattern.status),
      soft404Count,
      hasSoft404: soft404Count > 0,
      hasSuspiciousSegment: pattern.has_suspicious_segment,
      suspiciousSegmentValue: pattern.suspicious_segment_value,
      missingInCurrent: pattern.missing_in_current,
      redirectArtifactSegment: redirectArtifactSegment(pattern.template, samples),
      sourceFile: pattern.source_file,
      originalTemplate: pattern.original_template ?? null,
      transformOriginalTemplate: pattern.transform_original_template ?? null,
      hasRedirects: samples.some(
        (sample) =>
          effectiveSampleCategory(sample) === "redirect" &&
          Boolean(sample.final_url) &&
          sample.url !== sample.final_url
      )
    };
  });
}

function calculateHealthScore(rows: PatternRow[]) {
  const coverageTotal = rows.reduce((total, row) => total + row.coveragePct, 0);

  if (coverageTotal <= 0) {
    return 0;
  }

  const weightedTotal = rows.reduce(
    (total, row) => total + row.confidencePct * row.coveragePct,
    0
  );

  return Math.round(weightedTotal / coverageTotal);
}

function makeInsights(rows: PatternRow[], missingLegacyRows: PatternRow[]) {
  const insights: string[] = [];

  missingLegacyRows.forEach((row) => {
    insights.push(
      `Pattern ${row.template} found in old sitemap - no matching pattern in new sitemap.`
    );
  });

  rows.forEach((row) => {
    if (row.status === "WARNING" || row.status === "BAD") {
      const failedPct = Math.max(0, 100 - row.confidencePct);

      insights.push(
        `Pattern ${row.template} covers ${formatPercent(
          row.coveragePct
        )} of URLs; ${formatPercent(
          failedPct
        )} of sampled checks did not pass. Check how these pages open on the new site.`
      );
    }

    if (row.hasSuspiciousSegment) {
      insights.push(
        `Pattern ${row.template} contains a suspicious fixed segment ${
          row.suspiciousSegmentValue ?? "unknown"
        } that may be a migration artifact.`
      );
    }

    if (row.redirectPct > 50) {
      insights.push(
        `Pattern ${row.template} has a high redirect rate (${formatPercent(
          row.redirectPct
        )}). URLs are live, but redirects may slow search engines down.`
      );
    }

    if (row.redirectArtifactSegment) {
      insights.push(
        `Redirects suggest segment ${row.redirectArtifactSegment} is a migration artifact.`
      );
    }

    if (row.hasSoft404) {
      insights.push(
        `Pattern ${row.template} has soft-404 responses — pages load but show no content. Verify these URLs return real data.`
      );
    }
  });

  return insights;
}

function insightTone(insight: string) {
  const normalized = insight.toLowerCase();

  if (normalized.includes("soft-404")) {
    return {
      Icon: TriangleAlert,
      borderClass: "border-l-orange-500",
      iconClass: "text-orange-600",
      bgClass: "bg-orange-50/60"
    };
  }

  if (
    normalized.includes("no matching") ||
    normalized.includes("did not pass")
  ) {
    return {
      Icon: XCircle,
      borderClass: "border-l-red-500",
      iconClass: "text-red-600",
      bgClass: "bg-red-50/60"
    };
  }

  if (
    normalized.includes("redirect") ||
    normalized.includes("migration artifact")
  ) {
    return {
      Icon: ExternalLink,
      borderClass: "border-l-amber-500",
      iconClass: "text-amber-600",
      bgClass: "bg-amber-50/60"
    };
  }

  return {
    Icon: ShieldAlert,
    borderClass: "border-l-indigo-500",
    iconClass: "text-indigo-600",
    bgClass: "bg-indigo-50/60"
  };
}

function HeaderButton({
  column,
  label
}: {
  column: {
    getCanSort: () => boolean;
    getIsSorted: () => false | "asc" | "desc";
    toggleSorting: (desc?: boolean) => void;
  };
  label: string;
}) {
  if (!column.getCanSort()) {
    return <span>{label}</span>;
  }

  const sorted = column.getIsSorted();

  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 font-semibold",
        sorted ? "text-indigo-600" : "text-slate-600"
      )}
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {label}
      <ArrowUpDown
        className={cn(
          "h-3.5 w-3.5",
          sorted ? "text-indigo-600" : "text-slate-400"
        )}
      />
    </button>
  );
}

export default function ResultsDashboardPage({
  params
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const [sessionData, setSessionData] = useState<SessionResponse | null>(null);
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [samplesByPattern, setSamplesByPattern] = useState<SamplesByPattern>({});
  const [mismatches, setMismatches] = useState<MismatchedUrl[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: "totalUrls",
      desc: true
    }
  ]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [selectedRow, setSelectedRow] = useState<PatternRow | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  // Pattern-drawer sample loading (v1.36 Fix 1). The drawer fetches its pattern's
  // sampled URLs on open with a bounded (15s) timeout so it can never spin
  // forever — on timeout/error it shows an error message + Retry instead.
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [copiedSampleId, setCopiedSampleId] = useState<string | null>(null);
  const [isPrintMode, setIsPrintMode] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(
    null
  );
  const [showEmptySitemapFiles, setShowEmptySitemapFiles] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [isUndoConfirmOpen, setIsUndoConfirmOpen] = useState(false);
  const [findReplaceToast, setFindReplaceToast] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [renameRow, setRenameRow] = useState<PatternRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Helper-note state for the Update Pattern modal's auto pre-population (v1.41).
  // renameStripNote: the "-artifact appears in segment X" note under New URL
  // structure; renameRedirectNote: the redirect-destination note under New
  // pattern name.
  const [renameStripNote, setRenameStripNote] = useState<string | null>(null);
  const [renameRedirectNote, setRenameRedirectNote] = useState(false);
  const [renameSourceFiles, setRenameSourceFiles] = useState<
    PatternSourceFile[]
  >([]);
  const [selectedRenameFiles, setSelectedRenameFiles] = useState<Set<string>>(
    new Set()
  );
  const [isLoadingRenameFiles, setIsLoadingRenameFiles] = useState(false);
  // Distinguishes "this pattern has no source files" from "the request to load
  // them failed" — the old bare catch rendered both as the former.
  const [renameFilesError, setRenameFilesError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [undoingRenameId, setUndoingRenameId] = useState<string | null>(null);
  const [transformCurrentStructure, setTransformCurrentStructure] =
    useState("");
  const [transformNewStructure, setTransformNewStructure] = useState("");
  const [transformStep, setTransformStep] = useState<"form" | "preview">(
    "form"
  );
  const [isTransforming, setIsTransforming] = useState(false);
  // The pattern's rename/transform/undo background job. Kicking one off returns
  // 202 immediately; this is what turns that into visible progress, and what
  // reattaches to a run still going after a page reload.
  const patternJob = usePatternStructureJob(params.id, renameRow?.id ?? null);
  const patternJobSkips = summarisePatternJobSkips(patternJob.job);
  const [undoingTransformId, setUndoingTransformId] = useState<string | null>(
    null
  );
  const [downloadingSitemapId, setDownloadingSitemapId] = useState<
    string | null
  >(null);
  const [isApplyingRedirects, setIsApplyingRedirects] = useState(false);
  const [usingRedirectId, setUsingRedirectId] = useState<string | null>(null);
  const [fixRow, setFixRow] = useState<PatternRow | null>(null);
  // Fix Redirect URLs modal lists a BOUNDED review sample of the pattern's
  // redirect candidates (HTTP-verified sampled rows + inferred ones), fetched on
  // open — capped by the pattern_urls pool, so it is NOT the full set. Accepting
  // applies the confirmed rule to all fixPatternTotal real occurrences on disk
  // (v1.45.1), independent of how many rows are shown here. Selection is keyed by
  // candidate.key (sampled_url_id for verified rows, "inferred:<url>" for rest).
  const [fixCandidates, setFixCandidates] = useState<RedirectCandidate[]>([]);
  // The pattern's real total occurrence count — the true scope of an accept.
  const [fixPatternTotal, setFixPatternTotal] = useState(0);
  const [fixLoading, setFixLoading] = useState(false);
  const [fixInferredWithoutRule, setFixInferredWithoutRule] = useState(false);
  // The single rewrite rule distilled from the confirmed samples, or null when
  // they were too varied. Non-null is what makes the one-click path possible:
  // there is one transform to apply, so nothing needs per-row review. (v1.48)
  const [fixRule, setFixRule] = useState<RedirectCandidatesResponse["rule"]>(
    null
  );
  // How many files the widened rewrite spans — the "across M files" half of the
  // scope line, mirroring the transform modal's own one-number summary.
  const [fixFileCount, setFixFileCount] = useState(0);
  // Opt-in escape hatch to the per-row list. The one-click summary is the
  // default whenever a rule exists; this is never required to apply a fix.
  const [fixReviewMode, setFixReviewMode] = useState(false);
  // Per-row action (v1.42.1): "fix" (adopt the redirect destination), "delete"
  // (remove the source URL — for not-found destinations), or "skip" (leave it
  // untouched — the inferred-row default). Keyed by candidate.key.
  const [fixActions, setFixActions] = useState<Record<string, FixAction>>({});
  const [isDeletingRedirects, setIsDeletingRedirects] = useState(false);
  // Paginate the candidate list so a pattern with thousands of URLs never
  // renders thousands of checkbox rows at once (would hang the tab). Selection
  // is keyed, so it survives paging; "Select all" still spans every page.
  const [fixPage, setFixPage] = useState(0);
  const [isFixing, setIsFixing] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<"apply" | "undo">("apply");
  const [bulkInitialFrom, setBulkInitialFrom] = useState<string | null>(null);
  const [bulkStatus, setBulkStatus] = useState<BulkReplaceStatus | null>(null);
  const [downloadingSitemaps, setDownloadingSitemaps] = useState<
    "edited" | "all" | null
  >(null);
  const [previewingDownload, setPreviewingDownload] = useState<
    "edited" | "all" | null
  >(null);
  const [foreignWarning, setForeignWarning] = useState<{
    type: "edited" | "all";
    preview: DownloadPreview;
  } | null>(null);
  // Files (by id) the user has ticked to exclude entirely from the download in
  // the foreign-URL warning modal (v1.31 Fix 5). Ticked = excluded.
  const [excludedFileIds, setExcludedFileIds] = useState<Set<string>>(
    new Set()
  );
  // On-demand download progress overlay (v1.31 Fix 2).
  const [downloadOverlay, setDownloadOverlay] = useState<{
    type: "edited" | "all";
    percent: number;
    fileCurrent: number;
    fileTotal: number;
    etaSeconds: number | null;
    cancelling: boolean;
  } | null>(null);
  // Persistent download-folder name for the dropdown label (v1.31 Fix 3). The
  // actual directory handle lives at module level in lib/api.
  const [downloadFolderName, setDownloadFolderName] = useState<string | null>(
    () => getDownloadFolderName()
  );
  // "Fix Trailing Slashes" re-run confirmation (v1.31 Fix 4).
  const [slashRerunOpen, setSlashRerunOpen] = useState(false);
  const downloadAbortRef = useRef<AbortController | null>(null);
  const switchToCacheRef = useRef(false);
  const [deleteUrlTarget, setDeleteUrlTarget] = useState<SampledUrl | null>(
    null
  );
  const [problemUrlsOpen, setProblemUrlsOpen] = useState(false);
  const [trailingSlashOpen, setTrailingSlashOpen] = useState(false);
  const [problemUrlCount, setProblemUrlCount] = useState(0);
  const [hasDeletedUrls, setHasDeletedUrls] = useState(false);
  const [slashApplied, setSlashApplied] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [restoringUrlId, setRestoringUrlId] = useState<string | null>(null);
  // Connectivity warning banner dismissal (v1.39 Fix 2). Persisted per-session
  // in localStorage so a dismissed banner stays dismissed across reloads.
  const [connectivityDismissed, setConnectivityDismissed] = useState(false);

  useEffect(() => {
    setIsPrintMode(
      new URLSearchParams(window.location.search).get("print") === "1"
    );
  }, []);

  const connectivityDismissKey = `connectivity-warning-dismissed-${params.id}`;

  useEffect(() => {
    try {
      setConnectivityDismissed(
        window.localStorage.getItem(connectivityDismissKey) === "1"
      );
    } catch {
      setConnectivityDismissed(false);
    }
  }, [connectivityDismissKey]);

  const dismissConnectivityWarning = useCallback(() => {
    setConnectivityDismissed(true);

    try {
      window.localStorage.setItem(connectivityDismissKey, "1");
    } catch {
      // Non-fatal: the banner just reappears on reload if storage is blocked.
    }
  }, [connectivityDismissKey]);

  // Header state for the Delete URLs / Fix Trailing Slashes affordances: how
  // many problem URLs remain, whether a bulk deletion has run (→ show undo),
  // and whether a trailing-slash fix is in place (→ show undo).
  const loadMaintenanceState = useCallback(async () => {
    try {
      const [problem, deleteJob, slashJob] = await Promise.all([
        getProblemUrlCount(params.id).catch(() => ({ count: 0 })),
        getDeleteProblemUrlsStatus(params.id).catch(() => ({ job: null })),
        getTrailingSlashStatus(params.id).catch(() => ({ job: null }))
      ]);

      setProblemUrlCount(problem.count);
      setHasDeletedUrls(deleteJob.job?.status === "COMPLETE");
      setSlashApplied(slashJob.job?.status === "COMPLETE");
    } catch {
      // Non-fatal: the buttons simply stay hidden.
    }
  }, [params.id]);

  useEffect(() => {
    void loadMaintenanceState();
  }, [loadMaintenanceState]);

  // Poll for the pre-generated download ZIP so the Download Sitemaps button
  // flips from the "Preparing…" spinner to the instant-download label once the
  // background job lands. We only poll while the ZIP is actively being generated
  // (a short post-completion window); once that window closes we stop — the
  // button then works on-demand, so there's nothing left to wait for.
  const sessionStatus = sessionData?.session.status;
  const sessionZipReady = sessionData?.session.zip_ready ?? false;
  const sessionZipGenerating = sessionData?.session.zip_generating ?? false;
  useEffect(() => {
    if (
      (sessionStatus !== "COMPLETE" && sessionStatus !== "COMPLETED") ||
      sessionZipReady ||
      !sessionZipGenerating
    ) {
      return;
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const next = await getSession(params.id);

        if (!cancelled) {
          setSessionData((prev) =>
            prev ? { ...prev, session: next.session } : next
          );
        }
      } catch {
        // ignore; retry next tick
      }
    };

    const interval = window.setInterval(() => void tick(), 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [params.id, sessionStatus, sessionZipReady, sessionZipGenerating]);

  const loadResults = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) {
        setIsLoading(true);
      }

      try {
        const [nextSessionData, nextPatterns, nextMismatches] =
          await Promise.all([
            getSession(params.id),
            getPatterns(params.id),
            getMismatchedUrls(params.id)
          ]);
        const sampleEntries = await Promise.all(
          nextPatterns.map(async (pattern) => [
            pattern.id,
            await getPatternSamples(params.id, pattern.id)
          ] as const)
        );

        setSessionData(nextSessionData);
        setPatterns(nextPatterns);
        setMismatches(nextMismatches);
        setSamplesByPattern(Object.fromEntries(sampleEntries));
        setError("");
      } catch (nextError) {
        setError(friendlyApiErrorMessage(nextError, "Unable to load dashboard."));
        throw nextError;
      } finally {
        setIsLoading(false);
      }
    },
    [params.id]
  );

  useEffect(() => {
    void loadResults().catch(() => undefined);
  }, [loadResults]);

  // Refresh both the pattern data (so drawer strikethrough / counts update) and
  // the header maintenance state after any delete / restore / slash operation.
  const refreshAfterMaintenance = useCallback(async () => {
    await Promise.all([
      loadResults({ silent: true }).catch(() => undefined),
      loadMaintenanceState()
    ]);
  }, [loadResults, loadMaintenanceState]);

  const handleRestoreDeletedUrls = useCallback(async () => {
    setMaintenanceBusy(true);

    try {
      await restoreDeletedUrls(params.id);
      // The restore runs as a background job; give it a beat, then refresh.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refreshAfterMaintenance();
    } catch {
      // Surfaced elsewhere; keep the UI responsive.
    } finally {
      setMaintenanceBusy(false);
    }
  }, [params.id, refreshAfterMaintenance]);

  const handleUndoTrailingSlashes = useCallback(async () => {
    setMaintenanceBusy(true);

    try {
      await undoTrailingSlashes(params.id);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refreshAfterMaintenance();
    } catch {
      // Non-fatal.
    } finally {
      setMaintenanceBusy(false);
    }
  }, [params.id, refreshAfterMaintenance]);

  const handleRestoreOneUrl = useCallback(
    async (sample: SampledUrl) => {
      setRestoringUrlId(sample.id);

      try {
        await restoreSampledUrlToFiles(params.id, sample.id);
        await refreshAfterMaintenance();
      } catch {
        // Non-fatal.
      } finally {
        setRestoringUrlId(null);
      }
    },
    [params.id, refreshAfterMaintenance]
  );

  // Fetch a pattern's sampled URLs for the drawer with a hard 15s timeout. If it
  // times out (or errors) and we have no cached samples, surface an error so the
  // drawer shows a Retry button instead of an endless spinner. If we DO have
  // cached samples (from the initial dashboard load), keep showing them silently.
  const loadDrawerSamples = useCallback(
    async (patternId: string) => {
      setDrawerError("");
      setDrawerLoading(true);

      try {
        const samples = await getPatternSamples(
          params.id,
          patternId,
          DRAWER_SAMPLES_TIMEOUT_MS
        );

        setSamplesByPattern((current) => ({
          ...current,
          [patternId]: samples
        }));
      } catch (nextError) {
        setSamplesByPattern((current) => {
          if (current[patternId]?.length) {
            // Keep the cached samples; the refresh failure is non-fatal.
            return current;
          }

          setDrawerError(
            friendlyApiErrorMessage(
              nextError,
              "Could not load URL details for this pattern."
            )
          );

          return current;
        });
      } finally {
        setDrawerLoading(false);
      }
    },
    [params.id]
  );

  const openPatternDrawer = useCallback(
    (row: PatternRow) => {
      setSelectedRow(row);
      setIsSheetOpen(true);
      void loadDrawerSamples(row.id);
    },
    [loadDrawerSamples]
  );

  // Re-queue only the incomplete work for a FAILED session, then send the user
  // to the processing screen to watch it finish. (v1.36 Fix 2)
  const handleResume = useCallback(async () => {
    setResumeError("");
    setIsResuming(true);

    try {
      await resumeSession(params.id);
      router.push(`/sessions/${params.id}`);
    } catch (nextError) {
      setResumeError(
        friendlyApiErrorMessage(nextError, "Could not resume this session.")
      );
      setIsResuming(false);
    }
  }, [params.id, router]);

  const rows = useMemo(
    () => buildRows(patterns, samplesByPattern),
    [patterns, samplesByPattern]
  );
  const currentRows = useMemo(
    () => rows.filter((row) => row.sourceRole === "current"),
    [rows]
  );
  const missingLegacyRows = useMemo(
    () =>
      rows.filter(
        (row) => row.sourceRole === "legacy" && row.missingInCurrent
      ),
    [rows]
  );
  const filteredRows = useMemo(
    () =>
      statusFilter === "ALL"
        ? rows
        : rows.filter((row) => row.status === statusFilter),
    [rows, statusFilter]
  );
  const selectedSamples = selectedRow
    ? samplesByPattern[selectedRow.id] ?? []
    : [];
  const redirectSamples = selectedSamples.filter(
    (sample) =>
      effectiveSampleCategory(sample) === "redirect" &&
      Boolean(sample.final_url) &&
      sample.url !== sample.final_url
  );

  const dashboard = useMemo(() => {
    const statusCounts = currentRows.reduce(
      (counts, row) => {
        if (row.status === "GOOD" || row.status === "WARNING" || row.status === "BAD") {
          counts[row.status] += 1;
        }

        return counts;
      },
      {
        GOOD: 0,
        WARNING: 0,
        BAD: 0
      }
    );
    const totalUrls =
      sessionData?.sitemap_files.reduce(
        (total, file) =>
          file.source_role === "current"
            ? total + numberValue(file.total_urls)
            : total,
        0
      ) ?? 0;

    return {
      healthScore: calculateHealthScore(currentRows),
      statusCounts,
      redirectHeavyCount: currentRows.filter((row) => row.redirectPct > 50)
        .length,
      redirectArtifactCount: currentRows.filter(
        (row) => row.redirectArtifactSegment
      ).length,
      redirectIssueCount: currentRows.filter(
        (row) => row.redirectPct > 50 || row.redirectArtifactSegment
      ).length,
      soft404PatternCount: currentRows.filter((row) => row.hasSoft404).length,
      suspiciousCount: currentRows.filter((row) => row.hasSuspiciousSegment)
        .length,
      missingLegacyCount: missingLegacyRows.length,
      totalUrls,
      mismatchCount: mismatches.length,
      insights: makeInsights(currentRows, missingLegacyRows)
    };
  }, [currentRows, mismatches.length, missingLegacyRows, sessionData?.sitemap_files]);

  const healthDistribution = useMemo(
    () => [
      {
        name: "Healthy",
        status: "GOOD" as const,
        value: dashboard.statusCounts.GOOD
      },
      {
        name: "Warning",
        status: "WARNING" as const,
        value: dashboard.statusCounts.WARNING
      },
      {
        name: "Broken",
        status: "BAD" as const,
        value: dashboard.statusCounts.BAD
      }
    ],
    [dashboard.statusCounts]
  );
  const topPatternData = useMemo(
    () =>
      [...currentRows]
        .sort((a, b) => b.totalUrls - a.totalUrls)
        .slice(0, 10)
        .map((row) => ({
          ...row,
          shortTemplate:
            row.template.length > 32
              ? `${row.template.slice(0, 29)}...`
              : row.template
        })),
    [currentRows]
  );

  const columns = useMemo<ColumnDef<PatternRow>[]>(
    () => [
      {
        accessorKey: "template",
        header: ({ column }) => (
          <HeaderButton column={column} label="Pattern template" />
        ),
        meta: { minWidth: "220px", sticky: true } satisfies PatternColumnMeta,
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <span
              className="min-w-0 flex-1 truncate font-medium"
              title={row.original.template}
            >
              {row.original.template}
            </span>
            {row.original.transformOriginalTemplate ? (
              <button
                type="button"
                aria-label={`Undo URL structure transformation for ${row.original.template}`}
                title="Undo URL transformation"
                className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleUndoTransform(row.original);
                }}
                disabled={undoingTransformId === row.original.id}
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {row.original.originalTemplate ? (
              <button
                type="button"
                aria-label={`Undo rename for ${row.original.template}`}
                title="Undo rename"
                className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleUndoRename(row.original);
                }}
                disabled={undoingRenameId === row.original.id}
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            {row.original.originalTemplate ? (
              <button
                type="button"
                aria-label={`Download corrected sitemap for ${row.original.template}`}
                title="Download corrected sitemap"
                className="shrink-0 rounded p-1 text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700 disabled:opacity-50"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDownloadCorrectedSitemap(row.original);
                }}
                disabled={downloadingSitemapId === row.original.id}
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Rename pattern ${row.original.template}`}
              className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-indigo-600 group-hover:opacity-100 focus:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                void openRenameModal(row.original);
              }}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Bulk replace pattern ${row.original.template}`}
              title="Bulk pattern replace"
              className="shrink-0 rounded p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-indigo-600 group-hover:opacity-100 focus:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                openBulkReplace(row.original.template);
              }}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )
      },
      {
        accessorKey: "status",
        header: ({ column }) => <HeaderButton column={column} label="Status" />,
        meta: { width: "100px" } satisfies PatternColumnMeta,
        cell: ({ row }) => (
          <Badge variant={statusBadgeVariant(row.original.status)}>
            {statusLabels[row.original.status]}
          </Badge>
        )
      },
      {
        id: "fix",
        header: "Fix",
        enableSorting: false,
        meta: { width: "60px" } satisfies PatternColumnMeta,
        cell: ({ row }) =>
          row.original.hasRedirects ? (
            <button
              type="button"
              aria-label={`Fix redirects for ${row.original.template}`}
              title="Fix redirect URLs"
              className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 hover:bg-amber-100"
              onClick={(event) => {
                event.stopPropagation();
                setFindReplaceToast(null);
                setFixRow(row.original);
              }}
            >
              <Wrench className="h-3 w-3" aria-hidden="true" />
              Fix
            </button>
          ) : null
      },
      {
        accessorKey: "coveragePct",
        header: ({ column }) => <HeaderButton column={column} label="Coverage %" />,
        meta: { width: "90px" } satisfies PatternColumnMeta,
        cell: ({ row }) => formatPercent(row.original.coveragePct)
      },
      {
        accessorKey: "totalUrls",
        header: ({ column }) => (
          <span className="inline-flex items-center gap-1">
            <HeaderButton column={column} label="URL occurrences" />
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-slate-400 hover:text-slate-600"
                    aria-label="About URL occurrences"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Info className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs normal-case">
                  Total number of URL entries found across all uploaded sitemap
                  files for this pattern. The same URL may appear in multiple
                  files.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </span>
        ),
        meta: { width: "120px" } satisfies PatternColumnMeta,
        cell: ({ row }) => formatNumber(row.original.totalUrls)
      },
      {
        accessorKey: "confidencePct",
        header: ({ column }) => (
          <HeaderButton column={column} label="Confidence %" />
        ),
        meta: { width: "100px" } satisfies PatternColumnMeta,
        cell: ({ row }) => formatPercent(row.original.confidencePct)
      },
      {
        accessorKey: "redirectPct",
        header: ({ column }) => <HeaderButton column={column} label="Redirect %" />,
        meta: { width: "90px" } satisfies PatternColumnMeta,
        cell: ({ row }) => formatPercent(row.original.redirectPct)
      },
      {
        accessorKey: "suspiciousSegmentValue",
        header: "Suspicious segment",
        enableSorting: false,
        meta: { width: "130px" } satisfies PatternColumnMeta,
        cell: ({ row }) =>
          row.original.hasSuspiciousSegment ? (
            <Badge variant="warning">
              {row.original.suspiciousSegmentValue ?? "Review"}
            </Badge>
          ) : (
            <span className="text-muted-foreground">None</span>
          )
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [undoingRenameId, downloadingSitemapId]
  );

  const table = useReactTable({
    data: filteredRows,
    columns,
    state: {
      sorting
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });

  async function copyText(text: string, feedbackId: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textArea = document.createElement("textarea");

      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand("copy");
      textArea.remove();
    }

    setCopiedSampleId(feedbackId);
    window.setTimeout(() => setCopiedSampleId(null), 1200);
  }

  async function copyUrl(sample: SampledUrl) {
    await copyText(sample.url, sample.id);
  }

  async function startExport(format: ExportFormat) {
    setExportError("");
    setExportingFormat(format);

    try {
      await downloadSessionExport(params.id, format);
    } catch (nextError) {
      setExportError(
        friendlyApiErrorMessage(nextError, "Unable to generate export.")
      );
    } finally {
      setExportingFormat(null);
    }
  }

  const allSamples = useMemo(
    () => Object.values(samplesByPattern).flat(),
    [samplesByPattern]
  );
  const hasReplacements = useMemo(
    () => allSamples.some((sample) => sample.original_url != null),
    [allSamples]
  );
  useEffect(() => {
    if (!findReplaceToast) {
      return;
    }

    const timer = window.setTimeout(() => setFindReplaceToast(null), 4000);

    return () => window.clearTimeout(timer);
  }, [findReplaceToast]);

  async function handleUndoFindReplace() {
    if (isUndoing) {
      return;
    }

    setIsUndoing(true);

    try {
      await undoFindReplace(params.id);

      await loadResults({ silent: true });
      setIsUndoConfirmOpen(false);
      setFindReplaceToast({
        tone: "success",
        message: "URLs restored to original"
      });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to undo find & replace."
        )
      });
    } finally {
      setIsUndoing(false);
    }
  }

  async function openRenameModal(
    rowData: PatternRow,
    options: { fromDrawer?: boolean } = {}
  ) {
    setFindReplaceToast(null);
    setRenameRow(rowData);

    // Pre-populate the URL-structure fields from the pattern that's already on
    // screen, with {param} → {A}, {B}, {C}… so the user edits from a starting
    // point instead of retyping. Both fields stay fully editable; clearing them
    // falls back to a label-only rename (wantsTransform === false). (v1.40)
    const convertedStructure = convertParamToABC(rowData.template);
    const samples = samplesByPattern[rowData.id] ?? [];

    setTransformCurrentStructure(convertedStructure);

    // Feature 1 (v1.41): if the pattern has a suspicious segment, auto-place a
    // strip expression on the placeholder whose sampled values contain it, so
    // the New URL structure is a ready-to-apply transform rather than a copy of
    // the current one. Falls back to the first placeholder when the position
    // can't be pinpointed; both cases surface a "edit if incorrect" note.
    const suspicious = rowData.suspiciousSegmentValue;
    let newStructure = convertedStructure;
    let stripNote: string | null = null;

    if (suspicious) {
      const detectedPosition = findSuspiciousPosition(
        rowData.template,
        suspicious,
        samples.map((sample) => sample.url)
      );
      const position = detectedPosition ?? 0;
      const letter = String.fromCharCode(65 + position);

      newStructure = buildNewUrlStructure(
        convertedStructure,
        suspicious,
        position
      );
      stripNote =
        detectedPosition === null
          ? `Auto-added a strip for "-${suspicious}" on segment ${letter} — couldn't pinpoint the segment, so edit if this is incorrect.`
          : `Auto-detected: "-${suspicious}" appears in segment ${letter}. Edit if this is incorrect.`;
    }

    setTransformNewStructure(newStructure);
    setRenameStripNote(stripNote);

    // Feature 2 (v1.41): when opened from the drawer and 80%+ of sampled URLs
    // redirect to a single destination pattern, pre-fill the new name with that
    // destination instead of the current template. Table-opened modals keep the
    // current template.
    let nameValue = rowData.template;
    let redirectNote = false;

    if (options.fromDrawer && samples.length > 0) {
      const destinations = samples
        .filter(
          (sample) =>
            effectiveSampleCategory(sample) === "redirect" &&
            Boolean(sample.final_url) &&
            sample.url !== sample.final_url
        )
        .map((sample) => sample.final_url as string);

      if (destinations.length / samples.length >= 0.8) {
        const detected = extractPatternFromUrls(destinations);

        if (detected) {
          nameValue = detected;
          redirectNote = true;
        }
      }
    }

    setRenameValue(nameValue);
    setRenameRedirectNote(redirectNote);
    setTransformStep("form");
    setRenameSourceFiles([]);
    setSelectedRenameFiles(new Set());
    setIsLoadingRenameFiles(true);

    setRenameFilesError(null);
    // Adopt a job that is already running for this pattern, so reopening the
    // modal (or reloading the page) rejoins it instead of looking idle.
    void patternJob.attach(handlePatternJobSettled);

    try {
      const files = await getPatternSourceFiles(params.id, rowData.id);

      setRenameSourceFiles(files);
      setSelectedRenameFiles(new Set(files.map((file) => file.source_file)));
    } catch (nextError) {
      // A failed load used to render as "No source files found for this
      // pattern", which is what an EMPTY pattern looks like. Say which it is.
      setRenameSourceFiles([]);
      setRenameFilesError(
        friendlyApiErrorMessage(nextError, "Unable to load this pattern's source files.")
      );
    } finally {
      setIsLoadingRenameFiles(false);
    }
  }

  function toggleRenameFile(sourceFile: string) {
    setSelectedRenameFiles((current) => {
      const next = new Set(current);

      if (next.has(sourceFile)) {
        next.delete(sourceFile);
      } else {
        next.add(sourceFile);
      }

      return next;
    });
  }

  function toggleAllRenameFiles() {
    setSelectedRenameFiles((current) =>
      current.size === renameSourceFiles.length
        ? new Set()
        : new Set(renameSourceFiles.map((file) => file.source_file))
    );
  }

  // Called once the background job reaches COMPLETE or FAILED. The modal stays
  // open on a warning or a failure: a run that skipped files or died is exactly
  // what the user needs still on screen, not a toast that fades in four seconds.
  const handlePatternJobSettled = useCallback(
    async (job: PatternStructureJob) => {
      await loadResults({ silent: true });

      if (job.status !== "COMPLETE") {
        setFindReplaceToast({
          tone: "error",
          message: job.error ?? "The update failed."
        });
        return;
      }

      const result = (job.result ?? {}) as Record<string, unknown>;
      const zeroWork = result.zero_work_reason as string | null | undefined;

      if (zeroWork || job.files_skipped > 0) {
        setFindReplaceToast({
          tone: "error",
          message:
            zeroWork ??
            `Finished, but ${job.files_skipped} file${
              job.files_skipped === 1 ? " was" : "s were"
            } skipped — see the details in the dialog.`
        });
        return;
      }

      setRenameRow(null);
      patternJob.reset();
      setFindReplaceToast({
        tone: "success",
        message: patternJobSuccessMessage(job)
      });
    },
    [loadResults, patternJob]
  );

  async function handleRenamePattern() {
    if (!renameRow || !canRename) {
      return;
    }

    setIsRenaming(true);

    try {
      await renamePatternTemplate(params.id, renameRow.id, {
        newTemplate: renameValue,
        sourceFiles: Array.from(selectedRenameFiles)
      });

      // 202 — the rewrite runs on the queue. Watch it rather than blocking on a
      // response that used to outlive the client's abort timer.
      patternJob.watch(handlePatternJobSettled);
    } catch (nextError) {
      // 409 means a job for this pattern is already running: attach to it
      // instead of reporting an error the user can do nothing about.
      if (nextError instanceof ApiError && nextError.status === 409) {
        patternJob.watch(handlePatternJobSettled);
        return;
      }

      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(nextError, "Unable to rename pattern.")
      });
    } finally {
      setIsRenaming(false);
    }
  }

  async function handleUndoRename(rowData: PatternRow) {
    if (!rowData.originalTemplate || undoingRenameId) {
      return;
    }

    setUndoingRenameId(rowData.id);

    try {
      await renamePatternTemplate(params.id, rowData.id, {
        newTemplate: rowData.originalTemplate,
        sourceFiles: []
      });

      // Row-level undo has no modal to show progress in, so hold the row
      // spinner until the queued job actually finishes.
      const job = await waitForPatternStructureJob(params.id, rowData.id);

      await loadResults({ silent: true });

      if (job && job.status !== "COMPLETE") {
        setFindReplaceToast({
          tone: "error",
          message: job.error ?? "Unable to undo rename."
        });
        return;
      }

      setFindReplaceToast({
        tone: "success",
        message: "Pattern name reverted"
      });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(nextError, "Unable to undo rename.")
      });
    } finally {
      setUndoingRenameId(null);
    }
  }

  async function handleApplyTransform() {
    if (!renameRow) {
      return;
    }

    setIsTransforming(true);

    try {
      await transformPatternStructure(params.id, renameRow.id, {
        newTemplate: renameValue,
        currentStructure: transformCurrentStructure,
        newStructure: transformNewStructure,
        sourceFiles: Array.from(selectedRenameFiles)
      });

      patternJob.watch(handlePatternJobSettled);
    } catch (nextError) {
      if (nextError instanceof ApiError && nextError.status === 409) {
        patternJob.watch(handlePatternJobSettled);
        return;
      }

      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to transform pattern."
        )
      });
    } finally {
      setIsTransforming(false);
    }
  }

  async function handleUndoTransform(rowData: PatternRow) {
    if (!rowData.transformOriginalTemplate || undoingTransformId) {
      return;
    }

    setUndoingTransformId(rowData.id);

    try {
      await undoPatternTransform(params.id, rowData.id);

      const job = await waitForPatternStructureJob(params.id, rowData.id);

      await loadResults({ silent: true });

      if (job && job.status !== "COMPLETE") {
        setFindReplaceToast({
          tone: "error",
          message: job.error ?? "Unable to undo transformation."
        });
        return;
      }

      const undoResult = (job?.result ?? {}) as {
        files_restored?: number;
        files_expected?: number;
      };
      const restored = Number(undoResult.files_restored ?? 0);
      const expected = Number(undoResult.files_expected ?? 0);

      setFindReplaceToast({
        // Report what was actually repointed, not what was planned. The old
        // route returned the intended count, so a file whose name had already
        // moved on was reported as restored when nothing had been.
        tone: restored < expected ? "error" : "success",
        message:
          restored < expected
            ? `Reverted, but only ${formatNumber(restored)} of ${formatNumber(
                expected
              )} files could be restored.`
            : "URL structure transformation reverted"
      });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to undo transformation."
        )
      });
    } finally {
      setUndoingTransformId(null);
    }
  }

  async function handleDownloadCorrectedSitemap(rowData: PatternRow) {
    if (downloadingSitemapId) {
      return;
    }

    setDownloadingSitemapId(rowData.id);

    try {
      await downloadCorrectedSitemap(params.id, rowData.id);
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to download corrected sitemap."
        )
      });
    } finally {
      setDownloadingSitemapId(null);
    }
  }

  async function handleUseThisUrl(sample: SampledUrl) {
    if (!selectedRow || !sample.final_url || usingRedirectId) {
      return;
    }

    setUsingRedirectId(sample.id);

    try {
      // Route through apply-redirects (not find/replace) so the source XML on
      // disk is rewritten too — same path as the Fix modal and "Replace all".
      await applyPatternRedirects(params.id, selectedRow.id, [sample.id]);
      // Full reload so the pattern row's recomputed redirect/confidence and the
      // drawer's samples both reflect the change.
      await loadResults({ silent: true });
      setFindReplaceToast({ tone: "success", message: "URL updated" });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(nextError, "Unable to update URL.")
      });
    } finally {
      setUsingRedirectId(null);
    }
  }

  async function handleApplyAllRedirects() {
    if (!selectedRow || isApplyingRedirects) {
      return;
    }

    setIsApplyingRedirects(true);

    try {
      const result = await applyPatternRedirects(params.id, selectedRow.id);

      // Full reload so the pattern row's recomputed redirect/confidence show too.
      await loadResults({ silent: true });
      const updatedCount = result.updated ?? 0;
      setFindReplaceToast({
        tone: "success",
        message: `${formatNumber(updatedCount)} URL${
          updatedCount === 1 ? "" : "s"
        } updated to their redirect destinations`
      });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to apply redirects."
        )
      });
    } finally {
      setIsApplyingRedirects(false);
    }
  }

  // Current patterns eligible as a bulk-replace "From" (have a {param} slot).
  const bulkPatterns = useMemo<BulkReplacePattern[]>(
    () =>
      patterns
        .filter(
          (pattern) =>
            pattern.source_role === "current" &&
            pattern.template.includes("{param}")
        )
        .map((pattern) => ({ id: pattern.id, template: pattern.template })),
    [patterns]
  );

  const refreshBulkStatus = useCallback(async () => {
    try {
      setBulkStatus(await getBulkReplaceStatus(params.id));
    } catch {
      // Best-effort: the undo button just won't show if this fails.
    }
  }, [params.id]);

  useEffect(() => {
    void refreshBulkStatus();
  }, [refreshBulkStatus]);

  function openBulkReplace(template?: string) {
    setFindReplaceToast(null);
    setBulkMode("apply");
    setBulkInitialFrom(template ?? null);
    setBulkOpen(true);
  }

  function openBulkUndo() {
    setFindReplaceToast(null);
    setBulkMode("undo");
    setBulkOpen(true);
  }

  function handleBulkFinished() {
    void loadResults({ silent: true });
    void refreshBulkStatus();
  }

  const bulkBusy = bulkStatus
    ? ["PENDING", "RUNNING", "UNDOING"].includes(bulkStatus.status)
    : false;

  // Fetch every redirect candidate for the pattern when the Fix modal opens.
  // Only the HTTP-verified (sampled) rows are pre-selected; inferred rows start
  // unchecked so a user opts into them deliberately (per-row or "Select all").
  // (v1.42)
  const fixPatternId = fixRow?.id ?? null;
  useEffect(() => {
    if (!fixPatternId) {
      return;
    }

    let cancelled = false;

    setFixLoading(true);
    setFixCandidates([]);
    setFixPatternTotal(0);
    setFixActions({});
    setFixInferredWithoutRule(false);
    setFixPage(0);
    setFixRule(null);
    setFixFileCount(0);
    setFixReviewMode(false);

    void getRedirectCandidates(params.id, fixPatternId)
      .then((data) => {
        if (cancelled) {
          return;
        }

        setFixCandidates(data.candidates);
        setFixPatternTotal(data.pattern_total_urls);
        setFixRule(data.rule);
        setFixFileCount(data.pattern_file_count ?? 0);
        // Default action per row (see defaultFixAction): verified-normal → Fix,
        // verified-not-found → Delete, inferred → Skip (excluded from both
        // actions until someone reviews it). (v1.42.1)
        setFixActions(
          Object.fromEntries(
            data.candidates.map((candidate) => [
              candidate.key,
              defaultFixAction(candidate)
            ])
          )
        );
        // The pattern has unsampled URLs but the samples were too varied to
        // distil a single rule, so only the verified rows can be listed.
        setFixInferredWithoutRule(
          data.rule === null &&
            data.pattern_total_urls > data.sampled_redirect_count
        );
      })
      .catch(() => {
        if (!cancelled) {
          setFixCandidates([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFixLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [params.id, fixPatternId]);

  function setFixAction(key: string, action: FixAction) {
    setFixActions((current) => ({ ...current, [key]: action }));
  }

  // Top-level default: reset every row to Fix (per-row toggles stay overridable).
  function setAllFix() {
    setFixActions(
      Object.fromEntries(fixCandidates.map((candidate) => [candidate.key, "fix"]))
    );
  }

  async function handleAcceptFixes() {
    if (!fixRow || fixCount === 0 || isFixing || isDeletingRedirects) {
      return;
    }

    // Only the rows toggled Fix. Split into HTTP-verified sampled rows (applied
    // by their confirmed destination) and inferred rows (server recomputes rule).
    const selected = fixCandidates.filter(
      (candidate) =>
        (fixActions[candidate.key] ?? defaultFixAction(candidate)) === "fix"
    );
    const sampledIds = selected
      .filter((candidate) => candidate.is_sampled && candidate.sampled_url_id)
      .map((candidate) => candidate.sampled_url_id as string);
    const inferredUrls = selected
      .filter((candidate) => !candidate.is_sampled)
      .map((candidate) => candidate.url);

    setIsFixing(true);

    try {
      const result = await applyPatternRedirects(
        params.id,
        fixRow.id,
        sampledIds,
        inferredUrls
      );

      setFixRow(null);

      if (result.queued) {
        // Large whole-pattern fix routed to a background job — no synchronous
        // result. Tell the user and refresh shortly so the recomputed pattern
        // + rewritten files show once the worker finishes.
        setFindReplaceToast({
          tone: "success",
          message: `Applying redirect fixes across ${formatNumber(
            result.files_total ?? 0
          )} files in the background — results will update shortly.`
        });
        window.setTimeout(() => void loadResults({ silent: true }), 6000);
        return;
      }

      await loadResults({ silent: true });
      // rewritten_loc_count is the authoritative number of <loc>s actually
      // changed on disk (the whole-pattern rule reaches far beyond the reviewed
      // sample). Fall back to updated+inferred only if it is somehow absent.
      const changed =
        result.rewritten_loc_count ??
        (result.updated ?? 0) + (result.inferred_applied ?? 0);
      setFindReplaceToast({
        tone: "success",
        message: `${formatNumber(changed)} URL${
          changed === 1 ? "" : "s"
        } updated to their redirect destinations${
          result.inferred_applied
            ? ` (${formatNumber(result.inferred_applied)} by inferred rule)`
            : ""
        }`
      });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to apply redirect fixes."
        )
      });
    } finally {
      setIsFixing(false);
    }
  }

  // Delete the source URLs of the rows toggled Delete (all verified/sampled —
  // Delete is disabled for inferred rows). Reuses the Delete Problem URLs job,
  // so it runs in the background; we toast + refresh shortly. (v1.42.1)
  async function handleDeleteRedirects() {
    if (!fixRow || deleteCount === 0 || isFixing || isDeletingRedirects) {
      return;
    }

    const urls = fixCandidates
      .filter(
        (candidate) =>
          (fixActions[candidate.key] ?? defaultFixAction(candidate)) === "delete"
      )
      .map((candidate) => candidate.url);

    setIsDeletingRedirects(true);

    try {
      await deleteRedirectUrls(params.id, fixRow.id, urls);
      setFixRow(null);
      setFindReplaceToast({
        tone: "success",
        message: `Removing ${formatNumber(urls.length)} URL${
          urls.length === 1 ? "" : "s"
        } from the sitemap in the background — results will update shortly.`
      });
      window.setTimeout(() => void refreshAfterMaintenance(), 6000);
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(nextError, "Unable to delete URLs.")
      });
    } finally {
      setIsDeletingRedirects(false);
    }
  }

  const fixActionFor = (candidate: RedirectCandidate): FixAction =>
    fixActions[candidate.key] ?? defaultFixAction(candidate);
  const fixCount = fixCandidates.filter(
    (candidate) => fixActionFor(candidate) === "fix"
  ).length;
  const deleteCount = fixCandidates.filter(
    (candidate) => fixActionFor(candidate) === "delete"
  ).length;
  const skipCount = fixCandidates.length - fixCount - deleteCount;
  const fixPageCount = Math.max(
    1,
    Math.ceil(fixCandidates.length / FIX_MODAL_PAGE_SIZE)
  );
  const fixPageSafe = Math.min(fixPage, fixPageCount - 1);
  const fixPageStart = fixPageSafe * FIX_MODAL_PAGE_SIZE;
  const pagedFixCandidates = fixCandidates.slice(
    fixPageStart,
    fixPageStart + FIX_MODAL_PAGE_SIZE
  );

  // ── One-click fix (v1.48) ────────────────────────────────────────────────
  // HTTP-verified rows whose confirmed destination looks like a dead end. These
  // are the ONLY rows the one-click action treats specially: adopting a
  // not-found destination would mark a dead link "healthy", so they are held
  // back from the adopt set and surfaced for a separate decision instead.
  const fixDeadSampled = fixCandidates.filter(
    (candidate) => candidate.is_sampled && candidate.destination_not_found
  );
  // HTTP-verified rows backing the rule — the evidence count worth stating.
  const fixSampledCount = fixCandidates.filter(
    (candidate) => candidate.is_sampled
  ).length;
  // The verified rows safe to adopt outright. Passed as url_ids so the dead ones
  // keep their "redirect" status and stay visible as outstanding work.
  const fixSafeSampledIds = fixCandidates
    .filter(
      (candidate) =>
        candidate.is_sampled &&
        candidate.sampled_url_id &&
        !candidate.destination_not_found
    )
    .map((candidate) => candidate.sampled_url_id as string);
  // Up to two verified before/after pairs, the same concrete reassurance the
  // transform modal's preview gives — enough to sanity-check the rule without
  // scrolling a thousand rows.
  const fixRuleExamples = fixCandidates
    .filter((candidate) => candidate.is_sampled && !candidate.destination_not_found)
    .slice(0, 2);
  // Every confirmed destination looks dead. The rule is distilled from those
  // same pairs, so it maps the WHOLE pattern onto not-found pages — there is no
  // safe one-click here, and offering one would quietly point the sitemap at a
  // dead landing page. Force the review list, where Delete is the real answer.
  const fixAllDestinationsDead =
    fixSampledCount > 0 && fixDeadSampled.length === fixSampledCount;
  // One click is offered whenever the samples distilled into a single rule:
  // there is exactly one transform, so per-row review adds nothing.
  const fixOneClickReady =
    !fixLoading &&
    fixRule !== null &&
    !fixReviewMode &&
    !fixAllDestinationsDead &&
    fixCandidates.length > 0;

  async function handleFixAllRedirects() {
    if (!fixRow || isFixing || isDeletingRedirects) {
      return;
    }

    setIsFixing(true);

    try {
      // widen:true is the whole request — no enumerated URL list. The server
      // re-derives the rule from the confirmed samples and streams it across
      // every <loc> in the pattern's files, so the capped preview pool never
      // bounds the result.
      const result = await applyPatternRedirects(
        params.id,
        fixRow.id,
        fixSafeSampledIds,
        undefined,
        true
      );

      setFixRow(null);

      if (result.queued) {
        setFindReplaceToast({
          tone: "success",
          message: `Applying redirect fixes across ${formatNumber(
            result.files_total ?? 0
          )} files in the background — results will update shortly.`
        });
        window.setTimeout(() => void loadResults({ silent: true }), 6000);
        return;
      }

      await loadResults({ silent: true });
      const changed = result.rewritten_loc_count ?? 0;
      setFindReplaceToast({
        tone: "success",
        message: `${formatNumber(changed)} URL${
          changed === 1 ? "" : "s"
        } updated to their redirect destinations${
          fixDeadSampled.length > 0
            ? ` · ${formatNumber(
                fixDeadSampled.length
              )} dead-link URL${
                fixDeadSampled.length === 1 ? "" : "s"
              } left flagged for review`
            : ""
        }`
      });
    } catch (nextError) {
      setFindReplaceToast({
        tone: "error",
        message: friendlyApiErrorMessage(
          nextError,
          "Unable to apply redirect fixes."
        )
      });
    } finally {
      setIsFixing(false);
    }
  }

  const renameSelectedOccurrences = renameSourceFiles
    .filter((file) => selectedRenameFiles.has(file.source_file))
    .reduce((sum, file) => sum + file.occurrences, 0);
  const renameAllSelected =
    renameSourceFiles.length > 0 &&
    selectedRenameFiles.size === renameSourceFiles.length;
  const renameUnchanged = renameValue === (renameRow?.template ?? "");
  const renameTooLong = renameValue.length > 500;
  const renameEmpty = renameValue.trim().length === 0;
  const canRename =
    renameRow !== null &&
    !renameEmpty &&
    !renameUnchanged &&
    !renameTooLong &&
    selectedRenameFiles.size > 0 &&
    !isRenaming;

  // Optional URL-structure transformation, entered below the label rename.
  // Empty "current structure" => label-only rename (backward compatible).
  const wantsTransform = transformCurrentStructure.trim().length > 0;
  let transformError: string | null = null;
  let transformParsed: { current: ParsedStructure; next: ParsedStructure } | null =
    null;

  if (wantsTransform) {
    if (transformNewStructure.trim().length === 0) {
      transformError = "Enter the new URL structure";
    } else {
      try {
        const current = parseStructure(transformCurrentStructure);
        const next = parseStructure(transformNewStructure);
        const validation = validateStructures(
          current,
          next,
          countTemplateParams(renameRow?.template ?? "")
        );

        if (validation) {
          transformError = validation;
        } else {
          transformParsed = { current, next };
        }
      } catch (error) {
        transformError =
          error instanceof StructureSyntaxError
            ? error.message
            : "Invalid transformation syntax";
      }
    }
  }

  const canPreviewTransform =
    renameRow !== null &&
    wantsTransform &&
    transformParsed !== null &&
    !renameTooLong &&
    !renameEmpty &&
    selectedRenameFiles.size > 0;

  // Build before/after samples from real sampled URLs for the Preview panel.
  const transformPreviewSamples =
    transformParsed && renameRow
      ? (samplesByPattern[renameRow.id] ?? [])
          .map((sample) => {
            const after = transformUrl(
              sample.url,
              transformParsed!.current,
              transformParsed!.next
            );

            return after ? { before: sample.url, after } : null;
          })
          .filter(
            (entry): entry is { before: string; after: string } =>
              entry !== null
          )
          .slice(0, 3)
      : [];

  const session = sessionData?.session;
  const zipReady = session?.zip_ready ?? false;
  // The pre-generated ZIP is still being built in the background (recently
  // completed). We show a spinner label for this but NEVER disable the button —
  // clicking always works and falls back to on-demand streaming server-side.
  const zipGenerating = session?.zip_generating ?? false;
  const hadPreambleStripped =
    sessionData?.sitemap_files.some((file) => file.had_preamble_stripped) ??
    false;
  const emptySitemapCount =
    sessionData?.sitemap_files.filter((file) => file.is_empty).length ?? 0;
  const emptySitemapFilenames =
    sessionData?.sitemap_files
      .filter((file) => file.is_empty)
      .map((file) => displayFilename(sessionData.session.id, file.filename)) ?? [];
  const hasSitemapFiles = (sessionData?.sitemap_files.length ?? 0) > 0;
  const allSitemapsEmpty =
    hasSitemapFiles && emptySitemapCount === sessionData?.sitemap_files.length;
  const hasSomeEmptySitemaps = emptySitemapCount > 0 && !allSitemapsEmpty;

  // Download-sitemaps counts + rough size estimate (~100 bytes per <loc>).
  // Deleted files are excluded from downloads, so they don't count here.
  const deletedSitemapCount =
    sessionData?.sitemap_files.filter((file) => file.is_deleted).length ?? 0;
  const currentSitemapFiles =
    sessionData?.sitemap_files.filter(
      (file) => file.source_role === "current" && !file.is_deleted
    ) ?? [];
  const editedSitemapCount = currentSitemapFiles.filter(
    (file) => file.is_edited
  ).length;
  const allSitemapCount = currentSitemapFiles.length;
  const estimateZipBytes = (files: typeof currentSitemapFiles) =>
    files.reduce((sum, file) => sum + Number(file.total_urls ?? 0) * 100, 0);

  function showDownloadError(nextError: unknown) {
    setFindReplaceToast({
      tone: "error",
      message: friendlyApiErrorMessage(
        nextError,
        "Unable to download sitemaps."
      )
    });
  }

  // Save a fetched ZIP: show "100%" for a beat, hide the overlay, then write the
  // file (directly to the saved folder, or via the Save As dialog). A success
  // toast names the target when it went straight into a folder.
  async function finishDownload(blob: Blob, filename: string) {
    setDownloadOverlay((prev) =>
      prev ? { ...prev, percent: 100, etaSeconds: 0, cancelling: false } : prev
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setDownloadOverlay(null);

    const savedTo = await saveDownloadZip(blob, filename);

    if (savedTo) {
      setFindReplaceToast({
        tone: "success",
        message: `Saved to ${savedTo}/${filename}`
      });
    }
  }

  // Fetch + save a sitemap ZIP. When the pre-generated (cached) ZIP is ready and
  // no per-download options apply, the download is instant (no overlay). Any
  // on-demand build shows the progress overlay and polls GET /api/sessions/:id
  // for live progress, handing off to the instant cache download if it lands
  // mid-flight.
  async function performDownload(opts: {
    type: "edited" | "all";
    filtered: boolean;
    excludeFileIds?: string[];
  }) {
    const { type, filtered } = opts;
    const excludeFileIds = opts.excludeFileIds ?? [];

    if (downloadingSitemaps || downloadOverlay) {
      return;
    }

    const files =
      type === "edited"
        ? currentSitemapFiles.filter((file) => file.is_edited)
        : currentSitemapFiles;
    const estimatedBytes = estimateZipBytes(files);

    if (estimatedBytes > 500 * 1024 * 1024) {
      const gb = (estimatedBytes / 1024 ** 3).toFixed(1);

      if (!window.confirm(`This download is approximately ${gb} GB. Continue?`)) {
        return;
      }
    }

    const canUseCache = filtered && excludeFileIds.length === 0 && zipReady;

    // Instant path: the pre-generated ZIP is ready — no overlay.
    if (canUseCache) {
      setDownloadingSitemaps(type);

      try {
        const { blob, filename } = await fetchSitemapsZipBlob(params.id, type, {
          filter: filtered
        });
        const savedTo = await saveDownloadZip(blob, filename);

        if (savedTo) {
          setFindReplaceToast({
            tone: "success",
            message: `Saved to ${savedTo}/${filename}`
          });
        }
      } catch (nextError) {
        showDownloadError(nextError);
      } finally {
        setDownloadingSitemaps(null);
      }

      return;
    }

    // On-demand path: show the progress overlay and poll for build progress.
    const controller = new AbortController();

    downloadAbortRef.current = controller;
    switchToCacheRef.current = false;

    const startedAt = Date.now();

    setDownloadOverlay({
      type,
      percent: 0,
      fileCurrent: 0,
      fileTotal: (type === "edited" ? editedSitemapCount : allSitemapCount) + 1,
      etaSeconds: null,
      cancelling: false
    });

    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getSession(params.id);

          setSessionData((prev) =>
            prev ? { ...prev, session: next.session } : next
          );

          // If the cached ZIP became ready and we could serve it, cancel the
          // on-demand fetch and switch to the instant download.
          if (
            filtered &&
            excludeFileIds.length === 0 &&
            next.session.zip_ready &&
            !switchToCacheRef.current
          ) {
            switchToCacheRef.current = true;
            controller.abort();

            return;
          }

          const percent = Math.max(
            0,
            Math.min(100, numberValue(next.session.zip_progress))
          );
          const fileCurrent = numberValue(next.session.zip_progress_file);
          const elapsed = (Date.now() - startedAt) / 1000;
          const etaSeconds =
            percent > 3
              ? Math.max(0, Math.round((elapsed / percent) * (100 - percent)))
              : null;

          setDownloadOverlay((prev) =>
            prev && !prev.cancelling
              ? {
                  ...prev,
                  percent,
                  fileCurrent: fileCurrent || prev.fileCurrent,
                  etaSeconds
                }
              : prev
          );
        } catch {
          // ignore; retry next tick
        }
      })();
    }, 2000);

    try {
      const { blob, filename } = await fetchSitemapsZipBlob(params.id, type, {
        filter: filtered,
        excludeFileIds,
        signal: controller.signal
      });

      await finishDownload(blob, filename);
    } catch (nextError) {
      if ((nextError as { name?: string })?.name === "AbortError") {
        // Cache handoff: re-fetch the now-ready pre-generated ZIP instantly.
        if (switchToCacheRef.current) {
          try {
            const cached = await fetchSitemapsZipBlob(params.id, type, {
              filter: true
            });

            await finishDownload(cached.blob, cached.filename);
          } catch (cacheError) {
            showDownloadError(cacheError);
          }
        }
        // Otherwise the user cancelled — silent no-op.
      } else {
        showDownloadError(nextError);
      }
    } finally {
      window.clearInterval(poll);
      downloadAbortRef.current = null;
      setDownloadOverlay(null);
    }
  }

  function handleCancelDownload() {
    switchToCacheRef.current = false;
    downloadAbortRef.current?.abort();
    setDownloadOverlay((prev) =>
      prev ? { ...prev, cancelling: true } : prev
    );
  }

  function toggleExcludedFile(fileId: string) {
    setExcludedFileIds((current) => {
      const next = new Set(current);

      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }

      return next;
    });
  }

  function toggleAllExcluded(affected: { file_id: string }[]) {
    setExcludedFileIds((current) =>
      current.size === affected.length
        ? new Set()
        : new Set(affected.map((file) => file.file_id))
    );
  }

  async function handleChangeDownloadFolder() {
    if (!supportsDirectoryPicker()) {
      setFindReplaceToast({
        tone: "error",
        message:
          "Folder saving not supported in this browser — files will save to Downloads."
      });

      return;
    }

    try {
      const name = await chooseDownloadFolder();

      setDownloadFolderName(name);

      if (name) {
        setFindReplaceToast({
          tone: "success",
          message: `Download folder set: ${name}`
        });
      }
    } catch {
      setFindReplaceToast({
        tone: "error",
        message: "Couldn't set the download folder."
      });
    }
  }

  // Entry point for the Download Sitemaps menu items. First checks whether any
  // files contain foreign-domain URLs the filtered download would strip; if so,
  // shows a warning modal (so a near-empty file is never a silent surprise),
  // otherwise downloads immediately with filtering as before.
  async function handleDownloadSitemaps(type: "edited" | "all") {
    if (downloadingSitemaps || previewingDownload || downloadOverlay) {
      return;
    }

    setPreviewingDownload(type);

    let preview: DownloadPreview | null = null;

    try {
      preview = await getDownloadPreview(params.id, type);
    } catch {
      // Preview is best-effort: if it fails, fall back to a normal filtered
      // download rather than blocking the user.
      preview = null;
    } finally {
      setPreviewingDownload(null);
    }

    if (preview && preview.has_foreign_urls) {
      // Default: every affected file ticked (i.e. excluded). The user unticks
      // the ones they want kept (domain-filtered) in the ZIP.
      setExcludedFileIds(
        new Set(preview.affected_files.map((file) => file.file_id))
      );
      setForeignWarning({ type, preview });

      return;
    }

    await performDownload({ type, filtered: true });
  }
  const safeHealthScore = Math.max(0, Math.min(100, dashboard.healthScore));
  const summaryCards = [
    {
      label: "Healthy Patterns",
      value: dashboard.statusCounts.GOOD,
      icon: CheckCircle2,
      borderClass: "border-l-emerald-500",
      className: "text-emerald-700"
    },
    {
      label: "Warning Patterns",
      value: dashboard.statusCounts.WARNING,
      icon: TriangleAlert,
      borderClass: "border-l-amber-500",
      className: "text-amber-700"
    },
    {
      label: "Broken Patterns",
      value: dashboard.statusCounts.BAD,
      icon: XCircle,
      borderClass: "border-l-red-500",
      className: "text-red-700"
    },
    {
      label: "Redirect Issues",
      value: dashboard.redirectIssueCount,
      icon: ExternalLink,
      detail: `${dashboard.redirectHeavyCount} heavy / ${dashboard.redirectArtifactCount} artifacts`,
      borderClass: "border-l-amber-500",
      className: "text-amber-700"
    },
    {
      label: "Soft-404 Patterns",
      value: dashboard.soft404PatternCount,
      icon: TriangleAlert,
      borderClass: "border-l-orange-500",
      className: "text-orange-700"
    },
    {
      label: "Mismatched URLs",
      value: dashboard.mismatchCount,
      icon: AlertCircle,
      borderClass:
        dashboard.mismatchCount > 0 ? "border-l-red-500" : "border-l-indigo-500",
      className: dashboard.mismatchCount > 0 ? "text-red-700" : "text-indigo-700"
    }
  ];

  if (error && !isLoading && !sessionData) {
    return (
      <main className="min-h-screen bg-muted/30">
        <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-4 py-6 sm:px-6 lg:px-8">
          <Card>
            <CardHeader>
              <CardTitle>Unable to load this analysis</CardTitle>
              <CardDescription>
                The session data could not be loaded right now.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link href="/sessions">Go back</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/">New Analysis</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    );
  }

  return (
    <main
      className="min-h-[calc(100vh-56px)] bg-slate-50"
      data-export-ready={!isLoading && !error ? "true" : "false"}
    >
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold text-slate-900 sm:text-3xl">
              {session?.name ?? (isLoading ? "Loading session" : "Results")}
            </h1>
            <p className="mt-2 break-all font-mono text-xs text-slate-500">
              {session?.base_url ?? "Base URL unavailable"}
            </p>
          </div>
          {!isPrintMode ? (
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Button asChild variant="outline">
                <Link href="/sessions">Back to History</Link>
              </Button>
              <Button asChild>
                <Link href="/">New Analysis</Link>
              </Button>
              {hasSitemapFiles ? (
                <Button asChild variant="outline">
                  <Link href={`/sessions/${params.id}/files`}>
                    <FileText className="mr-2 h-4 w-4" />
                    Files
                  </Link>
                </Button>
              ) : null}
              {session?.status === "COMPLETE" ||
              session?.status === "COMPLETED" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
                  disabled={bulkBusy}
                  onClick={() => openBulkReplace()}
                >
                  {bulkBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Layers className="mr-2 h-4 w-4" />
                  )}
                  {bulkBusy ? "Bulk replace running" : "Bulk Replace"}
                </Button>
              ) : null}
              {(session?.status === "COMPLETE" ||
                session?.status === "COMPLETED") &&
              hasSitemapFiles ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
                  onClick={() => {
                    // If slashes were already applied, warn before re-running
                    // (v1.31 Fix 4); otherwise go straight to the preview modal.
                    if (session?.trailing_slash_fixed_at) {
                      setSlashRerunOpen(true);
                    } else {
                      setTrailingSlashOpen(true);
                    }
                  }}
                >
                  <Slash className="mr-2 h-4 w-4" />
                  Fix Trailing Slashes
                </Button>
              ) : null}
              {(session?.status === "COMPLETE" ||
                session?.status === "COMPLETED") &&
              problemUrlCount > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                  onClick={() => setProblemUrlsOpen(true)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete URLs ({formatNumber(problemUrlCount)})
                </Button>
              ) : null}
              {hasDeletedUrls ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                  disabled={maintenanceBusy}
                  onClick={() => void handleRestoreDeletedUrls()}
                >
                  {maintenanceBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Undo2 className="mr-2 h-4 w-4" />
                  )}
                  Undo URL deletions
                </Button>
              ) : null}
              {slashApplied ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                  disabled={maintenanceBusy}
                  onClick={() => void handleUndoTrailingSlashes()}
                >
                  {maintenanceBusy ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Undo2 className="mr-2 h-4 w-4" />
                  )}
                  Undo Trailing Slashes
                </Button>
              ) : null}
              {bulkStatus?.status === "COMPLETE" ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                  onClick={() => openBulkUndo()}
                >
                  <Undo2 className="mr-2 h-4 w-4" />
                  Undo bulk replace
                </Button>
              ) : null}
              {hasReplacements ? (
                <Button
                  type="button"
                  variant="outline"
                  className="border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                  disabled={isUndoing || isLoading}
                  onClick={() => {
                    setFindReplaceToast(null);
                    setIsUndoConfirmOpen(true);
                  }}
                >
                  <Undo2 className="mr-2 h-4 w-4" />
                  Undo last replace
                </Button>
              ) : null}
              {(session?.status === "COMPLETE" ||
                session?.status === "COMPLETED") &&
              hasSitemapFiles ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      disabled={
                        downloadingSitemaps !== null ||
                        previewingDownload !== null ||
                        downloadOverlay !== null
                      }
                      title={
                        !zipReady && zipGenerating
                          ? "The download is being prepared in the background — you can click to download now (it may take a little longer)"
                          : undefined
                      }
                    >
                      {downloadingSitemaps ||
                      previewingDownload ||
                      downloadOverlay ||
                      (!zipReady && zipGenerating) ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-2 h-4 w-4" />
                      )}
                      {downloadingSitemaps || downloadOverlay
                        ? "Preparing ZIP"
                        : previewingDownload
                          ? "Checking…"
                          : !zipReady && zipGenerating
                            ? "Preparing… (click to download)"
                            : "Download Sitemaps"}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={editedSitemapCount === 0}
                      onSelect={() => void handleDownloadSitemaps("edited")}
                    >
                      Edited files only ({formatNumber(editedSitemapCount)}{" "}
                      {editedSitemapCount === 1 ? "file" : "files"})
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void handleDownloadSitemaps("all")}
                    >
                      All files ({formatNumber(allSitemapCount)}{" "}
                      {allSitemapCount === 1 ? "file" : "files"})
                    </DropdownMenuItem>
                    {deletedSitemapCount > 0 ? (
                      <p className="px-2 py-1.5 text-xs text-amber-700">
                        {formatNumber(deletedSitemapCount)} deleted{" "}
                        {deletedSitemapCount === 1 ? "sitemap" : "sitemaps"}{" "}
                        excluded
                      </p>
                    ) : null}
                    <div className="my-1 h-px bg-slate-100" aria-hidden="true" />
                    {downloadFolderName ? (
                      <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-slate-600">
                        <span className="flex min-w-0 items-center gap-1">
                          <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          <span className="truncate">
                            Download folder:{" "}
                            <span className="font-medium">
                              {downloadFolderName}
                            </span>
                          </span>
                        </span>
                        <button
                          type="button"
                          className="shrink-0 font-medium text-indigo-600 hover:text-indigo-700"
                          onClick={(event) => {
                            event.preventDefault();
                            void handleChangeDownloadFolder();
                          }}
                        >
                          Change
                        </button>
                      </div>
                    ) : (
                      <DropdownMenuItem
                        onSelect={(event) => {
                          event.preventDefault();
                          void handleChangeDownloadFolder();
                        }}
                      >
                        <Folder className="mr-2 h-4 w-4" aria-hidden="true" />
                        Change download folder…
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button disabled={!session || isLoading} variant="outline">
                    {exportingFormat ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    {exportingFormat ? "Exporting" : "Export"}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void startExport("csv")}>
                    CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void startExport("xlsx")}>
                    Excel
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void startExport("pdf")}>
                    PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
          <div className="space-y-6">
            {error ? (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </div>
            ) : null}

            {session?.status === "FAILED" ? (
              <div
                className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                role="alert"
                data-testid="results-failed-banner"
              >
                <div className="flex items-start gap-2 text-sm text-amber-900">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    This session failed during processing — results may be
                    incomplete.
                  </span>
                </div>
                <div className="flex flex-col items-start gap-1 sm:items-end">
                  <Button
                    type="button"
                    size="sm"
                    className="bg-amber-600 hover:bg-amber-700"
                    disabled={isResuming}
                    onClick={() => void handleResume()}
                  >
                    {isResuming ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    )}
                    {isResuming ? "Resuming…" : "Resume processing"}
                  </Button>
                  {resumeError ? (
                    <span className="text-xs text-red-600">{resumeError}</span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {numberValue(session?.resume_count) > 0 ? (
              <p className="text-xs text-slate-500">
                Session was resumed {formatNumber(numberValue(session?.resume_count))}{" "}
                {numberValue(session?.resume_count) === 1 ? "time" : "times"}.
              </p>
            ) : null}

            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading dashboard
              </div>
            ) : null}

            {hadPreambleStripped ? (
              <div
                className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900"
                role="status"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  This sitemap contained extra text before the XML content. It
                  was automatically cleaned and processed successfully.
                </span>
              </div>
            ) : null}

            {deletedSitemapCount > 0 ? (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                role="status"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {formatNumber(deletedSitemapCount)} sitemap{" "}
                  {deletedSitemapCount === 1 ? "file has" : "files have"} been
                  deleted and will be excluded from downloads. Pattern counts
                  include their URLs.{" "}
                  <Link
                    href={`/sessions/${params.id}/files`}
                    className="font-medium underline underline-offset-2"
                  >
                    Manage files
                  </Link>
                </span>
              </div>
            ) : null}

            {allSitemapsEmpty ? (
              <Card>
                <CardHeader className="items-center text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <FileText
                      className="h-6 w-6 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </div>
                  <CardTitle>No URLs found in your sitemap.</CardTitle>
                  <CardDescription className="max-w-xl">
                    The file was valid but contained no page links. Please check
                    that you uploaded the correct sitemap file.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex justify-center">
                  <Button asChild>
                    <Link href="/">Start New Analysis</Link>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <>
            {hasSomeEmptySitemaps ? (
              <div
                className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                role="status"
              >
                <div className="flex items-start gap-2">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    {emptySitemapCount === 1 ? (
                      <p>
                        1 sitemap file contained no URLs and was skipped:{" "}
                        <span className="break-all font-mono">
                          {emptySitemapFilenames[0]}
                        </span>
                      </p>
                    ) : emptySitemapCount <= 5 ? (
                      <p>
                        {emptySitemapCount} sitemap files contained no URLs and
                        were skipped:{" "}
                        <span className="break-all font-mono">
                          {emptySitemapFilenames.join(", ")}
                        </span>
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span>
                            {emptySitemapCount} sitemap files contained no URLs
                            and were skipped.
                          </span>
                          <button
                            type="button"
                            className="font-semibold text-amber-950 underline underline-offset-4"
                            onClick={() =>
                              setShowEmptySitemapFiles((current) => !current)
                            }
                          >
                            {showEmptySitemapFiles ? "Hide files" : "Show files"}
                          </button>
                        </div>
                        {showEmptySitemapFiles ? (
                          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-amber-200 bg-white/70 p-2 font-mono text-xs">
                            {emptySitemapFilenames.map((filename) => (
                              <li key={filename} className="break-all">
                                {filename}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {session?.connectivity_warning &&
            !connectivityDismissed &&
            !isPrintMode ? (
              <div
                role="alert"
                data-testid="connectivity-warning"
                className="relative rounded-lg border border-amber-300 bg-amber-50 p-4 pr-10 text-sm text-amber-900 shadow-sm"
              >
                <button
                  type="button"
                  aria-label="Dismiss connectivity warning"
                  onClick={dismissConnectivityWarning}
                  className="absolute right-2 top-2 rounded p-1 text-amber-700 hover:bg-amber-100 hover:text-amber-900"
                >
                  <span aria-hidden="true" className="text-lg leading-none">
                    ×
                  </span>
                </button>
                <div className="flex items-start gap-2">
                  <TriangleAlert
                    className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                    aria-hidden="true"
                  />
                  <div className="space-y-2">
                    <p className="font-semibold">
                      Network connectivity issue — results may be inaccurate
                    </p>
                    <p>90%+ of URLs could not be reached. This usually means:</p>
                    <ul className="list-disc space-y-1 pl-5">
                      <li>
                        A corporate firewall or VPN is blocking outbound
                        connections
                      </li>
                      <li>The Docker container cannot reach the internet</li>
                      <li>The website may be temporarily down</li>
                    </ul>
                    <p>
                      <span className="font-semibold">Quick fix:</span> add{" "}
                      <code className="rounded bg-amber-100 px-1 font-mono text-xs">
                        NODE_TLS_REJECT_UNAUTHORIZED=0
                      </code>{" "}
                      to your{" "}
                      <span className="font-mono text-xs">
                        docker-compose.yml
                      </span>{" "}
                      worker environment, then restart Docker and run a new
                      analysis.
                    </p>
                    <p className="text-amber-800">
                      Pattern structure analysis is still valid — only HTTP
                      status checks are affected.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            <div
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              data-testid="summary-cards"
            >
              <Card
                className={cn(
                  "border-l-4 lg:col-span-2",
                  scoreBorderClass(dashboard.healthScore)
                )}
              >
                <CardHeader className="flex flex-row items-center justify-between gap-5 pb-4">
                  <div>
                    <CardDescription className="text-sm text-slate-500">
                      Overall Health Score
                    </CardDescription>
                    <CardTitle
                      className={cn(
                        "mt-3 text-5xl font-bold",
                        scoreColorClass(dashboard.healthScore)
                      )}
                    >
                      {formatNumber(dashboard.healthScore)}
                      <span className="text-lg font-semibold text-slate-400">
                        /100
                      </span>
                    </CardTitle>
                    <p className="mt-2 text-sm text-slate-500">
                      {formatNumber(dashboard.totalUrls)} URLs analyzed
                    </p>
                  </div>
                  <div
                    className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full p-2"
                    style={{
                      background: `conic-gradient(${scoreRingColor(
                        dashboard.healthScore
                      )} ${safeHealthScore}%, #E2E8F0 0)`
                    }}
                    aria-hidden="true"
                  >
                    <div className="flex h-full w-full items-center justify-center rounded-full bg-white text-xl font-bold text-slate-900 shadow-inner">
                      {safeHealthScore}%
                    </div>
                  </div>
                </CardHeader>
              </Card>
              {summaryCards.map((card) => {
                const Icon = card.icon;

                return (
                  <Card
                    key={card.label}
                    className={cn("border-l-4", card.borderClass)}
                  >
                    <CardHeader className="space-y-2 pb-3">
                      <div className="flex items-center justify-between gap-3">
                        <CardDescription className="text-sm text-slate-500">
                          {card.label}
                        </CardDescription>
                        <Icon
                          className={cn("h-4 w-4", card.className)}
                          aria-hidden="true"
                        />
                      </div>
                      <CardTitle
                        className={cn("text-3xl font-bold", card.className)}
                      >
                        {formatNumber(card.value)}
                      </CardTitle>
                      {"detail" in card ? (
                        <p className="text-xs font-medium text-slate-500">
                          {card.detail}
                        </p>
                      ) : null}
                    </CardHeader>
                  </Card>
                );
              })}
            </div>

            <section
              className="rounded-xl border border-slate-200 bg-slate-50 p-4"
              data-testid="charts-row"
            >
              <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold text-slate-700">
                    Pattern health
                  </CardTitle>
                  <CardDescription className="text-sm text-slate-500">
                    Distribution of healthy, warning, and broken patterns.
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={healthDistribution}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={70}
                        outerRadius={105}
                        paddingAngle={3}
                        isAnimationActive={false}
                      >
                        {healthDistribution.map((entry) => (
                          <Cell
                            key={entry.status}
                            fill={statusColors[entry.status]}
                          />
                        ))}
                      </Pie>
                      <RechartsTooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold text-slate-700">
                    Largest URL groups
                  </CardTitle>
                  <CardDescription className="text-sm text-slate-500">
                    Top 10 patterns by number of URLs.
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={topPatternData}
                      layout="vertical"
                      margin={{ left: 16, right: 16, top: 8, bottom: 8 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" />
                      <YAxis
                        dataKey="shortTemplate"
                        type="category"
                        width={170}
                        tick={{ fontSize: 12 }}
                      />
                      <RechartsTooltip />
                      <Bar
                        dataKey="totalUrls"
                        isAnimationActive={false}
                        radius={[0, 4, 4, 0]}
                      >
                        {topPatternData.map((entry) => (
                          <Cell
                            key={entry.id}
                            fill={statusColors[entry.status]}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              </div>
            </section>

            <Card data-testid="insight-block">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-700">
                  What needs attention
                  {dashboard.insights.length > 0 ? (
                    <Badge variant="secondary">
                      {formatNumber(dashboard.insights.length)}
                    </Badge>
                  ) : null}
                </CardTitle>
                <CardDescription className="text-sm text-slate-500">
                  Plain-English notes for patterns that may affect search traffic.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {dashboard.insights.length > 0 ? (
                  // Cap the visible height so a long list (many patterns) doesn't
                  // push the Pattern Details table far down — the overflow
                  // scrolls. Only constrain when it actually overflows (~5+
                  // insights) and never in print mode, so the PDF export isn't
                  // clipped. maxHeight ≈ 5 insight rows. (v1.35)
                  <div
                    className={cn(
                      !isPrintMode && dashboard.insights.length > 5
                        ? "overflow-y-auto rounded-lg border border-slate-200 p-2 shadow-inner"
                        : undefined
                    )}
                    style={
                      !isPrintMode && dashboard.insights.length > 5
                        ? { maxHeight: 320 }
                        : undefined
                    }
                  >
                    <ul className="space-y-3 text-sm">
                      {dashboard.insights.map((insight) => {
                        const tone = insightTone(insight);
                        const Icon = tone.Icon;

                        return (
                          <li
                            key={insight}
                            className={cn(
                              "flex items-start gap-3 rounded-lg border border-slate-200 border-l-4 px-4 py-3 text-slate-700",
                              tone.borderClass,
                              tone.bgClass
                            )}
                          >
                            <Icon
                              className={cn(
                                "mt-0.5 h-4 w-4 shrink-0",
                                tone.iconClass
                              )}
                              aria-hidden="true"
                            />
                            <span>{insight}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500">
                    No urgent pattern issues found in the sampled URLs.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card data-testid="pattern-table-card">
              <CardHeader>
                <CardTitle className="text-base font-semibold text-slate-700">
                  Pattern details
                </CardTitle>
                <CardDescription className="text-sm text-slate-500">
                  Click a row to review the sampled URLs for that pattern.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {!isPrintMode ? (
                  <div className="mb-4 flex items-center gap-2">
                    <label
                      htmlFor="status-filter"
                      className="text-sm font-medium text-slate-500"
                    >
                      Status
                    </label>
                    <select
                      id="status-filter"
                      value={statusFilter}
                      onChange={(event) =>
                        setStatusFilter(event.target.value as StatusFilter)
                      }
                      className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      <option value="ALL">All</option>
                      <option value="GOOD">GOOD</option>
                      <option value="WARNING">WARNING</option>
                      <option value="BAD">BAD</option>
                    </select>
                  </div>
                ) : null}
                <div className="max-h-[680px] overflow-auto rounded-xl border border-slate-200">
                  <table className="w-full table-fixed border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-50 shadow-sm">
                      {table.getHeaderGroups().map((headerGroup) => (
                        <tr key={headerGroup.id}>
                          {headerGroup.headers.map((header) => {
                            const meta = header.column.columnDef.meta as
                              | PatternColumnMeta
                              | undefined;

                            return (
                              <th
                                key={header.id}
                                style={{
                                  width: meta?.width,
                                  minWidth: meta?.minWidth ?? meta?.width
                                }}
                                className={cn(
                                  "border-b border-slate-200 px-3 py-3 text-left text-xs font-semibold uppercase text-slate-500",
                                  meta?.sticky &&
                                    "sticky left-0 z-20 border-r border-slate-200 bg-slate-50"
                                )}
                              >
                                {header.isPlaceholder
                                  ? null
                                  : flexRender(
                                      header.column.columnDef.header,
                                      header.getContext()
                                    )}
                              </th>
                            );
                          })}
                        </tr>
                      ))}
                    </thead>
                    <tbody>
                      {table.getRowModel().rows.length > 0 ? (
                        table.getRowModel().rows.map((row) => (
                          <tr
                            key={row.id}
                            data-pattern-row={row.original.id}
                            tabIndex={0}
                            className="group cursor-pointer border-b border-slate-100 odd:bg-slate-50 even:bg-white transition-colors hover:bg-indigo-50/60 focus:bg-indigo-50/60 focus:outline-none"
                            onClick={() => {
                              openPatternDrawer(row.original);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openPatternDrawer(row.original);
                              }
                            }}
                          >
                            {row.getVisibleCells().map((cell) => {
                              const meta = cell.column.columnDef.meta as
                                | PatternColumnMeta
                                | undefined;

                              return (
                                <td
                                  key={cell.id}
                                  style={{
                                    width: meta?.width,
                                    minWidth: meta?.minWidth ?? meta?.width
                                  }}
                                  className={cn(
                                    "px-3 py-3 align-middle text-slate-600",
                                    meta?.sticky &&
                                      "sticky left-0 z-10 border-r border-slate-200 bg-inherit"
                                  )}
                                >
                                  {flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext()
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td
                            colSpan={columns.length}
                            className="px-3 py-8 text-center text-muted-foreground"
                          >
                            No patterns match this status filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
              </>
            )}
          </div>
        </section>

        <Sheet open={isSheetOpen} onOpenChange={setIsSheetOpen}>
          <SheetContent className="flex flex-col overflow-hidden p-0 [&>button]:text-slate-300 [&>button:hover]:text-white">
            <SheetHeader className="border-b border-slate-800 bg-slate-900 px-6 py-5">
              <SheetTitle className="break-all font-mono text-sm text-white">
                {selectedRow?.template ?? "Pattern samples"}
              </SheetTitle>
              <SheetDescription className="text-slate-300">
                Sampled URLs checked for this pattern.
              </SheetDescription>
              {selectedRow ? (
                <button
                  type="button"
                  aria-label={`Edit pattern ${selectedRow.template}`}
                  onClick={() => {
                    const row = selectedRow;

                    setIsSheetOpen(false);
                    void openRenameModal(row, { fromDrawer: true });
                  }}
                  className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-md border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-100 hover:bg-slate-700"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit pattern
                </button>
              ) : null}
            </SheetHeader>
            <div className="flex-1 overflow-y-auto bg-slate-50 px-6 py-5">
              {redirectSamples.length > 0 ? (
                <div
                  className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4"
                  data-testid="redirect-banner"
                >
                  <p className="flex items-start gap-2 text-sm font-medium text-amber-900">
                    <ExternalLink className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {formatNumber(redirectSamples.length)} of{" "}
                      {formatNumber(selectedSamples.length)} sampled URLs redirect
                      to a different address.
                    </span>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-3 bg-amber-600 hover:bg-amber-700"
                    disabled={isApplyingRedirects}
                    onClick={() => void handleApplyAllRedirects()}
                  >
                    {isApplyingRedirects ? (
                      <>
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        Replacing
                      </>
                    ) : (
                      "Replace all redirect URLs with their destinations"
                    )}
                  </Button>
                </div>
              ) : null}
              {drawerLoading && selectedSamples.length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center gap-3 py-16 text-sm text-slate-500"
                  data-testid="drawer-loading"
                >
                  <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
                  <span>Loading URL details…</span>
                </div>
              ) : drawerError && selectedSamples.length === 0 ? (
                <div
                  className="flex flex-col items-center justify-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-6 py-12 text-center"
                  role="alert"
                  data-testid="drawer-error"
                >
                  <TriangleAlert className="h-7 w-7 text-amber-600" />
                  <p className="text-sm font-semibold text-amber-900">
                    Could not load URL details
                  </p>
                  <p className="max-w-xs text-xs text-amber-800">
                    {drawerError} This pattern may have too many URLs to load
                    quickly.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-amber-300 text-amber-800 hover:bg-amber-100 hover:text-amber-900"
                    disabled={drawerLoading}
                    onClick={() => {
                      if (selectedRow) {
                        void loadDrawerSamples(selectedRow.id);
                      }
                    }}
                  >
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              ) : selectedSamples.length > 0 ? (
                <div className="space-y-3" data-testid="sample-url-list">
                  {selectedSamples.map((sample) => {
                    const tone = sampleTone(sample);
                    const category = effectiveSampleCategory(sample);
                    const isDeleted =
                      sample.is_deleted_from_sitemap === true;
                    const isDeletable =
                      category === "redirect" ||
                      (category === "failure" &&
                        numberValue(sample.http_status) === 404);

                    return (
                      <div
                        key={sample.id}
                        className={cn(
                          "rounded-lg border border-slate-200 border-l-4 bg-white p-4 text-sm shadow-sm",
                          tone.borderClass,
                          isDeleted && "opacity-70"
                        )}
                      >
                        <div className="flex flex-col gap-3">
                          <div className="min-w-0 space-y-2">
                            <p
                              className={cn(
                                "truncate font-mono text-xs font-semibold",
                                isDeleted
                                  ? "text-slate-400 line-through"
                                  : "text-slate-900"
                              )}
                              title={sample.url}
                            >
                              {sample.url}
                            </p>
                            {isDeleted ? (
                              <p className="text-xs font-medium text-slate-400">
                                Removed from sitemap
                              </p>
                            ) : null}
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <Badge
                                variant={tone.badgeVariant}
                                className="gap-1"
                              >
                                <span aria-hidden="true">{tone.icon}</span>
                                {categoryLabel(category)}
                              </Badge>
                              {numberValue(sample.http_status) ? (
                                <span>
                                  HTTP {numberValue(sample.http_status)}
                                </span>
                              ) : (
                                <span className="font-medium text-red-600">
                                  {noResponseMessage(sample)}
                                </span>
                              )}
                              <span>{numberValue(sample.response_ms)} ms</span>
                            </div>
                            {category === "redirect" &&
                            sample.final_url &&
                            sample.url !== sample.final_url ? (
                              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2">
                                <p className="text-xs font-semibold text-emerald-800">
                                  ↳ Redirects to:
                                </p>
                                <p
                                  className="mt-1 flex items-center gap-1 truncate font-mono text-xs text-emerald-700"
                                  title={sample.final_url}
                                >
                                  <span aria-hidden="true">✅</span>
                                  <span className="truncate">
                                    {sample.final_url}
                                  </span>
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 border-emerald-300 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
                                    onClick={() =>
                                      void copyText(
                                        sample.final_url ?? "",
                                        `final-${sample.id}`
                                      )
                                    }
                                  >
                                    <Clipboard className="mr-1 h-3 w-3" />
                                    {copiedSampleId === `final-${sample.id}`
                                      ? "Copied"
                                      : "Copy"}
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    className="h-7 bg-emerald-600 hover:bg-emerald-700"
                                    disabled={usingRedirectId === sample.id}
                                    onClick={() => void handleUseThisUrl(sample)}
                                  >
                                    {usingRedirectId === sample.id ? (
                                      <>
                                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                        Updating
                                      </>
                                    ) : (
                                      "Use this URL"
                                    )}
                                  </Button>
                                </div>
                              </div>
                            ) : sample.final_url ? (
                              <p
                                className="truncate font-mono text-xs text-slate-500"
                                title={sample.final_url}
                              >
                                Final URL: {sample.final_url}
                              </p>
                            ) : null}
                            <p
                              className="truncate font-mono text-xs text-slate-500"
                              title={
                                sample.source_file ??
                                selectedRow?.sourceFile ??
                                "Unknown"
                              }
                            >
                              Source:{" "}
                              {sample.source_file ??
                                selectedRow?.sourceFile ??
                                "Unknown"}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="w-fit shrink-0 border-indigo-200 text-indigo-700 hover:bg-indigo-50 hover:text-indigo-800"
                              onClick={() => void copyUrl(sample)}
                            >
                              <Clipboard className="mr-2 h-3.5 w-3.5" />
                              {copiedSampleId === sample.id ? "Copied" : "Copy"}
                            </Button>
                            {isDeletable && !isDeleted ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-fit shrink-0 border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                                onClick={() => setDeleteUrlTarget(sample)}
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                Delete from sitemap
                              </Button>
                            ) : null}
                            {isDeleted ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="w-fit shrink-0 border-amber-300 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                                disabled={restoringUrlId === sample.id}
                                onClick={() => void handleRestoreOneUrl(sample)}
                              >
                                {restoringUrlId === sample.id ? (
                                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Undo2 className="mr-2 h-3.5 w-3.5" />
                                )}
                                Undo deletion
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  No sampled URLs were saved for this pattern.
                </p>
              )}
            </div>
          </SheetContent>
        </Sheet>

        <Dialog
          open={fixRow !== null}
          onOpenChange={(open) => {
            if (!open) {
              setFixRow(null);
            }
          }}
        >
          <DialogContent className="max-h-[85vh] min-w-0 overflow-y-auto sm:max-w-2xl">
            <DialogHeader className="min-w-0">
              <DialogTitle>Fix Redirect URLs</DialogTitle>
              <DialogDescription>
                These URLs are redirecting to a different address. Accept the
                changes to update them to their final destinations.
              </DialogDescription>
            </DialogHeader>
            {/* min-w-0: DialogContent is a CSS grid, and a grid item's default
                min-width:auto lets long <loc> URLs force the column wider than
                the dialog (clipping the footer). min-w-0 here + truncation on
                the URL rows keeps everything within the dialog width. */}
            <div className="min-w-0 space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-700">Pattern</p>
                <p className="break-all rounded-md border border-slate-200 bg-slate-100 px-3 py-2 font-mono text-sm text-slate-500">
                  {fixRow?.template}
                </p>
              </div>
              {fixOneClickReady && fixRule ? (
                <>
                  <div className="space-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <p className="text-sm font-semibold text-slate-700">
                      {describeRedirectRule(fixRule)}
                    </p>
                    <p className="text-xs text-slate-500">
                      Confirmed by {formatNumber(fixSampledCount)} HTTP-checked
                      URL{fixSampledCount === 1 ? "" : "s"} that all redirect the
                      same way. Every matching URL in this pattern gets the same
                      rewrite.
                    </p>
                  </div>

                  {fixRuleExamples.length > 0 ? (
                    <ul className="space-y-2">
                      {fixRuleExamples.map((sample) => (
                        <li
                          key={sample.key}
                          className="min-w-0 rounded-md border border-slate-200 px-3 py-2 text-xs"
                        >
                          <p className="min-w-0 truncate" title={sample.url}>
                            <span className="text-slate-400">Before: </span>
                            <span className="font-mono">{sample.url}</span>
                          </p>
                          <p
                            className="min-w-0 truncate"
                            title={sample.final_url}
                          >
                            <span className="text-emerald-600">After: </span>
                            <span className="font-mono text-emerald-700">
                              {sample.final_url}
                            </span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <p className="rounded-md bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-800">
                    Fixing {formatNumber(fixPatternTotal)} matching URL
                    {fixPatternTotal === 1 ? "" : "s"}
                    {fixFileCount > 0 ? (
                      <>
                        {" "}
                        across {formatNumber(fixFileCount)} file
                        {fixFileCount === 1 ? "" : "s"}
                      </>
                    ) : null}
                  </p>

                  {/* Soft-404 safety net: these are HTTP-verified rows whose
                      confirmed destination looks like a not-found page. Adopting
                      it would mark a dead link healthy, so they are held out of
                      the adopt set and surfaced here for a separate decision —
                      deliberately a note beside the main button, not a blocker
                      on it. */}
                  {fixDeadSampled.length > 0 ? (
                    <div className="space-y-1 rounded-md bg-amber-50 px-3 py-2">
                      <p className="text-sm font-medium text-amber-900">
                        ⚠️ {formatNumber(fixDeadSampled.length)} of these look
                        like dead links — review separately
                      </p>
                      <p className="text-xs text-amber-800">
                        Their confirmed destination looks like a not-found page,
                        so they are left flagged instead of being marked fixed.
                        The pattern rewrite still updates their URL text, so
                        they will point at a dead page — deleting them is
                        usually the right follow-up. Open &ldquo;Review
                        individually&rdquo; to do that.
                      </p>
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setFixRow(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isFixing}
                      onClick={() => setFixReviewMode(true)}
                    >
                      Review individually
                    </Button>
                    <Button
                      type="button"
                      className="bg-amber-600 hover:bg-amber-700"
                      disabled={isFixing || isDeletingRedirects}
                      onClick={() => void handleFixAllRedirects()}
                    >
                      {isFixing ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Applying
                        </>
                      ) : (
                        `Fix all ${formatNumber(fixPatternTotal)} URLs`
                      )}
                    </Button>
                  </div>
                </>
              ) : (
                <>
              <p className="text-xs text-slate-500">
                Sampled URLs were HTTP-checked and confirmed redirecting; the
                rest match this pattern and get the same confirmed rewrite
                applied by inference (not individually verified).
              </p>
              {fixAllDestinationsDead ? (
                <div className="space-y-1 rounded-md bg-amber-50 px-3 py-2">
                  <p className="text-sm font-medium text-amber-900">
                    ⚠️ No safe one-click fix for this pattern
                  </p>
                  <p className="text-xs text-amber-800">
                    All {formatNumber(fixSampledCount)} confirmed destination
                    {fixSampledCount === 1 ? "" : "s"} look like not-found
                    pages, so redirecting to them would just point the sitemap
                    at a dead page. Delete these URLs instead of adopting them.
                  </p>
                </div>
              ) : fixRule !== null ? (
                <button
                  type="button"
                  className="text-left text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                  onClick={() => setFixReviewMode(false)}
                >
                  ← Back to one-click fix
                </button>
              ) : null}
              {fixPatternTotal > fixCandidates.length ? (
                <p className="rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                  Showing {formatNumber(fixCandidates.length)} for review —
                  accepting applies the confirmed rule to all{" "}
                  {formatNumber(fixPatternTotal)} matching URLs across this
                  pattern&rsquo;s files.
                </p>
              ) : null}
              {fixInferredWithoutRule ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Only the sampled URLs are listed — the confirmed redirects were
                  too varied to infer a single rewrite rule for the rest.
                </p>
              ) : null}
              <div className="rounded-md border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                  <button
                    type="button"
                    className="text-sm font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-40"
                    onClick={setAllFix}
                    disabled={fixCandidates.length === 0}
                  >
                    Set all to Fix
                  </button>
                  <span className="text-xs text-slate-500">
                    {fixPatternTotal > fixCandidates.length
                      ? `${formatNumber(fixCandidates.length)} of ${formatNumber(
                          fixPatternTotal
                        )} shown`
                      : `${fixCandidates.length} URL${
                          fixCandidates.length === 1 ? "" : "s"
                        }`}
                  </span>
                </div>
                <div className="max-h-[320px] overflow-y-auto">
                  {fixLoading ? (
                    <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
                      Loading URLs…
                    </div>
                  ) : fixCandidates.length === 0 ? (
                    <p className="px-3 py-3 text-sm text-slate-500">
                      No redirect URLs remain for this pattern.
                    </p>
                  ) : (
                    <ul>
                      {pagedFixCandidates.map((candidate) => (
                        <li
                          key={candidate.key}
                          className="flex items-start gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span aria-hidden="true">❌</span>
                              <span
                                className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700"
                                title={candidate.url}
                              >
                                {candidate.url}
                              </span>
                              {candidate.destination_not_found ? (
                                <Badge
                                  variant="destructive"
                                  className="shrink-0 gap-1"
                                  title="The redirect destination looks like a not-found page — remove the source URL instead of adopting it."
                                >
                                  <span aria-hidden="true">⚠️</span>
                                  Not Found
                                </Badge>
                              ) : candidate.is_sampled ? (
                                <>
                                  {numberValue(candidate.http_status) ? (
                                    <Badge
                                      variant="warning"
                                      className="shrink-0"
                                    >
                                      {numberValue(candidate.http_status)}
                                    </Badge>
                                  ) : null}
                                  <Badge
                                    variant="success"
                                    className="shrink-0 gap-1"
                                  >
                                    <span aria-hidden="true">✓</span>
                                    Verified
                                  </Badge>
                                </>
                              ) : (
                                <Badge
                                  variant="secondary"
                                  className="shrink-0"
                                  title="Not individually HTTP-checked — inferred from the confirmed pattern rule"
                                >
                                  Unverified
                                </Badge>
                              )}
                            </div>
                            <div className="flex min-w-0 items-center gap-2">
                              <span aria-hidden="true">✅</span>
                              <span
                                className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-700"
                                title={candidate.final_url}
                              >
                                {candidate.final_url}
                              </span>
                            </div>
                          </div>
                          {/* Per-row Fix / Delete / Skip toggle. Delete is
                              disabled for inferred rows — the deletion engine can
                              only remove sampled URLs (see the footer note) — so
                              inferred rows can only be Skip (default) or Fix. */}
                          <div className="mt-0.5 flex shrink-0 overflow-hidden rounded-md border border-slate-300 text-xs font-semibold">
                            <button
                              type="button"
                              className={cn(
                                "px-2 py-1",
                                fixActionFor(candidate) === "fix"
                                  ? "bg-indigo-600 text-white"
                                  : "bg-white text-slate-600 hover:bg-slate-50"
                              )}
                              onClick={() => setFixAction(candidate.key, "fix")}
                            >
                              Fix
                            </button>
                            <button
                              type="button"
                              disabled={!candidate.is_sampled}
                              title={
                                candidate.is_sampled
                                  ? undefined
                                  : "Only sampled URLs can be deleted from the sitemap"
                              }
                              className={cn(
                                "border-l border-slate-300 px-2 py-1",
                                fixActionFor(candidate) === "delete"
                                  ? "bg-red-600 text-white"
                                  : "bg-white text-slate-600 hover:bg-slate-50",
                                !candidate.is_sampled &&
                                  "cursor-not-allowed opacity-40 hover:bg-white"
                              )}
                              onClick={() =>
                                candidate.is_sampled &&
                                setFixAction(candidate.key, "delete")
                              }
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              className={cn(
                                "border-l border-slate-300 px-2 py-1",
                                fixActionFor(candidate) === "skip"
                                  ? "bg-slate-500 text-white"
                                  : "bg-white text-slate-600 hover:bg-slate-50"
                              )}
                              onClick={() => setFixAction(candidate.key, "skip")}
                            >
                              Skip
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {!fixLoading && fixPageCount > 1 ? (
                  <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-xs text-slate-500">
                    <span>
                      Showing {formatNumber(fixPageStart + 1)}–
                      {formatNumber(
                        Math.min(
                          fixPageStart + FIX_MODAL_PAGE_SIZE,
                          fixCandidates.length
                        )
                      )}{" "}
                      of {formatNumber(fixCandidates.length)}
                    </span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40"
                        disabled={fixPageSafe === 0}
                        onClick={() => setFixPage((p) => Math.max(0, p - 1))}
                      >
                        Prev
                      </button>
                      <span className="px-1">
                        {fixPageSafe + 1} / {fixPageCount}
                      </span>
                      <button
                        type="button"
                        className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-40"
                        disabled={fixPageSafe >= fixPageCount - 1}
                        onClick={() =>
                          setFixPage((p) => Math.min(fixPageCount - 1, p + 1))
                        }
                      >
                        Next
                      </button>
                    </span>
                  </div>
                ) : null}
              </div>
              <p className="rounded-md bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-800">
                {formatNumber(fixCount)} to update, {formatNumber(deleteCount)}{" "}
                to delete
                {skipCount > 0 ? (
                  <span className="font-normal text-indigo-500">
                    {" "}
                    · {formatNumber(skipCount)} skipped
                  </span>
                ) : null}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setFixRow(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
                  disabled={deleteCount === 0 || isFixing || isDeletingRedirects}
                  onClick={() => void handleDeleteRedirects()}
                >
                  {isDeletingRedirects ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Deleting
                    </>
                  ) : (
                    `Delete Selected (${formatNumber(deleteCount)})`
                  )}
                </Button>
                <Button
                  type="button"
                  className="bg-amber-600 hover:bg-amber-700"
                  disabled={fixCount === 0 || isFixing || isDeletingRedirects}
                  onClick={() => void handleAcceptFixes()}
                >
                  {isFixing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Applying
                    </>
                  ) : (
                    `Accept Selected Changes (${formatNumber(fixCount)})`
                  )}
                </Button>
              </div>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>

        <Dialog
          open={renameRow !== null}
          onOpenChange={(open) => {
            if (!open) {
              setRenameRow(null);
            }
          }}
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Update Pattern</DialogTitle>
              <DialogDescription>
                Rename the pattern label and/or transform its URL structure
                across selected source files.
              </DialogDescription>
            </DialogHeader>
            {patternJob.phase !== "idle" ? (
              <PatternJobPanel
                job={patternJob.job}
                phase={patternJob.phase}
                skips={patternJobSkips}
                onDismiss={() => {
                  patternJob.reset();
                  setRenameRow(null);
                }}
              />
            ) : transformStep === "form" ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-slate-700">
                    Current pattern
                  </p>
                  <p className="break-all rounded-md border border-slate-200 bg-slate-100 px-3 py-2 font-mono text-sm text-slate-500">
                    {renameRow?.template}
                  </p>
                </div>
                <div className="space-y-1">
                  <label
                    htmlFor="rename-input"
                    className="text-sm font-semibold text-slate-700"
                  >
                    New pattern name
                  </label>
                  <Input
                    id="rename-input"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    autoComplete="off"
                    aria-invalid={renameTooLong}
                  />
                  {renameTooLong ? (
                    <p className="text-sm text-red-500" role="alert">
                      Too long (max 500 characters)
                    </p>
                  ) : renameUnchanged && !renameEmpty && !wantsTransform ? (
                    <p className="text-sm text-amber-600" role="alert">
                      Enter a name different from the current template, or add a
                      URL structure transformation below
                    </p>
                  ) : null}
                  {renameRedirectNote ? (
                    <p className="text-xs text-indigo-700">
                      ℹ️ Auto-detected from redirect destinations. Edit if
                      incorrect.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-3 rounded-md border border-dashed border-slate-300 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    URL Structure Transformation (optional)
                  </p>
                  <div className="space-y-1">
                    <label
                      htmlFor="transform-current"
                      className="text-sm font-semibold text-slate-700"
                    >
                      Current URL structure
                    </label>
                    <Input
                      id="transform-current"
                      value={transformCurrentStructure}
                      onChange={(event) =>
                        setTransformCurrentStructure(event.target.value)
                      }
                      placeholder="/manufacturer/{A}/{B}"
                      autoComplete="off"
                      className="font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label
                      htmlFor="transform-new"
                      className="text-sm font-semibold text-slate-700"
                    >
                      New URL structure
                    </label>
                    <Input
                      id="transform-new"
                      value={transformNewStructure}
                      onChange={(event) =>
                        setTransformNewStructure(event.target.value)
                      }
                      placeholder="/manufacturer/{A|-parts-catalog|}/{B}/"
                      autoComplete="off"
                      className="font-mono text-sm"
                      aria-invalid={Boolean(transformError)}
                    />
                    {renameStripNote ? (
                      <p className="text-xs text-indigo-700">
                        ℹ️ {renameStripNote}
                      </p>
                    ) : null}
                  </div>
                  <p className="text-xs text-slate-500">
                    Use {"{A}"}, {"{B}"}, {"{C}"}… to name each segment. You can
                    modify the values — e.g. if {"{A}"} contains
                    &quot;-parts-catalog&quot;, write{" "}
                    <code className="rounded bg-slate-100 px-1 font-mono">
                      {"{A|-parts-catalog|}"}
                    </code>{" "}
                    to strip it. Static segments and trailing slashes can be
                    added or removed.
                  </p>
                  {transformError ? (
                    <p className="text-sm text-red-500" role="alert">
                      {transformError}
                    </p>
                  ) : null}
                </div>

                <div className="rounded-md border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                    <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        checked={renameAllSelected}
                        onChange={toggleAllRenameFiles}
                        disabled={renameSourceFiles.length === 0}
                      />
                      Select all
                    </label>
                    <span className="text-xs text-slate-500">
                      {renameSourceFiles.length} file
                      {renameSourceFiles.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {isLoadingRenameFiles ? (
                      <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading source files…
                      </div>
                    ) : renameFilesError ? (
                      <p className="px-3 py-3 text-sm text-rose-600">
                        {renameFilesError}
                      </p>
                    ) : renameSourceFiles.length === 0 ? (
                      <p className="px-3 py-3 text-sm text-slate-500">
                        No source files found for this pattern.
                      </p>
                    ) : (
                      <ul>
                        {renameSourceFiles.map((file) => (
                          <li
                            key={file.source_file}
                            className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 last:border-b-0"
                          >
                            <label className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                              <input
                                type="checkbox"
                                className="h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                checked={selectedRenameFiles.has(
                                  file.source_file
                                )}
                                onChange={() =>
                                  toggleRenameFile(file.source_file)
                                }
                              />
                              <span
                                className="truncate font-mono text-xs"
                                title={file.source_file}
                              >
                                {file.source_file}
                              </span>
                            </label>
                            <span className="shrink-0 text-xs text-slate-500">
                              {formatNumber(file.occurrences)} occurrences
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <p className="rounded-md bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-800">
                  Changing {formatNumber(renameSelectedOccurrences)} occurrence
                  {renameSelectedOccurrences === 1 ? "" : "s"} across{" "}
                  {selectedRenameFiles.size} file
                  {selectedRenameFiles.size === 1 ? "" : "s"}
                </p>

                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setRenameRow(null)}
                  >
                    Cancel
                  </Button>
                  {wantsTransform ? (
                    <Button
                      type="button"
                      disabled={!canPreviewTransform}
                      onClick={() => setTransformStep("preview")}
                    >
                      Preview
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={!canRename}
                      onClick={() => void handleRenamePattern()}
                    >
                      {isRenaming ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Renaming
                        </>
                      ) : (
                        "Rename Pattern"
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm font-semibold text-slate-700">
                  Preview: URL Structure Transformation
                </p>
                <div className="space-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                  <p>
                    <span className="text-slate-500">Pattern:</span>{" "}
                    <span className="font-mono">{renameRow?.template}</span>
                  </p>
                  <p>
                    <span className="text-slate-500">Files affected:</span>{" "}
                    {formatNumber(selectedRenameFiles.size)}
                  </p>
                  <p>
                    <span className="text-slate-500">URLs to transform:</span>{" "}
                    {formatNumber(renameSelectedOccurrences)}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-slate-700">
                    Sample transformations (from sampled URLs)
                  </p>
                  {transformPreviewSamples.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No sampled URLs matched this structure — double-check the
                      current structure matches the pattern before applying.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {transformPreviewSamples.map((sample, index) => (
                        <li
                          key={index}
                          className="rounded-md border border-slate-200 px-3 py-2 text-xs"
                        >
                          <p className="break-all">
                            <span className="text-slate-400">Before: </span>
                            <span className="font-mono">{sample.before}</span>
                          </p>
                          <p className="break-all">
                            <span className="text-emerald-600">After: </span>
                            <span className="font-mono text-emerald-700">
                              {sample.after}
                            </span>
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  ⚠️ This will rewrite {formatNumber(selectedRenameFiles.size)}{" "}
                  XML file{selectedRenameFiles.size === 1 ? "" : "s"} on disk. A
                  backup is kept for undo.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setTransformStep("form")}
                    disabled={isTransforming}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    disabled={isTransforming}
                    onClick={() => void handleApplyTransform()}
                  >
                    {isTransforming ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Applying
                      </>
                    ) : (
                      `Apply to ${formatNumber(selectedRenameFiles.size)} file${
                        selectedRenameFiles.size === 1 ? "" : "s"
                      }`
                    )}
                  </Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>


        <Dialog open={isUndoConfirmOpen} onOpenChange={setIsUndoConfirmOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Undo last replace?</DialogTitle>
              <DialogDescription>
                This will restore all URLs to their previous values.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={isUndoing}
                onClick={() => setIsUndoConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={isUndoing}
                onClick={() => void handleUndoFindReplace()}
              >
                {isUndoing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Restoring
                  </>
                ) : (
                  "Undo replace"
                )}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog
          open={foreignWarning !== null}
          onOpenChange={(open) => {
            if (!open) setForeignWarning(null);
          }}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TriangleAlert className="h-5 w-5 text-amber-600" />
                Download warning
              </DialogTitle>
              <DialogDescription>
                Some files contain URLs from other domains. Select which files to
                exclude from this download. Excluded files are skipped — nothing
                is deleted from disk.
              </DialogDescription>
            </DialogHeader>

            {foreignWarning ? (
              <div className="space-y-3">
                {(() => {
                  const affected = foreignWarning.preview.affected_files;
                  const allChecked =
                    affected.length > 0 &&
                    affected.every((file) =>
                      excludedFileIds.has(file.file_id)
                    );

                  return (
                    <>
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                        <input
                          type="checkbox"
                          checked={allChecked}
                          onChange={() => toggleAllExcluded(affected)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        Select all ({affected.length}{" "}
                        {affected.length === 1 ? "file" : "files"} affected)
                      </label>

                      <div className="max-h-[300px] overflow-y-auto rounded-md border border-slate-200">
                        <ul className="divide-y divide-slate-100 text-sm">
                          {affected.map((file) => (
                            <li key={file.file_id}>
                              <label className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-slate-50">
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <input
                                    type="checkbox"
                                    checked={excludedFileIds.has(file.file_id)}
                                    onChange={() =>
                                      toggleExcludedFile(file.file_id)
                                    }
                                    className="h-4 w-4 shrink-0 rounded border-slate-300"
                                  />
                                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                                    {file.filename}
                                  </span>
                                </span>
                                <span className="shrink-0 text-xs text-amber-700">
                                  {file.foreign_url_count_is_minimum ? "≥" : ""}
                                  {formatNumber(file.foreign_url_count)} of{" "}
                                  {formatNumber(file.total_urls)} URLs foreign
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </>
                  );
                })()}

                <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <p>
                    Session domain:{" "}
                    <span className="font-mono">
                      {foreignWarning.preview.session_base_url}
                    </span>
                  </p>
                  <p className="mt-1">
                    Only URLs on this domain are kept in the filtered download.
                    {foreignWarning.preview.counts_are_sampled
                      ? " Counts are sampled minimums — affected files often lose every URL."
                      : ""}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setForeignWarning(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const type = foreignWarning?.type ?? "all";
                    setForeignWarning(null);
                    void performDownload({ type, filtered: true });
                  }}
                >
                  Download cleaned
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={excludedFileIds.size === 0}
                  onClick={() => {
                    const type = foreignWarning?.type ?? "all";
                    const excludeFileIds = Array.from(excludedFileIds);
                    setForeignWarning(null);
                    void performDownload({
                      type,
                      filtered: true,
                      excludeFileIds
                    });
                  }}
                >
                  Exclude {excludedFileIds.size}{" "}
                  {excludedFileIds.size === 1 ? "file" : "files"} & download
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    const type = foreignWarning?.type ?? "all";
                    setForeignWarning(null);
                    void performDownload({ type, filtered: false });
                  }}
                >
                  Download original
                </Button>
              </div>
              <p className="text-right text-xs text-slate-500">
                Cleaned = session domain URLs only · Original = all URLs as
                uploaded
              </p>
            </div>
          </DialogContent>
        </Dialog>

        {findReplaceToast ? (
          <div
            className={cn(
              "fixed bottom-4 right-4 z-50 max-w-sm rounded-md border bg-background px-4 py-3 text-sm shadow-lg",
              findReplaceToast.tone === "success"
                ? "border-emerald-300"
                : "border-destructive/30"
            )}
            role="status"
          >
            <div
              className={cn(
                "flex items-start gap-2",
                findReplaceToast.tone === "success"
                  ? "text-emerald-700"
                  : "text-destructive"
              )}
            >
              {findReplaceToast.tone === "success" ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span className="text-foreground">{findReplaceToast.message}</span>
            </div>
          </div>
        ) : null}

        {exportError ? (
          <div
            className="fixed bottom-4 right-4 z-50 max-w-sm rounded-md border border-destructive/30 bg-background px-4 py-3 text-sm shadow-lg"
            role="alert"
          >
            <div className="flex items-start gap-2 text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">Export failed</p>
                <p className="mt-1 text-foreground">{exportError}</p>
              </div>
            </div>
          </div>
        ) : null}

        <BulkReplaceDialog
          sessionId={params.id}
          mode={bulkMode}
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          patterns={bulkPatterns}
          initialFromPattern={bulkInitialFrom}
          currentStatus={bulkStatus}
          onFinished={handleBulkFinished}
        />

        <ProblemUrlsDialog
          sessionId={params.id}
          open={problemUrlsOpen}
          onOpenChange={setProblemUrlsOpen}
          onFinished={() => void refreshAfterMaintenance()}
        />

        <FixTrailingSlashesDialog
          sessionId={params.id}
          open={trailingSlashOpen}
          onOpenChange={setTrailingSlashOpen}
          onFinished={() => void refreshAfterMaintenance()}
        />

        {/* Trailing-slash re-run confirmation (v1.31 Fix 4). */}
        <Dialog open={slashRerunOpen} onOpenChange={setSlashRerunOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Trailing slashes already applied</DialogTitle>
              <DialogDescription>
                This session already had trailing slashes fixed
                {session?.trailing_slash_fixed_at
                  ? ` on ${formatTimestamp(session.trailing_slash_fixed_at)}`
                  : ""}
                .
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-slate-600">
              Running again will re-scan all files and apply slashes to any URLs
              still missing them (e.g. added after the last fix).
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSlashRerunOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setSlashRerunOpen(false);
                  setTrailingSlashOpen(true);
                }}
              >
                Run again
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* On-demand download progress overlay (v1.31 Fix 2) — non-blocking. */}
        {downloadOverlay ? (
          <div
            className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-slate-200 bg-background p-4 shadow-lg"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <Download className="h-4 w-4 text-indigo-600" aria-hidden="true" />
              {downloadOverlay.percent >= 100
                ? "Starting download…"
                : "Preparing download…"}
            </div>
            <div className="mt-3">
              <Progress value={downloadOverlay.percent} />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
              <span>{Math.round(downloadOverlay.percent)}%</span>
              {downloadOverlay.percent < 100 &&
              downloadOverlay.fileTotal > 0 ? (
                <span>
                  Zipping file{" "}
                  {formatNumber(
                    Math.min(
                      downloadOverlay.fileCurrent,
                      downloadOverlay.fileTotal
                    )
                  )}{" "}
                  of {formatNumber(downloadOverlay.fileTotal)}
                </span>
              ) : null}
            </div>
            {downloadOverlay.percent < 100 &&
            downloadOverlay.etaSeconds != null ? (
              <p className="mt-1 text-xs text-slate-500">
                ~{formatEta(downloadOverlay.etaSeconds)} remaining
              </p>
            ) : null}
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                variant="ghost"
                className="h-8 px-3 text-xs"
                disabled={
                  downloadOverlay.cancelling || downloadOverlay.percent >= 100
                }
                onClick={handleCancelDownload}
              >
                {downloadOverlay.cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
          </div>
        ) : null}

        {deleteUrlTarget ? (
          <DeleteUrlDialog
            sessionId={params.id}
            urlId={deleteUrlTarget.id}
            url={deleteUrlTarget.url}
            open={deleteUrlTarget !== null}
            onOpenChange={(open) => {
              if (!open) {
                setDeleteUrlTarget(null);
              }
            }}
            onDeleted={() => void refreshAfterMaintenance()}
          />
        ) : null}
    </main>
  );
}
