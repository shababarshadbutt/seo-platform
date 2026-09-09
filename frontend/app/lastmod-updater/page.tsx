"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Cloud,
  Loader2,
  RefreshCcw,
  Send,
  Server
} from "lucide-react";

import {
  createSession,
  enqueueLastmodUpdate,
  friendlyApiErrorMessage,
  getLastmodUpdateJob,
  getPatterns,
  getS3Domains,
  getSession,
  getSessionFiles,
  getSftpDomains,
  startS3Pull,
  startSftpPull,
  followS3PullProgress,
  followSftpPullProgress,
  type LastmodUpdateJobStatus,
  type LastmodUpdateScope,
  type Pattern,
  type RemotePullProgressEvent,
  type SessionFile
} from "@/lib/api";
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

type SourceMode = "sftp" | "s3";
type FetchPhase = "idle" | "pulling" | "parsing" | "ready" | "stalled" | "error";
type ScopeTab = "all" | "selected" | "patterns";
type PushPhase = "idle" | "running" | "done" | "error";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

const PUSH_TERMINAL_STATUSES = new Set(["COMPLETE", "FAILED"]);

// A large domain (thousands of files) can legitimately take many minutes to
// finish parsing, so this can't be a flat wall-clock cap — it has to be a
// "no progress at all" stall detector. The 2-minute watchdog re-enqueues any
// file whose parse job died, so a healthy-but-slow run can go a couple of
// minutes between visible progress; anything longer than that with zero
// files completing is a real stall, not just a big domain.
const PARSE_STALL_THRESHOLD_MS = 150_000;

class ParsingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParsingTimeoutError";
  }
}

export default function LastmodUpdaterPage() {
  const router = useRouter();

  // ---- Step 1: source + domain ---------------------------------------------
  const [sourceMode, setSourceMode] = useState<SourceMode>("sftp");
  const [domains, setDomains] = useState<string[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [domainsError, setDomainsError] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");

  async function loadDomains(mode: SourceMode) {
    setDomainsLoading(true);
    setDomainsError("");

    try {
      const result =
        mode === "sftp" ? await getSftpDomains() : await getS3Domains();

      setDomains(result.domains);
    } catch (error) {
      setDomainsError(
        friendlyApiErrorMessage(error, `Could not list ${mode.toUpperCase()} domains.`)
      );
    } finally {
      setDomainsLoading(false);
    }
  }

  useEffect(() => {
    setDomains([]);
    setSelectedDomain("");
    void loadDomains(sourceMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceMode]);

  // ---- Step 1: fetch (create session, pull, wait for parsing) -------------
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fetchPhase, setFetchPhase] = useState<FetchPhase>("idle");
  const [fetchMessage, setFetchMessage] = useState("");
  const [fetchProgress, setFetchProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [fetchError, setFetchError] = useState("");
  const [skippedFiles, setSkippedFiles] = useState<{ name: string; reason: string }[]>([]);
  const pullSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      pullSourceRef.current?.close();
    };
  }, []);

  // A refresh mid-fetch used to lose the only handle to the in-flight session
  // (nothing was ever persisted to the URL), so there was nothing to click —
  // just the Step 1 domain picker again. Restore it from ?session=<id> and
  // pick up wherever the run actually is.
  useEffect(() => {
    const existingSessionId = new URLSearchParams(window.location.search).get("session");

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
        throw new Error("Fetching this domain's files failed — check the source and try again.");
      }

      const total = sitemapFiles.length;
      const parsedCount = sitemapFiles.filter((file) => file.parsed_at !== null).length;
      const failedCount = sitemapFiles.filter(
        (file) => file.parsed_at !== null && !file.is_valid
      ).length;

      if (total > 0 && parsedCount === total) {
        return;
      }

      if (parsedCount !== lastParsedCount) {
        lastParsedCount = parsedCount;
        lastProgressAt = Date.now();
      }

      setFetchMessage(
        total > 0
          ? `Parsing files… ${parsedCount} of ${total} done${
              failedCount > 0 ? ` (${failedCount} failed)` : ""
            }`
          : "Waiting for files to finish parsing…"
      );

      if (Date.now() - lastProgressAt > PARSE_STALL_THRESHOLD_MS) {
        throw new ParsingTimeoutError(
          total > 0
            ? `Parsing hasn't made progress in a couple of minutes — ${parsedCount} of ${total} files done${
                failedCount > 0 ? `, ${failedCount} failed` : ""
              }. It may still finish on its own, or a file may be stuck.`
            : "Parsing hasn't started and there's been no progress for a couple of minutes."
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

  // Shared by the initial fetch and the "Check again" / refresh-resume paths
  // so a stall never has to restart the S3/SFTP pull — parsing is the only
  // thing that was ever stuck.
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
    setSkippedFiles([]);
    setFetchPhase("pulling");
    setFetchMessage("Starting…");

    try {
      const created = await createSession({
        name: `Lastmod Updater — ${selectedDomain} — ${new Date().toISOString()}`,
        baseUrl: `https://${selectedDomain}`,
        sampleSize: 5,
        concurrency: 1
      });
      const newSessionId = created.session_id;

      setSessionId(newSessionId);
      // So a refresh at any point from here on has something to reattach to
      // instead of stranding the user back at the domain picker.
      router.replace(`/lastmod-updater?session=${newSessionId}`, { scroll: false });

      const startPull = sourceMode === "sftp" ? startSftpPull : startS3Pull;
      const followProgress =
        sourceMode === "sftp" ? followSftpPullProgress : followS3PullProgress;

      await startPull(newSessionId, selectedDomain);

      await new Promise<void>((resolve, reject) => {
        const source = followProgress(newSessionId, (event: RemotePullProgressEvent) => {
          if (event.type === "progress") {
            setFetchMessage(event.message ?? "Pulling files…");
            setFetchProgress(
              typeof event.current === "number" && typeof event.total === "number"
                ? { current: event.current, total: event.total }
                : null
            );
          } else if (event.type === "done") {
            setSkippedFiles(event.result?.skippedFiles ?? []);
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

  // ---- Step 2: scope --------------------------------------------------------
  const [scopeTab, setScopeTab] = useState<ScopeTab>("all");
  const [files, setFiles] = useState<SessionFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedFilenames, setSelectedFilenames] = useState<Set<string>>(new Set());

  const [patterns, setPatterns] = useState<Pattern[]>([]);
  const [patternsLoading, setPatternsLoading] = useState(false);
  const [selectedPatternIds, setSelectedPatternIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (fetchPhase !== "ready" || !sessionId) {
      return;
    }

    setFilesLoading(true);
    void getSessionFiles(sessionId)
      .then((response) => setFiles(response.files.filter((file) => !file.is_index)))
      .finally(() => setFilesLoading(false));
  }, [fetchPhase, sessionId]);

  // Patterns take a little longer to appear (extraction runs after parsing) —
  // poll while the tab is open and nothing has shown up yet.
  useEffect(() => {
    if (fetchPhase !== "ready" || !sessionId || scopeTab !== "patterns") {
      return;
    }

    let cancelled = false;

    async function poll() {
      for (;;) {
        if (cancelled) {
          return;
        }

        setPatternsLoading(true);

        try {
          const loaded = await getPatterns(sessionId as string);

          if (cancelled) {
            return;
          }

          setPatterns(loaded);

          if (loaded.length > 0) {
            return;
          }

          const { session } = await getSession(sessionId as string);

          if (
            session.status === "SAMPLING" ||
            session.status === "COMPLETE" ||
            session.status === "COMPLETED"
          ) {
            // Extraction has finished and found nothing — stop polling.
            return;
          }
        } finally {
          if (!cancelled) {
            setPatternsLoading(false);
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    void poll();

    return () => {
      cancelled = true;
    };
  }, [fetchPhase, sessionId, scopeTab]);

  function toggleFilename(filename: string) {
    setSelectedFilenames((current) => {
      const next = new Set(current);

      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }

      return next;
    });
  }

  function togglePatternId(patternId: string) {
    setSelectedPatternIds((current) => {
      const next = new Set(current);

      if (next.has(patternId)) {
        next.delete(patternId);
      } else {
        next.add(patternId);
      }

      return next;
    });
  }

  // ---- Date + push ----------------------------------------------------------
  const [targetDate, setTargetDate] = useState(todayDateString());
  const [pushPhase, setPushPhase] = useState<PushPhase>("idle");
  const [pushJob, setPushJob] = useState<LastmodUpdateJobStatus | null>(null);
  const [pushError, setPushError] = useState("");

  const scope: LastmodUpdateScope | null =
    scopeTab === "all"
      ? { type: "all" }
      : scopeTab === "selected"
        ? selectedFilenames.size > 0
          ? { type: "files", filenames: Array.from(selectedFilenames) }
          : null
        : selectedPatternIds.size > 0
          ? { type: "patterns", pattern_ids: Array.from(selectedPatternIds) }
          : null;

  const canPush = fetchPhase === "ready" && scope !== null && pushPhase !== "running";

  async function handlePush() {
    if (!sessionId || !scope) {
      return;
    }

    setPushError("");
    setPushPhase("running");
    setPushJob(null);

    try {
      const started = await enqueueLastmodUpdate(sessionId, { scope, targetDate });

      setPushJob(started);

      for (;;) {
        if (PUSH_TERMINAL_STATUSES.has(started.status)) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 1500));
        const polled = await getLastmodUpdateJob(sessionId);

        setPushJob(polled);

        if (PUSH_TERMINAL_STATUSES.has(polled.status)) {
          break;
        }
      }

      const finalJob = await getLastmodUpdateJob(sessionId);

      setPushJob(finalJob);
      setPushPhase(finalJob.status === "FAILED" ? "error" : "done");

      if (finalJob.status === "FAILED" && finalJob.error) {
        setPushError(finalJob.error);
      }
    } catch (error) {
      setPushError(friendlyApiErrorMessage(error, "Could not update lastmod and publish."));
      setPushPhase("error");
    }
  }

  const pushPercent =
    pushJob && pushJob.files_total && pushJob.files_total > 0
      ? Math.round(((pushJob.files_done ?? 0) / pushJob.files_total) * 100)
      : null;

  const pushStageLabel: Record<string, string> = {
    PENDING: "Queued…",
    RUNNING: "Updating <lastmod>…",
    PUBLISHING: "Publishing to S3…",
    COMPLETE: "Done",
    FAILED: "Failed"
  };

  return (
    <main className="min-h-[calc(100vh-56px)] bg-[#F8FAFC]">
      <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            <CalendarClock className="h-6 w-6 text-indigo-500" aria-hidden="true" />
            Lastmod Updater
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Pull a domain&rsquo;s sitemaps from SFTP or S3, bump{" "}
            <code>&lt;lastmod&gt;</code> on the URLs you choose, and push straight
            back to S3 — no cleaning.
          </p>
        </div>

        {/* Step 1: Source */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">1. Source</CardTitle>
            <CardDescription>
              Choose where this domain&rsquo;s current sitemaps live.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="grid grid-cols-2 gap-1 rounded-full border border-indigo-100 bg-indigo-50 p-1"
              role="tablist"
              aria-label="Sitemap source"
            >
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === "sftp"}
                disabled={fetchPhase === "pulling" || fetchPhase === "parsing"}
                onClick={() => setSourceMode("sftp")}
                className={cn(
                  "flex h-9 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  sourceMode === "sftp"
                    ? "bg-indigo-500 text-white shadow-sm"
                    : "text-slate-500 hover:text-indigo-600"
                )}
              >
                <Server className="h-4 w-4" />
                SFTP
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === "s3"}
                disabled={fetchPhase === "pulling" || fetchPhase === "parsing"}
                onClick={() => setSourceMode("s3")}
                className={cn(
                  "flex h-9 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  sourceMode === "s3"
                    ? "bg-indigo-500 text-white shadow-sm"
                    : "text-slate-500 hover:text-indigo-600"
                )}
              >
                <Cloud className="h-4 w-4" />
                S3
              </button>
            </div>

            {domainsLoading ? (
              <p className="text-sm text-slate-500">Listing domains…</p>
            ) : domainsError ? (
              <div className="space-y-2">
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {domainsError}
                </p>
                <button
                  type="button"
                  className="text-sm font-semibold text-indigo-600 hover:text-indigo-700"
                  onClick={() => void loadDomains(sourceMode)}
                >
                  Try again
                </button>
              </div>
            ) : (
              <select
                value={selectedDomain}
                disabled={fetchPhase === "pulling" || fetchPhase === "parsing"}
                onChange={(event) => setSelectedDomain(event.target.value)}
                className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="">Select a domain…</option>
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
                {formatNumber(files.length)} file{files.length === 1 ? "" : "s"} ready
              </p>
            ) : null}

            {fetchPhase === "ready" && skippedFiles.length > 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  {skippedFiles.length} file{skippedFiles.length === 1 ? "" : "s"} couldn&apos;t be
                  pulled and {skippedFiles.length === 1 ? "was" : "were"} skipped — the rest are
                  ready to use.
                  <br />
                  {skippedFiles.map((file) => `${file.name} (${file.reason})`).join(", ")}
                </span>
              </div>
            ) : null}

            {fetchError ? (
              <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{fetchError}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Step 2: Scope */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">2. Scope</CardTitle>
            <CardDescription>
              Choose which URLs get a new <code>&lt;lastmod&gt;</code>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="grid grid-cols-3 gap-1 rounded-full border border-indigo-100 bg-indigo-50 p-1"
              role="tablist"
              aria-label="Update scope"
            >
              {(
                [
                  { key: "all", label: "All Files" },
                  { key: "selected", label: "Selected Files" },
                  { key: "patterns", label: "Vertical wise" }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={scopeTab === tab.key}
                  disabled={fetchPhase !== "ready"}
                  onClick={() => setScopeTab(tab.key)}
                  className={cn(
                    "flex h-9 items-center justify-center rounded-full text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    scopeTab === tab.key
                      ? "bg-indigo-500 text-white shadow-sm"
                      : "text-slate-500 hover:text-indigo-600"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {fetchPhase !== "ready" ? (
              <p className="text-sm text-slate-500">
                Fetch a domain&rsquo;s files above to choose a scope.
              </p>
            ) : scopeTab === "all" ? (
              filesLoading ? (
                <p className="text-sm text-slate-500">Loading files…</p>
              ) : (
                <p className="text-sm text-slate-600">
                  Every <code>&lt;lastmod&gt;</code> in all {formatNumber(files.length)}{" "}
                  file{files.length === 1 ? "" : "s"} will be updated.
                </p>
              )
            ) : scopeTab === "selected" ? (
              filesLoading ? (
                <p className="text-sm text-slate-500">Loading files…</p>
              ) : files.length === 0 ? (
                <p className="text-sm text-slate-500">No files found.</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-slate-200">
                  {files.map((file) => (
                    <li key={file.id}>
                      <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedFilenames.has(file.filename)}
                          onChange={() => toggleFilename(file.filename)}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-slate-700">
                          {file.filename}
                        </span>
                        <span className="shrink-0 text-slate-400">
                          {formatNumber(Number(file.total_urls) || 0)} URLs
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )
            ) : patternsLoading && patterns.length === 0 ? (
              <p className="text-sm text-slate-500">Detecting patterns…</p>
            ) : patterns.length === 0 ? (
              <p className="text-sm text-slate-500">No patterns detected yet.</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-slate-200">
                {patterns.map((pattern) => (
                  <li key={pattern.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={selectedPatternIds.has(pattern.id)}
                        onChange={() => togglePatternId(pattern.id)}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-slate-700">
                        {pattern.template}
                      </span>
                      <span className="shrink-0 text-slate-400">
                        {formatNumber(Number(pattern.total_urls) || 0)} URLs
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Step 3: Date + push */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">3. Date &amp; push</CardTitle>
            <CardDescription>
              Defaults to today — pick another date if needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="lastmod-date" className="text-sm font-medium text-slate-700">
                New lastmod date
              </label>
              <input
                id="lastmod-date"
                type="date"
                value={targetDate}
                onChange={(event) => setTargetDate(event.target.value)}
                className="h-10 rounded-lg border border-slate-200 px-3 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none"
              />
            </div>

            <Button type="button" onClick={() => void handlePush()} disabled={!canPush} className="gap-2">
              {pushPhase === "running" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {pushPhase === "running" ? "Working…" : "Push to S3"}
            </Button>

            {!canPush && fetchPhase === "ready" && scope === null ? (
              <p className="text-xs text-slate-500">
                Pick at least one file or pattern in the scope above to enable this.
              </p>
            ) : null}

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
                  Updated and published
                </p>
                <p className="text-xs text-emerald-800">
                  {formatNumber(pushJob.result.files_touched ?? 0)} file
                  {pushJob.result.files_touched === 1 ? "" : "s"} touched,{" "}
                  {formatNumber(pushJob.result.urls_rewritten ?? 0)} URL
                  {pushJob.result.urls_rewritten === 1 ? "" : "s"} rewritten to{" "}
                  {pushJob.result.target_date}.
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
