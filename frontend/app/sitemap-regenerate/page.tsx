"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCcw,
  Repeat,
  Send,
  Upload
} from "lucide-react";

import {
  createSession,
  enqueueSitemapRegenerate,
  friendlyApiErrorMessage,
  getCsvUploadStatus,
  getPatternSamples,
  getPatterns,
  getS3Domains,
  getSession,
  getSitemapRegenerateJob,
  startS3Pull,
  followS3PullProgress,
  uploadCsvUrlList,
  type CsvUploadResult,
  type Pattern,
  type RemotePullProgressEvent,
  type SampledUrl,
  type SitemapRegeneratePatternDecision,
  type SitemapRegenerateJobStatus,
  type SitemapRegenerateLastmodPolicy
} from "@/lib/api";
import {
  convertParamToABC,
  diagnoseUnresolvedSegments,
  inferNewStructure,
  parseStructure
} from "@/lib/transform-structure";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type FetchPhase = "idle" | "pulling" | "parsing" | "ready" | "stalled" | "error";
type CsvPhase =
  | "idle"
  | "uploading"
  | "extracting"
  | "sampling"
  | "ready"
  | "stalled"
  | "error";
type PushPhase = "idle" | "running" | "done" | "error";

const CHUNK_SIZE = 50_000;
const DEFAULT_FILENAME_TEMPLATE = "sitemap-{n}.xml";
const PROBLEM_STATUSES = new Set([301, 302, 307, 308, 404]);
const PUSH_TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED"]);

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

// A large domain can legitimately take minutes to finish parsing, so this
// can't be a flat wall-clock cap — see the identical constant and reasoning
// in lastmod-updater/page.tsx.
const PARSE_STALL_THRESHOLD_MS = 150_000;

class ParsingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParsingTimeoutError";
  }
}

type PatternDecisionState =
  | { mode: "as_is" }
  | {
      mode: "rewrite";
      newUrl: string;
      pinnedOverrides: Map<string, string>;
    };

function statusChipClass(sample: SampledUrl) {
  const status = Number(sample.http_status) || 0;

  if (sample.http_status_category === "success") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200";
  }

  if (PROBLEM_STATUSES.has(status)) {
    return "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200";
  }

  if (sample.http_status_category === "blocked") {
    return "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200";
  }

  return "bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200";
}

function PatternReviewCard({
  pattern,
  decision,
  onChange,
  onRegisterResolver
}: {
  pattern: Pattern;
  decision: PatternDecisionState;
  onChange: (next: PatternDecisionState) => void;
  onRegisterResolver: (resolve: () => SitemapRegeneratePatternDecision | null) => void;
}) {
  const [samples, setSamples] = useState<SampledUrl[] | null>(null);
  const [samplesError, setSamplesError] = useState("");

  useEffect(() => {
    let cancelled = false;

    void getPatternSamples(pattern.session_id, pattern.id)
      .then((loaded) => {
        if (!cancelled) {
          setSamples(loaded);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSamplesError(
            friendlyApiErrorMessage(error, "Could not load sample URLs.")
          );
          setSamples([]);
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern.id]);

  // Exposes a pull-based "what would this pattern submit right now" resolver
  // to the parent, rather than lifting newUrl/pinnedOverrides/samples state
  // up — the parent only needs the resolved answer once, at submit time.
  useEffect(() => {
    onRegisterResolver(() => {
      if (decision.mode === "as_is") {
        return { pattern_id: pattern.id, mode: "as_is" };
      }

      const oldUrlExample = samples?.[0]?.url ?? "";

      if (!oldUrlExample || !decision.newUrl.trim()) {
        return null;
      }

      const currentStructure = convertParamToABC(pattern.template);
      const inference = inferNewStructure(
        oldUrlExample,
        decision.newUrl.trim(),
        parseStructure(currentStructure),
        decision.pinnedOverrides
      );

      if (!inference.ok) {
        return null;
      }

      return {
        pattern_id: pattern.id,
        mode: "rewrite",
        current_structure: currentStructure,
        new_structure: inference.structure
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern.id, pattern.template, decision, samples]);

  const currentStructure = convertParamToABC(pattern.template);
  const oldUrlExample = samples?.[0]?.url ?? "";
  const newUrl = decision.mode === "rewrite" ? decision.newUrl : "";
  const pinnedOverrides =
    decision.mode === "rewrite" ? decision.pinnedOverrides : new Map<string, string>();

  const inference =
    decision.mode === "rewrite" && oldUrlExample && newUrl.trim()
      ? inferNewStructure(
          oldUrlExample,
          newUrl.trim(),
          parseStructure(currentStructure),
          pinnedOverrides
        )
      : null;

  const unresolved =
    inference && !inference.ok && oldUrlExample && newUrl.trim()
      ? diagnoseUnresolvedSegments(
          oldUrlExample,
          newUrl.trim(),
          parseStructure(currentStructure),
          pinnedOverrides
        )
      : null;

  function setNewUrl(value: string) {
    onChange({
      mode: "rewrite",
      newUrl: value,
      pinnedOverrides: decision.mode === "rewrite" ? decision.pinnedOverrides : new Map()
    });
  }

  function confirmSegment(name: string, from: string) {
    const nextPinned = new Map(pinnedOverrides);

    nextPinned.set(name, from);
    onChange({ mode: "rewrite", newUrl, pinnedOverrides: nextPinned });
  }

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="text-sm font-medium text-slate-800">{pattern.template}</code>
        <span className="text-xs text-slate-500">
          {formatNumber(Number(pattern.total_urls) || 0)} URLs
        </span>
      </div>

      {samplesError ? (
        <p className="mt-1.5 text-xs text-amber-700">{samplesError}</p>
      ) : samples === null ? (
        <p className="mt-1.5 text-xs text-slate-500">Checking sample URLs…</p>
      ) : samples.length === 0 ? (
        <p className="mt-1.5 text-xs text-slate-500">Not scored yet.</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {samples.slice(0, 6).map((sample) => (
            <span
              key={sample.id}
              title={sample.url}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                statusChipClass(sample)
              )}
            >
              {sample.http_status ? Number(sample.http_status) : "—"}
            </span>
          ))}
        </div>
      )}

      <div
        className="mt-3 grid grid-cols-2 gap-1 rounded-full border border-indigo-100 bg-indigo-50 p-1 text-xs"
        role="tablist"
      >
        <button
          type="button"
          role="tab"
          aria-selected={decision.mode === "as_is"}
          onClick={() => onChange({ mode: "as_is" })}
          className={cn(
            "flex h-8 items-center justify-center rounded-full font-semibold transition-colors",
            decision.mode === "as_is"
              ? "bg-indigo-500 text-white shadow-sm"
              : "text-slate-500 hover:text-indigo-600"
          )}
        >
          Keep as-is
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={decision.mode === "rewrite"}
          onClick={() =>
            onChange(
              decision.mode === "rewrite"
                ? decision
                : { mode: "rewrite", newUrl: "", pinnedOverrides: new Map() }
            )
          }
          className={cn(
            "flex h-8 items-center justify-center rounded-full font-semibold transition-colors",
            decision.mode === "rewrite"
              ? "bg-indigo-500 text-white shadow-sm"
              : "text-slate-500 hover:text-indigo-600"
          )}
        >
          Rewrite by example
        </button>
      </div>

      {decision.mode === "rewrite" ? (
        <div className="mt-3 space-y-2">
          <div className="space-y-1">
            <span className="text-xs font-medium text-slate-600">
              A URL in this pattern now
            </span>
            <p className="truncate rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-600">
              {oldUrlExample || "Waiting for a sample URL…"}
            </p>
          </div>

          <div className="space-y-1">
            <label
              htmlFor={`new-url-${pattern.id}`}
              className="text-xs font-medium text-slate-600"
            >
              What it should be
            </label>
            <input
              id={`new-url-${pattern.id}`}
              type="text"
              value={newUrl}
              disabled={!oldUrlExample}
              onChange={(event) => setNewUrl(event.target.value)}
              placeholder={oldUrlExample}
              className="h-9 w-full rounded-md border border-slate-200 px-2.5 font-mono text-xs text-slate-700 focus:border-indigo-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          {inference?.ok ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-900">
              Rule worked out: <code>{currentStructure}</code> →{" "}
              <code>{inference.structure}</code>
            </div>
          ) : null}

          {inference && !inference.ok && unresolved && unresolved.length > 0 ? (
            <div className="space-y-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
              <p>Needs your confirmation:</p>
              {unresolved.map((segment) => (
                <div key={segment.name} className="flex items-center justify-between gap-2">
                  <span>
                    Segment {"{" + segment.name + "}"} (&ldquo;{segment.from}&rdquo;) has
                    nothing in common with &ldquo;{segment.to}&rdquo;.
                  </span>
                  <button
                    type="button"
                    className="shrink-0 font-semibold text-amber-900 underline hover:text-amber-950"
                    onClick={() => confirmSegment(segment.name, segment.from)}
                  >
                    Confirm
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {inference && !inference.ok && !unresolved ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">
              {inference.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function SitemapRegeneratePage() {
  const router = useRouter();

  // ---- Step 1: source + domain (S3 only) -----------------------------------
  const [domains, setDomains] = useState<string[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainsError, setDomainsError] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");

  useEffect(() => {
    setDomainsLoading(true);
    void getS3Domains()
      .then((result) => setDomains(result.domains))
      .catch((error) =>
        setDomainsError(friendlyApiErrorMessage(error, "Could not list S3 domains."))
      )
      .finally(() => setDomainsLoading(false));
  }, []);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fetchPhase, setFetchPhase] = useState<FetchPhase>("idle");
  const [fetchMessage, setFetchMessage] = useState("");
  const [fetchProgress, setFetchProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [fetchError, setFetchError] = useState("");
  const pullSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      pullSourceRef.current?.close();
    };
  }, []);

  useEffect(() => {
    const existingSessionId = new URLSearchParams(window.location.search).get(
      "session"
    );

    if (!existingSessionId) {
      return;
    }

    setSessionId(existingSessionId);
    void resumeParsing(existingSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function waitForParsing(id: string) {
    setFetchPhase("parsing");
    let lastParsedCount = -1;
    let lastProgressAt = Date.now();

    for (;;) {
      const { session, sitemap_files: sitemapFiles } = await getSession(id);

      if (session.status === "FAILED" || session.status === "CANCELLED") {
        throw new Error(
          "Fetching this domain's files failed — check the source and try again."
        );
      }

      const total = sitemapFiles.length;
      const parsedCount = sitemapFiles.filter((file) => file.parsed_at !== null).length;

      if (total > 0 && parsedCount === total) {
        return;
      }

      if (parsedCount !== lastParsedCount) {
        lastParsedCount = parsedCount;
        lastProgressAt = Date.now();
      }

      setFetchMessage(
        total > 0
          ? `Parsing files… ${parsedCount} of ${total} done`
          : "Waiting for files to finish parsing…"
      );

      if (Date.now() - lastProgressAt > PARSE_STALL_THRESHOLD_MS) {
        throw new ParsingTimeoutError(
          "Parsing hasn't made progress in a couple of minutes. It may still finish on its own."
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  function handleParsingOutcomeError(error: unknown) {
    if (error instanceof ParsingTimeoutError) {
      setFetchMessage(error.message);
      setFetchPhase("stalled");
      return;
    }

    setFetchError(friendlyApiErrorMessage(error, "Could not fetch this domain's files."));
    setFetchPhase("error");
  }

  async function resumeParsing(id: string) {
    setFetchError("");

    try {
      await waitForParsing(id);
      setFetchPhase("ready");
      setFetchMessage("");
    } catch (error) {
      handleParsingOutcomeError(error);
    }
  }

  async function handleFetchFiles() {
    if (!selectedDomain) {
      return;
    }

    setFetchError("");
    setFetchProgress(null);
    setFetchPhase("pulling");
    setFetchMessage("Starting…");

    try {
      const created = await createSession({
        name: `Sitemap Regenerate — ${selectedDomain} — ${new Date().toISOString()}`,
        baseUrl: `https://${selectedDomain}`,
        sampleSize: 5,
        concurrency: 1
      });
      const newSessionId = created.session_id;

      setSessionId(newSessionId);
      router.replace(`/sitemap-regenerate?session=${newSessionId}`, { scroll: false });

      await startS3Pull(newSessionId, selectedDomain);

      await new Promise<void>((resolve, reject) => {
        const source = followS3PullProgress(newSessionId, (event: RemotePullProgressEvent) => {
          if (event.type === "progress") {
            setFetchMessage(event.message ?? "Pulling files…");
            setFetchProgress(
              typeof event.current === "number" && typeof event.total === "number"
                ? { current: event.current, total: event.total }
                : null
            );
          } else if (event.type === "done") {
            source.close();
            resolve();
          } else if (event.type === "error") {
            source.close();
            reject(new Error(event.message ?? "The remote pull failed."));
          }
        });

        pullSourceRef.current = source;
      });

      await waitForParsing(newSessionId);

      setFetchPhase("ready");
      setFetchMessage("");
    } catch (error) {
      handleParsingOutcomeError(error);
    }
  }

  // ---- Step 2: CSV upload ---------------------------------------------------
  const [csvPhase, setCsvPhase] = useState<CsvPhase>("idle");
  const [csvError, setCsvError] = useState("");
  const [csvUploadResult, setCsvUploadResult] = useState<CsvUploadResult | null>(null);
  const [csvTotalUrls, setCsvTotalUrls] = useState(0);
  const [csvPatternCount, setCsvPatternCount] = useState(0);
  const [csvSampledCount, setCsvSampledCount] = useState(0);

  // Polls pattern-detection/sampling progress for the CSV-derived file. Shared
  // by the initial upload and the "Check again" retry after a stall, so both
  // paths report the same "N of M patterns checked" progress instead of a
  // bare spinner. Mirrors waitForParsing's stall detection above.
  async function waitForCsvProcessing(id: string, fallbackUrlCount: number) {
    let lastProgressKey = "";
    let lastProgressAt = Date.now();

    for (;;) {
      const status = await getCsvUploadStatus(id);

      if (status.phase === "FAILED") {
        throw new Error("The uploaded CSV could not be parsed as sitemap URLs.");
      }

      setCsvPatternCount(status.pattern_count ?? 0);
      setCsvSampledCount(status.sampled_count ?? 0);

      if (status.phase === "READY") {
        setCsvTotalUrls(status.total_urls ?? fallbackUrlCount);
        setCsvPhase("ready");
        return;
      }

      setCsvPhase(status.phase === "SAMPLING" ? "sampling" : "extracting");

      const progressKey = `${status.phase}:${status.pattern_count ?? 0}:${status.sampled_count ?? 0}`;

      if (progressKey !== lastProgressKey) {
        lastProgressKey = progressKey;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > PARSE_STALL_THRESHOLD_MS) {
        throw new ParsingTimeoutError(
          "This hasn't made progress in a couple of minutes. It may still finish on its own."
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  async function handleCsvSelected(file: File) {
    if (!sessionId) {
      return;
    }

    setCsvError("");
    setCsvPhase("uploading");
    setCsvPatternCount(0);
    setCsvSampledCount(0);

    try {
      const uploaded = await uploadCsvUrlList(sessionId, file);

      setCsvUploadResult(uploaded);
      setCsvPhase("extracting");
      await waitForCsvProcessing(sessionId, uploaded.url_count);
    } catch (error) {
      if (error instanceof ParsingTimeoutError) {
        setCsvError(error.message);
        setCsvPhase("stalled");
        return;
      }

      setCsvError(friendlyApiErrorMessage(error, "Could not process the CSV."));
      setCsvPhase("error");
    }
  }

  async function retryCsvProcessing() {
    if (!sessionId || !csvUploadResult) {
      return;
    }

    setCsvError("");
    setCsvPhase("extracting");

    try {
      await waitForCsvProcessing(sessionId, csvUploadResult.url_count);
    } catch (error) {
      if (error instanceof ParsingTimeoutError) {
        setCsvError(error.message);
        setCsvPhase("stalled");
        return;
      }

      setCsvError(friendlyApiErrorMessage(error, "Could not process the CSV."));
      setCsvPhase("error");
    }
  }

  // ---- Step 3: per-pattern decisions ----------------------------------------
  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [decisions, setDecisions] = useState<Map<string, PatternDecisionState>>(new Map());

  useEffect(() => {
    if (csvPhase !== "ready" || !sessionId) {
      return;
    }

    setPatternsLoading(true);
    void getPatterns(sessionId)
      .then((loaded) => {
        const legacy = loaded.filter((pattern) => pattern.source_role === "legacy");

        setPatterns(legacy);
        setDecisions((current) => {
          const next = new Map(current);

          for (const pattern of legacy) {
            if (!next.has(pattern.id)) {
              next.set(pattern.id, { mode: "as_is" });
            }
          }

          return next;
        });
      })
      .finally(() => setPatternsLoading(false));
  }, [csvPhase, sessionId]);

  function setDecision(patternId: string, next: PatternDecisionState) {
    setDecisions((current) => {
      const updated = new Map(current);

      updated.set(patternId, next);

      return updated;
    });
  }

  // ---- Step 4: file count + filename template -------------------------------
  const [filenameTemplate, setFilenameTemplate] = useState(DEFAULT_FILENAME_TEMPLATE);

  const decidedUrlTotal = patterns.reduce(
    (sum, pattern) => sum + (Number(pattern.total_urls) || 0),
    0
  );
  const estimatedFilesTotal =
    decidedUrlTotal > 0 ? Math.ceil(decidedUrlTotal / CHUNK_SIZE) : 0;

  // ---- Step 5: lastmod policy ------------------------------------------------
  const [lastmodPolicy, setLastmodPolicy] =
    useState<SitemapRegenerateLastmodPolicy>("all");

  // ---- Step 6: publish --------------------------------------------------------
  const [pushPhase, setPushPhase] = useState<PushPhase>("idle");
  const [pushJob, setPushJob] = useState<SitemapRegenerateJobStatus | null>(null);
  const [pushError, setPushError] = useState("");

  const rewriteCardRefs = useRef<Map<string, () => SitemapRegeneratePatternDecision | null>>(
    new Map()
  );

  function registerResolver(
    patternId: string,
    resolve: () => SitemapRegeneratePatternDecision | null
  ) {
    rewriteCardRefs.current.set(patternId, resolve);
  }

  async function handlePush() {
    if (!sessionId) {
      return;
    }

    const finalDecisions: SitemapRegeneratePatternDecision[] = [];
    let hasUnresolved = false;

    for (const pattern of patterns) {
      const resolver = rewriteCardRefs.current.get(pattern.id);
      const resolved = resolver ? resolver() : { pattern_id: pattern.id, mode: "as_is" as const };

      if (!resolved) {
        hasUnresolved = true;
        break;
      }

      finalDecisions.push(resolved);
    }

    if (hasUnresolved) {
      setPushError(
        "One or more patterns set to \"Rewrite by example\" don't have a resolved rule yet — finish or revert them first."
      );
      setPushPhase("error");
      return;
    }

    setPushError("");
    setPushPhase("running");
    setPushJob(null);

    try {
      const started = await enqueueSitemapRegenerate(sessionId, {
        patternDecisions: finalDecisions,
        filenameTemplate,
        lastmodPolicy
      });

      setPushJob(started);

      let latest = started;

      while (!PUSH_TERMINAL_STATUSES.has(latest.status)) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        latest = await getSitemapRegenerateJob(sessionId);
        setPushJob(latest);
      }

      setPushPhase(latest.status === "FAILED" ? "error" : "done");

      if (latest.status === "FAILED" && latest.error) {
        setPushError(latest.error);
      }
    } catch (error) {
      setPushError(friendlyApiErrorMessage(error, "Could not generate and publish."));
      setPushPhase("error");
    }
  }

  const pushPercent =
    pushJob && pushJob.files_total && pushJob.files_total > 0
      ? Math.round(((pushJob.files_done ?? 0) / pushJob.files_total) * 100)
      : null;

  const pushStageLabel: Record<string, string> = {
    PENDING: "Queued…",
    RUNNING: "Generating sitemap files…",
    PUBLISHING: "Publishing to S3…",
    COMPLETE: "Done",
    FAILED: "Failed"
  };

  const canPush = csvPhase === "ready" && patterns.length > 0 && pushPhase !== "running";

  return (
    <main className="min-h-[calc(100vh-56px)] bg-[#F8FAFC]">
      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            <Repeat className="h-6 w-6 text-indigo-500" aria-hidden="true" />
            Sitemap Regenerate
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Pull a site&rsquo;s current sitemaps from S3, upload a CSV of its new
            URLs, decide per pattern whether to keep or rewrite them, then
            generate and publish the site&rsquo;s new sitemap files.
          </p>
        </div>

        {/* Step 1: Source */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">1. Site</CardTitle>
            <CardDescription>
              Choose the S3 site whose sitemaps this will replace.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {domainsLoading ? (
              <p className="text-sm text-slate-500">Listing domains…</p>
            ) : domainsError ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {domainsError}
              </p>
            ) : (
              <select
                value={selectedDomain}
                disabled={fetchPhase === "pulling" || fetchPhase === "parsing"}
                onChange={(event) => setSelectedDomain(event.target.value)}
                className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Select a site…</option>
                {domains.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            )}

            <Button
              type="button"
              onClick={() => void handleFetchFiles()}
              disabled={
                !selectedDomain || fetchPhase === "pulling" || fetchPhase === "parsing"
              }
              className="gap-2"
            >
              {fetchPhase === "pulling" || fetchPhase === "parsing" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4" />
              )}
              {fetchPhase === "pulling" || fetchPhase === "parsing"
                ? "Fetching…"
                : fetchPhase === "ready"
                  ? "Re-fetch Files"
                  : "Fetch Files"}
            </Button>

            {fetchPhase === "pulling" || fetchPhase === "parsing" ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm text-slate-700">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {fetchMessage || "Working…"}
                </p>
                {fetchProgress && fetchProgress.total > 0 ? (
                  <Progress
                    value={Math.round((fetchProgress.current / fetchProgress.total) * 100)}
                  />
                ) : null}
              </div>
            ) : null}

            {fetchPhase === "stalled" ? (
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{fetchMessage}</span>
                </div>
                <div className="flex items-center gap-4 pl-6">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-semibold text-amber-900 hover:text-amber-950"
                    onClick={() => sessionId && void resumeParsing(sessionId)}
                  >
                    <RefreshCcw className="h-3.5 w-3.5" />
                    Check again
                  </button>
                  {sessionId ? (
                    <Link
                      href={`/sessions/${sessionId}`}
                      className="font-semibold text-amber-900 underline hover:text-amber-950"
                    >
                      View full status →
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : null}

            {fetchPhase === "ready" ? (
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="h-4 w-4" />
                Site fetched and ready
              </p>
            ) : null}

            {fetchError ? (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{fetchError}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Step 2: CSV upload */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">2. New URL list</CardTitle>
            <CardDescription>
              Upload a CSV with one URL per row — the new/updated URLs for this
              site.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fetchPhase !== "ready" ? (
              <p className="text-sm text-slate-500">Fetch a site above first.</p>
            ) : (
              <>
                <label
                  className={cn(
                    "flex h-24 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-indigo-300 hover:text-indigo-600",
                    (csvPhase === "uploading" ||
                      csvPhase === "extracting" ||
                      csvPhase === "sampling") &&
                      "pointer-events-none opacity-60"
                  )}
                >
                  <Upload className="h-5 w-5" />
                  Choose a .csv file
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];

                      if (file) {
                        void handleCsvSelected(file);
                      }

                      event.target.value = "";
                    }}
                  />
                </label>

                {csvPhase === "uploading" ? (
                  <p className="flex items-center gap-2 text-sm text-slate-700">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Uploading…
                  </p>
                ) : null}

                {csvPhase === "extracting" ? (
                  <p className="flex items-center gap-2 text-sm text-slate-700">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {csvPatternCount > 0
                      ? `Detecting patterns… ${formatNumber(csvPatternCount)} found`
                      : "Detecting patterns…"}
                  </p>
                ) : null}

                {csvPhase === "sampling" ? (
                  <div className="space-y-2">
                    <p className="flex items-center gap-2 text-sm text-slate-700">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Checking sample URLs… {formatNumber(csvSampledCount)} of{" "}
                      {formatNumber(csvPatternCount)} patterns checked
                    </p>
                    {csvPatternCount > 0 ? (
                      <Progress
                        value={Math.round((csvSampledCount / csvPatternCount) * 100)}
                      />
                    ) : null}
                  </div>
                ) : null}

                {csvPhase === "stalled" ? (
                  <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{csvError}</span>
                    </div>
                    <div className="pl-6">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 font-semibold text-amber-900 hover:text-amber-950"
                        onClick={() => void retryCsvProcessing()}
                      >
                        <RefreshCcw className="h-3.5 w-3.5" />
                        Check again
                      </button>
                    </div>
                  </div>
                ) : null}

                {csvPhase === "ready" && csvUploadResult ? (
                  <div className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                    <p className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
                      <FileText className="h-4 w-4" />
                      {formatNumber(csvTotalUrls || csvUploadResult.url_count)} URLs
                      loaded
                    </p>
                    {csvUploadResult.skipped_count > 0 ? (
                      <p className="text-xs text-emerald-800">
                        {formatNumber(csvUploadResult.skipped_count)} row(s) skipped
                        (not a valid URL).
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {csvPhase === "error" && csvError ? (
                  <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{csvError}</span>
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        {/* Step 3: per-pattern decisions */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">3. Review each pattern</CardTitle>
            <CardDescription>
              A random sample of each pattern&rsquo;s current URLs was checked
              live — problem status codes are highlighted. Keep a pattern
              as-is, or give one example of what its URLs should become.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {csvPhase !== "ready" ? (
              <p className="text-sm text-slate-500">Upload a CSV above first.</p>
            ) : patternsLoading && patterns.length === 0 ? (
              <p className="text-sm text-slate-500">Detecting patterns…</p>
            ) : patterns.length === 0 ? (
              <p className="text-sm text-slate-500">No patterns detected in the CSV.</p>
            ) : (
              patterns.map((pattern) => (
                <PatternReviewCard
                  key={pattern.id}
                  pattern={pattern}
                  decision={decisions.get(pattern.id) ?? { mode: "as_is" }}
                  onChange={(next) => setDecision(pattern.id, next)}
                  onRegisterResolver={(resolve) => registerResolver(pattern.id, resolve)}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Step 4: file count + filename template */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">4. Output files</CardTitle>
            <CardDescription>
              Sitemap files hold up to 50,000 URLs each.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {estimatedFilesTotal > 0 ? (
              <p className="text-sm text-slate-700">
                {formatNumber(decidedUrlTotal)} URLs will produce{" "}
                <span className="font-semibold">{formatNumber(estimatedFilesTotal)}</span>{" "}
                sitemap file{estimatedFilesTotal === 1 ? "" : "s"}.
              </p>
            ) : (
              <p className="text-sm text-slate-500">
                Upload a CSV to see how many files this will produce.
              </p>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="filename-template"
                className="text-sm font-medium text-slate-700"
              >
                Filename pattern
              </label>
              <input
                id="filename-template"
                type="text"
                value={filenameTemplate}
                onChange={(event) => setFilenameTemplate(event.target.value)}
                className="h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
              />
              <p className="text-xs text-slate-500">
                <code>{"{n}"}</code> is the file number — e.g.{" "}
                <code>niin/rfq-{"{n}"}</code> produces{" "}
                <code>niin/rfq-1.xml</code>, <code>niin/rfq-2.xml</code>, …
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Step 5 + 6: lastmod policy + publish */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">5. Lastmod &amp; publish</CardTitle>
            <CardDescription>
              The old sitemap files stay on this tool&rsquo;s storage for 24
              hours as a safety net before they&rsquo;re automatically cleared.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <span className="text-sm font-medium text-slate-700">
                Set &lt;lastmod&gt; to today on…
              </span>
              <div className="space-y-1.5 text-sm text-slate-700">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="lastmod-policy"
                    checked={lastmodPolicy === "all"}
                    onChange={() => setLastmodPolicy("all")}
                  />
                  Every generated file
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="lastmod-policy"
                    checked={lastmodPolicy === "rewritten_only"}
                    onChange={() => setLastmodPolicy("rewritten_only")}
                  />
                  Only URLs that were rewritten
                </label>
              </div>
            </div>

            <Button type="button" onClick={() => void handlePush()} disabled={!canPush} className="gap-2">
              {pushPhase === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {pushPhase === "running" ? "Working…" : "Generate & Publish"}
            </Button>

            {pushJob && pushPhase === "running" ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm text-slate-700">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {pushStageLabel[pushJob.status] ?? pushJob.status}
                </p>
                {pushPercent !== null ? <Progress value={pushPercent} /> : null}
                {pushJob.files_total ? (
                  <p className="text-xs text-slate-500">
                    {formatNumber(pushJob.files_done ?? 0)} of{" "}
                    {formatNumber(pushJob.files_total)} files
                  </p>
                ) : null}
              </div>
            ) : null}

            {pushPhase === "done" && pushJob?.result ? (
              <div className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                <p className="flex items-center gap-2 text-sm font-semibold text-emerald-900">
                  <CheckCircle2 className="h-4 w-4" />
                  Generated and published
                </p>
                <p className="text-xs text-emerald-800">
                  {formatNumber(pushJob.result.files_written ?? 0)} file(s),{" "}
                  {formatNumber(pushJob.result.urls_written ?? 0)} URL(s) written.
                  {pushJob.result.published?.uploaded !== undefined
                    ? ` ${formatNumber(pushJob.result.published.uploaded)} file(s) published to S3.`
                    : ""}
                </p>
              </div>
            ) : null}

            {pushPhase === "error" && pushError ? (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{pushError}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
