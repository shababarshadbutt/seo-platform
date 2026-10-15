"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderTree,
  Loader2,
  RefreshCcw
} from "lucide-react";

import {
  apiErrorPayload,
  createCategorizerSession,
  downloadCategorizer404s,
  downloadCategorizerZip,
  friendlyApiErrorMessage,
  getCategorizerCategories,
  getCategorizerCategorySample,
  getCategorizerIngestSummary,
  getCategorizerIngestUrls,
  getCategorizerOutputFiles,
  getCategorizerPhaseStatus,
  getCategorizerStatusBreakdown,
  getCategorizerStatusSample,
  getS3Domains,
  getSftpDomains,
  startCategorizerPhase,
  type CategorizerCategorySamplePage,
  type CategorizerCategorySummary,
  type CategorizerIngestSummary,
  type CategorizerJobStatus,
  type CategorizerOutputFile,
  type CategorizerPhase,
  type CategorizerSession,
  type CategorizerSourceKind,
  type CategorizerStatusBreakdown,
  type CategorizerStatusBucket,
  type CategorizerStatusSamplePage,
  type CategorizerUrlPage
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { TimedPhaseChoice } from "@/components/categorizer/TimedPhaseChoice";
import { baseUrlFromSftpDomain } from "@/lib/host";

// Per categorizerMaxUrlsPerFile.ts — kept in sync by hand since this is a
// frontend-only bound check (the backend is authoritative and re-validates).
const MIN_URLS_PER_FILE = 10_000;
const MAX_URLS_PER_FILE = 100_000;
const URLS_PER_FILE_STEP = 5_000;
const DEFAULT_URLS_PER_FILE = 45_000;

const POLL_INTERVAL_MS = 3000;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function isPhaseActive(job: CategorizerJobStatus | null) {
  return job?.status === "PENDING" || job?.status === "RUNNING";
}

// COMPLETE (the phase ran) and SKIPPED (status-check only — the user
// explicitly chose not to run it, see TimedPhaseChoice below) are both
// terminal, non-active states. Treated as one group for gating later phases;
// PhaseCard's own render still tells them apart (a SKIPPED job gets its own
// neutral banner, never the green "Done" one).
function isPhaseDone(job: CategorizerJobStatus | null) {
  return job?.status === "COMPLETE" || job?.status === "SKIPPED";
}

// A durable-job progress card: polls one phase's status row every few seconds
// (not SSE — a status-check run can span hours to days, which is a poor fit
// for a stream the browser tab may not stay open for) and renders a progress
// bar, a start/resume button, or a terminal state.
function PhaseCard({
  step,
  title,
  description,
  sessionId,
  phase,
  renderIdle,
  disabled,
  onComplete,
  renderPreview,
  completedUnitLabel = "URL(s)",
  emptyNoun = "URLs",
  isEmpty,
  renderNote
}: {
  step: number;
  title: string;
  description: string;
  sessionId: string;
  phase: CategorizerPhase;
  // Replaces the default plain "Start" button for the not-yet-started state.
  // Only status-check uses this (TimedPhaseChoice, offering sampled/full/skip
  // instead of a single Start action) — every other phase omits it and gets
  // the default button. Receives THIS card's own start()/loading so the
  // custom UI shares the same polling/loading state as the rest of the card.
  renderIdle?: (
    start: (mode?: "full" | "sampled" | "skip") => void,
    loading: boolean
  ) => React.ReactNode;
  disabled?: boolean;
  onComplete?: () => void;
  // Rendered in BOTH the active and complete states, not just after
  // completion — several previews (categorize's category breakdown,
  // generate's output-file list) update incrementally while the phase is
  // still RUNNING, and gating them on COMPLETE hid that from the user.
  renderPreview?: React.ReactNode;
  // Ingest's job.items_total is a FILE count, not a URL count
  // (categorizerIngestJob.ts), so its card passes "file(s)"/"files" here
  // instead of the default "URL(s)"/"URLs" the other three phases use.
  completedUnitLabel?: string;
  emptyNoun?: string;
  // Overrides the default "items_total === 0" emptiness check. Ingest needs
  // "items_done === 0" instead, since a run where every listed file failed
  // to download (items_total > 0, items_done === 0) is just as empty as one
  // that found zero files.
  isEmpty?: (job: CategorizerJobStatus) => boolean;
  // An optional live status line read off the job row directly (e.g.
  // ingest's checkpoint.files_failed) — rendered whenever a job row exists,
  // regardless of active/complete, so it updates mid-run too.
  renderNote?: (job: CategorizerJobStatus) => React.ReactNode;
}) {
  const [job, setJob] = useState<CategorizerJobStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const notifiedComplete = useRef(false);

  const poll = useCallback(async () => {
    try {
      const status = await getCategorizerPhaseStatus(sessionId, phase);

      setJob(status);

      if (isPhaseDone(status) && !notifiedComplete.current) {
        notifiedComplete.current = true;
        onComplete?.();
      }
    } catch {
      // A poll failure is transient — keep showing the last known state.
    }
  }, [sessionId, phase, onComplete]);

  useEffect(() => {
    void poll();

    const interval = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(interval);
  }, [poll]);

  async function start(mode?: "full" | "sampled" | "skip") {
    setLoading(true);
    setError("");

    try {
      await startCategorizerPhase(sessionId, phase, mode);
      await poll();
    } catch (err) {
      setError(friendlyApiErrorMessage(err, "Unable to start this phase."));
    } finally {
      setLoading(false);
    }
  }

  const total = Number(job?.items_total ?? 0);
  const done = Number(job?.items_done ?? 0);
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  // Categorize alone runs two sub-passes (detect boundaries, then assign
  // categories) over the SAME items_total, so its bar legitimately resets to
  // 0 once mid-run at the detect -> assign handoff — labeling which sub-pass
  // is live keeps that from reading as a fresh hang (categorizerCategorizeJob.ts).
  const categorizePass = phase === "categorize" ? job?.checkpoint?.pass : undefined;
  const categorizeStage =
    typeof categorizePass === "string"
      ? categorizePass === "detect"
        ? "Detecting category structure"
        : "Categorizing"
      : null;
  const active = isPhaseActive(job);
  const complete = isPhaseDone(job);
  const skipped = job?.status === "SKIPPED";
  const failed = job?.status === "FAILED";
  const empty = job ? (isEmpty ?? ((j: CategorizerJobStatus) => Number(j?.items_total ?? 0) === 0))(job) : false;

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">
          {step}. {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {job && renderNote ? renderNote(job) : null}

        {!job || (!active && !complete) ? (
          renderIdle ? (
            renderIdle((mode) => void start(mode), disabled || loading)
          ) : (
            <Button
              type="button"
              disabled={disabled || loading}
              onClick={() => void start()}
              className="gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {failed ? "Retry" : "Start"}
            </Button>
          )
        ) : null}

        {active ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm text-slate-700">
                <Loader2 className="h-4 w-4 animate-spin" />
                {total > 0
                  ? `${categorizeStage ? `${categorizeStage}: ` : ""}${formatNumber(done)} of ${formatNumber(total)}`
                  : "Working…"}
              </p>
              {total > 0 ? <Progress value={percent} /> : null}
            </div>
            {renderPreview}
          </div>
        ) : null}

        {complete ? (
          <div className="space-y-3">
            {skipped ? (
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
                <AlertTriangle className="h-4 w-4" />
                Skipped — status wasn&rsquo;t checked, every categorized URL was
                included as-is.
              </p>
            ) : empty ? (
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700">
                <AlertTriangle className="h-4 w-4" />
                {`Completed — no ${emptyNoun} were found`}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                {total > 0
                  ? `Done — ${formatNumber(total)} ${completedUnitLabel}`
                  : "Done"}
              </p>
            )}
            {renderPreview}
          </div>
        ) : null}

        {failed ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{job?.error ?? "This phase failed."}</span>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CategorySampleRows({
  sessionId,
  category
}: {
  sessionId: string;
  category: string;
}) {
  const [page, setPage] = useState<CategorizerCategorySamplePage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    void getCategorizerCategorySample(sessionId, category)
      .then((result) => {
        if (!cancelled) {
          setPage(result);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, category]);

  if (loading) {
    return <p className="px-3 py-2 text-xs text-slate-500">Loading sample…</p>;
  }

  if (!page || page.urls.length === 0) {
    return <p className="px-3 py-2 text-xs text-slate-500">No sample URLs found.</p>;
  }

  return (
    <ul className="divide-y divide-slate-100 bg-slate-50/60">
      {page.urls.map((row) => (
        <li key={row.id} className="truncate px-3 py-1.5 font-mono text-xs text-slate-600">
          {row.url}
        </li>
      ))}
    </ul>
  );
}

// Polls (not a one-shot fetch) because category counts change continuously
// while the categorize phase is still RUNNING — PhaseCard now renders this
// during both the active and complete states (renderPreview), so it needs to
// keep refreshing itself rather than freezing at whatever it saw on mount.
function CategoriesPreview({ sessionId }: { sessionId: string }) {
  const [categories, setCategories] = useState<CategorizerCategorySummary[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      void getCategorizerCategories(sessionId).then((result) => {
        if (!cancelled) {
          setCategories(result);
        }
      });
    };

    poll();

    const interval = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  if (!categories || categories.length === 0) {
    return null;
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">URLs</th>
            <th className="px-3 py-2 text-right">Sample</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {categories.map((category) => (
            <Fragment key={category.category}>
              <tr>
                <td className="px-3 py-2 font-mono text-xs text-slate-700">
                  {category.category}.xml
                </td>
                <td className="px-3 py-2">
                  <CategoryStatusBadge
                    status={category.status}
                    confidencePct={category.confidencePct}
                  />
                </td>
                <td className="px-3 py-2 text-right text-slate-700">
                  {formatNumber(category.urlCount)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className="text-xs font-medium text-indigo-600 hover:underline"
                    onClick={() =>
                      setExpanded((current) =>
                        current === category.category ? null : category.category
                      )
                    }
                  >
                    {expanded === category.category ? "Hide" : "View"}
                  </button>
                </td>
              </tr>
              {expanded === category.category ? (
                <tr>
                  <td colSpan={4} className="p-0">
                    <CategorySampleRows sessionId={sessionId} category={category.category} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// PENDING means "not sampled yet" (see migration 065's categorizer_categories
// — the same PENDING-is-not-BAD distinction patternScore.ts documents for
// patterns.status), rendered as neutral, not a verdict.
function CategoryStatusBadge({
  status,
  confidencePct
}: {
  status: CategorizerCategorySummary["status"];
  confidencePct: number | null;
}) {
  const styles: Record<CategorizerCategorySummary["status"], string> = {
    PENDING: "bg-slate-100 text-slate-600",
    GOOD: "bg-emerald-100 text-emerald-700",
    WARNING: "bg-amber-100 text-amber-700",
    BAD: "bg-red-100 text-red-700"
  };
  const labels: Record<CategorizerCategorySummary["status"], string> = {
    PENDING: "Not sampled",
    GOOD: "Good",
    WARNING: "Warning",
    BAD: "Excluded (bad)"
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
      {confidencePct !== null ? ` — ${confidencePct}%` : ""}
    </span>
  );
}

// Ingest's own preview: a per-file breakdown plus a first page of the actual
// ingested URLs. Exists so "1,871" on the card means something concrete
// instead of being whatever job.items_total happens to hold (a FILE count,
// not a URL count — see PhaseCard's completedUnitLabel note on the ingest
// card below).
function IngestPreview({ sessionId }: { sessionId: string }) {
  const [summary, setSummary] = useState<CategorizerIngestSummary | null>(null);
  const [urlPage, setUrlPage] = useState<CategorizerUrlPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      void getCategorizerIngestSummary(sessionId).then((result) => {
        if (!cancelled) {
          setSummary(result);
        }
      });
    };

    poll();

    const interval = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;

    void getCategorizerIngestUrls(sessionId).then((result) => {
      if (!cancelled) {
        setUrlPage(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function loadMore() {
    if (!urlPage?.next_cursor) {
      return;
    }

    setLoadingMore(true);

    try {
      const next = await getCategorizerIngestUrls(sessionId, urlPage.next_cursor);

      setUrlPage((current) => ({
        urls: [...(current?.urls ?? []), ...next.urls],
        next_cursor: next.next_cursor
      }));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!summary || summary.total_urls === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        {formatNumber(summary.total_urls)} URL(s) ingested across{" "}
        {formatNumber(summary.files.length)} file(s).
      </p>

      <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
        <ul className="divide-y divide-slate-100">
          {(urlPage?.urls ?? []).map((row) => (
            <li key={row.id} className="truncate px-3 py-1.5 font-mono text-xs text-slate-600">
              {row.url}
            </li>
          ))}
        </ul>
      </div>

      {urlPage?.next_cursor ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loadingMore}
          onClick={() => void loadMore()}
          className="gap-2"
        >
          {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}

function ingestNoteFromJob(job: CategorizerJobStatus) {
  const failed = (job.checkpoint as { files_failed?: unknown })?.files_failed;
  const failedCount = Array.isArray(failed) ? failed.length : 0;

  if (failedCount === 0) {
    return null;
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {formatNumber(failedCount)} file(s) failed to download and will be retried on the next
        run of this phase.
      </span>
    </div>
  );
}

const STATUS_BUCKET_LABELS: Record<CategorizerStatusBucket, string> = {
  "2xx": "2xx (OK)",
  "3xx": "3xx (Redirect)",
  "404": "404 (Not found)",
  "4xx": "4xx (Other client error)",
  "5xx": "5xx (Server error)",
  probe_failed: "Probe failed (no response)"
};

function StatusSampleRows({
  sessionId,
  bucket
}: {
  sessionId: string;
  bucket: CategorizerStatusBucket;
}) {
  const [page, setPage] = useState<CategorizerStatusSamplePage | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    void getCategorizerStatusSample(sessionId, bucket)
      .then((result) => {
        if (!cancelled) {
          setPage(result);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, bucket]);

  if (loading) {
    return <p className="px-3 py-2 text-xs text-slate-500">Loading sample…</p>;
  }

  if (!page || page.urls.length === 0) {
    return <p className="px-3 py-2 text-xs text-slate-500">No sample URLs found.</p>;
  }

  return (
    <ul className="divide-y divide-slate-100 bg-slate-50/60">
      {page.urls.map((row) => (
        <li key={row.id} className="truncate px-3 py-1.5 font-mono text-xs text-slate-600">
          {row.url}
        </li>
      ))}
    </ul>
  );
}

// Live HTTP status-code breakdown. Polls while the phase is still RUNNING
// (same pattern as CategoriesPreview) since results accumulate continuously
// during a status-check run that can span hours to days.
function StatusCheckBreakdown({ sessionId }: { sessionId: string }) {
  const [breakdown, setBreakdown] = useState<CategorizerStatusBreakdown | null>(null);
  const [expanded, setExpanded] = useState<CategorizerStatusBucket | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      void getCategorizerStatusBreakdown(sessionId).then((result) => {
        if (!cancelled) {
          setBreakdown(result);
        }
      });
    };

    poll();

    const interval = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  if (!breakdown || breakdown.checked_count === 0) {
    return null;
  }

  const buckets = Object.entries(breakdown.buckets) as [CategorizerStatusBucket, number][];

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">URLs</th>
            <th className="px-3 py-2 text-right">Sample</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {buckets
            .filter(([, count]) => count > 0)
            .map(([bucket, count]) => (
              <Fragment key={bucket}>
                <tr>
                  <td className="px-3 py-2 text-xs text-slate-700">
                    {STATUS_BUCKET_LABELS[bucket]}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">{formatNumber(count)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      className="text-xs font-medium text-indigo-600 hover:underline"
                      onClick={() =>
                        setExpanded((current) => (current === bucket ? null : bucket))
                      }
                    >
                      {expanded === bucket ? "Hide" : "View"}
                    </button>
                  </td>
                </tr>
                {expanded === bucket ? (
                  <tr>
                    <td colSpan={3} className="p-0">
                      <StatusSampleRows sessionId={sessionId} bucket={bucket} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
        </tbody>
      </table>
    </div>
  );
}

// A download-button failure carries the backend's structured { reason,
// severity } payload (sitemapCategorizer.ts's emptyResult) when available —
// "info" means the empty result is actually good news (e.g. zero real 404s),
// so it renders as a neutral note rather than the red alert a genuine
// problem gets.
function DownloadOutcome({
  message,
  severity
}: {
  message: string;
  severity: "info" | "warning";
}) {
  if (severity === "info") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        <span>{message}</span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function OutputFilesAndDownload({
  sessionId,
  domain
}: {
  sessionId: string;
  domain: string;
}) {
  const [files, setFiles] = useState<CategorizerOutputFile[] | null>(null);
  const [breakdown, setBreakdown] = useState<CategorizerStatusBreakdown | null>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [downloading404s, setDownloading404s] = useState(false);
  const [zipOutcome, setZipOutcome] = useState<{
    message: string;
    severity: "info" | "warning";
  } | null>(null);
  const [outcome404s, setOutcome404s] = useState<{
    message: string;
    severity: "info" | "warning";
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      void getCategorizerOutputFiles(sessionId).then((result) => {
        if (!cancelled) {
          setFiles(result);
        }
      });
      void getCategorizerStatusBreakdown(sessionId).then((result) => {
        if (!cancelled) {
          setBreakdown(result);
        }
      });
    };

    poll();

    const interval = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  async function handleDownloadZip() {
    setDownloadingZip(true);
    setZipOutcome(null);

    try {
      await downloadCategorizerZip(sessionId, domain);
    } catch (err) {
      const payload = apiErrorPayload(err) as { message?: string; severity?: string } | null;

      setZipOutcome({
        message: friendlyApiErrorMessage(err, "Unable to download the sitemap files."),
        severity: payload?.severity === "info" ? "info" : "warning"
      });
    } finally {
      setDownloadingZip(false);
    }
  }

  async function handleDownload404s() {
    setDownloading404s(true);
    setOutcome404s(null);

    try {
      await downloadCategorizer404s(sessionId, domain);
    } catch (err) {
      const payload = apiErrorPayload(err) as { message?: string; severity?: string } | null;

      setOutcome404s({
        message: friendlyApiErrorMessage(err, "Unable to download the 404 list."),
        severity: payload?.severity === "info" ? "info" : "warning"
      });
    } finally {
      setDownloading404s(false);
    }
  }

  // Proactive, not reactive: once the real counts are in, a genuinely empty
  // 404 list is known BEFORE the user can click the button — so it's
  // disabled with a neutral note instead of letting the click round-trip to
  // a 404 response just to find out.
  const no404sFound =
    breakdown !== null && breakdown.checked_count > 0 && breakdown.buckets["404"] === 0;
  const totalUrlCount = files?.reduce((sum, file) => sum + file.url_count, 0) ?? 0;

  return (
    <div className="space-y-3">
      {files && files.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2 text-right">URLs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {files.map((file) => (
                <tr key={file.filename}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{file.filename}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{file.category}</td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {formatNumber(file.url_count)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {formatNumber(files.length)} file(s), {formatNumber(totalUrlCount)} URL(s) total,
            plus sitemap-index.xml.
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          No output files were generated yet.
        </p>
      )}

      {no404sFound ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          No 404s were found — every checked URL responded, so there&rsquo;s nothing to exclude.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          onClick={() => void handleDownloadZip()}
          disabled={downloadingZip}
          className="gap-2"
        >
          <Download className="h-4 w-4" />
          Download sitemap ZIP
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleDownload404s()}
          disabled={downloading404s || no404sFound}
          className="gap-2"
        >
          <Download className="h-4 w-4" />
          Download 404 URLs
        </Button>
      </div>

      {zipOutcome ? (
        <DownloadOutcome message={zipOutcome.message} severity={zipOutcome.severity} />
      ) : null}
      {outcome404s ? (
        <DownloadOutcome message={outcome404s.message} severity={outcome404s.severity} />
      ) : null}
    </div>
  );
}

export default function SitemapCategorizerPage() {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [sourceKind, setSourceKind] = useState<CategorizerSourceKind>("s3");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainsError, setDomainsError] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");
  const [maxUrlsPerFile, setMaxUrlsPerFile] = useState(DEFAULT_URLS_PER_FILE);

  const [session, setSession] = useState<CategorizerSession | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  useEffect(() => {
    let cancelled = false;

    setDomainsLoading(true);
    setDomainsError("");
    setSelectedDomain("");

    const list = sourceKind === "s3" ? getS3Domains() : getSftpDomains();

    void list
      .then((result) => {
        if (!cancelled) {
          setDomains(result.domains ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDomainsError(
            friendlyApiErrorMessage(err, "Unable to list available domains.")
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDomainsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sourceKind]);

  async function handleCreateAndStart() {
    if (!name.trim() || !baseUrl.trim() || !selectedDomain) {
      return;
    }

    setCreating(true);
    setCreateError("");

    try {
      const created = await createCategorizerSession({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        sourceKind,
        sourceDomain: selectedDomain,
        maxUrlsPerFile
      });

      setSession(created);
      await startCategorizerPhase(created.id, "ingest");
    } catch (err) {
      setCreateError(friendlyApiErrorMessage(err, "Unable to create this session."));
    } finally {
      setCreating(false);
    }
  }

  const [ingestDone, setIngestDone] = useState(false);
  const [statusCheckDone, setStatusCheckDone] = useState(false);
  const [categorizeDone, setCategorizeDone] = useState(false);

  return (
    <main className="min-h-[calc(100vh-56px)] bg-[#F8FAFC]">
      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            <FolderTree className="h-6 w-6 text-indigo-500" aria-hidden="true" />
            Sitemap Categorizer
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Pull every URL from a site&rsquo;s existing sitemaps, automatically
            categorize them by path structure, sample-check each
            category&rsquo;s status, and generate a clean, capped-size sitemap
            set with an index — ready for Google Search Console.
          </p>
        </div>

        {!session ? (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-base">1. Site</CardTitle>
              <CardDescription>
                Choose the site whose sitemaps this will read and categorize.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">Session name</label>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Aero World Fulfillment — full categorization"
                  className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">Site base URL</label>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://www.example.com"
                  className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">Source</label>
                <div className="flex gap-2">
                  {(["s3", "sftp"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setSourceKind(kind)}
                      className={`h-9 rounded-md px-3.5 text-sm font-medium transition-colors ${
                        sourceKind === kind
                          ? "bg-indigo-500 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      {kind === "s3" ? "S3" : "SFTP"}
                    </button>
                  ))}
                </div>
              </div>

              {domainsLoading ? (
                <p className="text-sm text-slate-500">Listing domains…</p>
              ) : domainsError ? (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {domainsError}
                </p>
              ) : (
                <select
                  value={selectedDomain}
                  onChange={(event) => {
                    const nextDomain = event.target.value;

                    setSelectedDomain(nextDomain);
                    // Filled from the selection, same convention as the
                    // Migration tool's SFTP domain picker (lib/host.ts) — a
                    // hand-typed base URL that drifts from the domain actually
                    // being crawled is how a session ends up ingesting one
                    // site's sitemaps under another's base URL.
                    setBaseUrl(baseUrlFromSftpDomain(nextDomain));
                  }}
                  className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
                >
                  <option value="">Select a domain…</option>
                  {domains.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              )}

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-slate-700">
                  Max URLs per output file
                </label>
                <input
                  type="range"
                  min={MIN_URLS_PER_FILE}
                  max={MAX_URLS_PER_FILE}
                  step={URLS_PER_FILE_STEP}
                  value={maxUrlsPerFile}
                  onChange={(event) => setMaxUrlsPerFile(Number(event.target.value))}
                  className="w-full"
                />
                <p className="text-sm text-slate-500">
                  {formatNumber(maxUrlsPerFile)} URLs per file
                </p>
              </div>

              <Button
                type="button"
                onClick={() => void handleCreateAndStart()}
                disabled={!name.trim() || !baseUrl.trim() || !selectedDomain || creating}
                className="gap-2"
              >
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Create session &amp; start ingest
              </Button>

              {createError ? (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{createError}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <>
            <Card className="mb-4 bg-slate-50">
              <CardContent className="flex items-center justify-between py-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{session.name}</p>
                  <p className="text-xs text-slate-500">
                    {session.source_domain} ({session.source_kind.toUpperCase()})
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.reload()}
                  className="gap-2"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  New session
                </Button>
              </CardContent>
            </Card>

            {/* The automatic "start ingest" call from handleCreateAndStart
                fires right after the session is created, before this branch
                even renders — a failure there (e.g. the categorizer worker
                queue rejecting the request) used to be swallowed: createError
                was only ever displayed in the !session branch above, which
                this component had already left by the time the error landed.
                That silent failure looked identical to a healthy idle "Start"
                button, which is exactly what made the real bug (worker
                starvation, fixed in categorizerQueue.ts) so hard to tell
                apart from a frontend problem. Shown here too so a failed
                auto-start is never invisible. */}
            {createError ? (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{createError}</span>
              </div>
            ) : null}

            <PhaseCard
              step={2}
              title="Ingest"
              description="Pull every sitemap file for this domain and extract its URLs."
              sessionId={session.id}
              phase="ingest"
              onComplete={() => setIngestDone(true)}
              completedUnitLabel="file(s)"
              emptyNoun="files"
              isEmpty={(job) => Number(job?.items_done ?? 0) === 0}
              renderNote={ingestNoteFromJob}
              renderPreview={<IngestPreview sessionId={session.id} />}
            />

            <PhaseCard
              step={3}
              title="Categorize"
              description="Classify every ingested URL by path structure (regular pages, static listings, and RFQ shapes)."
              sessionId={session.id}
              phase="categorize"
              disabled={!ingestDone}
              onComplete={() => setCategorizeDone(true)}
              renderPreview={<CategoriesPreview sessionId={session.id} />}
            />

            <PhaseCard
              step={4}
              title="Check status"
              description="Sample-check each category's URLs and score its confidence. 404s found in a sample (and any category that scores too low) are excluded from the output."
              sessionId={session.id}
              phase="status-check"
              disabled={!categorizeDone}
              onComplete={() => setStatusCheckDone(true)}
              renderIdle={(start, loading) => (
                <TimedPhaseChoice
                  seconds={5}
                  disabled={loading}
                  title="Check status before generating?"
                  description="By default this checks a sample of URLs per category and scores each category's confidence — fast, even on huge sites. You can skip status checking entirely, or opt into the slower full per-URL check instead."
                  onTimeout={() => start("sampled")}
                  actions={[
                    {
                      label: "Skip to Generate & Download",
                      onClick: () => start("skip")
                    },
                    {
                      label: "Check every URL instead",
                      onClick: () => start("full")
                    }
                  ]}
                />
              )}
              renderPreview={<StatusCheckBreakdown sessionId={session.id} />}
            />

            <PhaseCard
              step={5}
              title="Generate &amp; download"
              description="Write the final capped-size sitemap files and a sitemap-index.xml."
              sessionId={session.id}
              phase="generate"
              disabled={!statusCheckDone}
              renderPreview={
                <OutputFilesAndDownload
                  sessionId={session.id}
                  domain={session.source_domain}
                />
              }
            />
          </>
        )}
      </section>
    </main>
  );
}
