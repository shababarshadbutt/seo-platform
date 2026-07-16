"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileText,
  Hourglass,
  Loader2,
  StopCircle
} from "lucide-react";

import {
  cancelSession,
  friendlyApiErrorMessage,
  getPatterns,
  getSession,
  numberValue,
  type SessionResponse,
  type SessionStatus
} from "@/lib/api";
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
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

function isCompleteStatus(status: SessionStatus) {
  return status === "COMPLETE" || status === "COMPLETED";
}

function isFailedStatus(status: SessionStatus) {
  return status === "FAILED" || status === "CANCELLED";
}

function statusBadgeVariant(status: SessionStatus) {
  if (isCompleteStatus(status)) {
    return "success";
  }

  if (isFailedStatus(status)) {
    return "destructive";
  }

  return "secondary";
}

function displayFilename(sessionId: string, filename: string) {
  const prefix = `${sessionId}-`;
  const withoutSession = filename.startsWith(prefix)
    ? filename.slice(prefix.length)
    : filename;

  // Strip the stored-name prefix: new format is "<role>-<name>", legacy stored
  // files used "<uuid>-<name>".
  return withoutSession
    .replace(/^(current|legacy)-/i, "")
    .replace(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
      ""
    );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function phaseMessages(
  status: SessionStatus,
  context: {
    baseUrl: string;
    fileCount: number;
    sampleSize: number;
    totalUrls: number;
  }
) {
  if (status === "EXTRACTING") {
    return [
      `Analysing URL patterns across ${formatNumber(context.fileCount)} files...`,
      "Grouping URLs by structure...",
      "Identifying page types and route patterns...",
      `Building pattern groups from ${formatNumber(context.totalUrls)} URLs...`
    ];
  }

  if (status === "SAMPLING") {
    return [
      `Checking live URLs on ${context.baseUrl}...`,
      `Sampling ${context.sampleSize} URLs per pattern...`,
      "Running health checks in the background...",
      "Almost done — verifying final patterns..."
    ];
  }

  return [];
}

function fileProgressStatus(
  file: SessionResponse["sitemap_files"][number],
  sessionStatus: SessionStatus,
  fileIndex: number,
  firstUnparsedIndex: number
) {
  if (file.parsed_at) {
    return file.is_valid ? "Done" : "Failed";
  }

  if (isFailedStatus(sessionStatus)) {
    return "Failed";
  }

  if (sessionStatus === "PENDING") {
    return "Pending";
  }

  return fileIndex === firstUnparsedIndex ? "Parsing" : "Pending";
}

function fileStatusBadgeVariant(status: string) {
  if (status === "Done") {
    return "success";
  }

  if (status === "Failed") {
    return "destructive";
  }

  if (status === "Parsing") {
    return "warning";
  }

  return "secondary";
}

export default function SessionProcessingPage({
  params
}: {
  params: { id: string };
}) {
  const router = useRouter();
  const [data, setData] = useState<SessionResponse | null>(null);
  const [error, setError] = useState("");
  const [connectionWarning, setConnectionWarning] = useState("");
  const [pendingWarning, setPendingWarning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isFailedFilesOpen, setIsFailedFilesOpen] = useState(false);
  const [phaseMessageIndex, setPhaseMessageIndex] = useState(0);
  const [patternsFound, setPatternsFound] = useState(0);
  const [isStopOpen, setIsStopOpen] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const dataRef = useRef<SessionResponse | null>(null);
  const failedPollsRef = useRef(0);

  useEffect(() => {
    let isCancelled = false;
    let redirectTimer: number | undefined;

    async function pollSession() {
      try {
        const nextData = await getSession(params.id);

        if (isCancelled) {
          return;
        }

        setData(nextData);
        dataRef.current = nextData;
        setError("");
        setConnectionWarning("");
        setIsLoading(false);
        failedPollsRef.current = 0;

        if (
          nextData.session.status === "PENDING" &&
          Date.now() - new Date(nextData.session.created_at).getTime() > 30000
        ) {
          setPendingWarning(true);
        } else {
          setPendingWarning(false);
        }

        if (isCompleteStatus(nextData.session.status) && redirectTimer === undefined) {
          redirectTimer = window.setTimeout(() => {
            if (!isCancelled) {
              router.replace(`/sessions/${params.id}/results`);
            }
          }, 900);
        }
      } catch (nextError) {
        if (isCancelled) {
          return;
        }

        failedPollsRef.current += 1;

        if (failedPollsRef.current >= 3) {
          setConnectionWarning("Having trouble connecting — retrying...");
        }

        if (!dataRef.current && failedPollsRef.current === 1) {
          setError(friendlyApiErrorMessage(nextError, "Unable to load session."));
        }
        setIsLoading(false);
      }
    }

    void pollSession();
    const interval = window.setInterval(() => {
      void pollSession();
    }, 3000);

    return () => {
      isCancelled = true;
      window.clearTimeout(redirectTimer);
      window.clearInterval(interval);
    };
  }, [params.id, router]);

  const status = data?.session.status ?? "PENDING";

  useEffect(() => {
    if (status !== "EXTRACTING" && status !== "SAMPLING") {
      setPhaseMessageIndex(0);
      return;
    }

    setPhaseMessageIndex(0);
    const interval = window.setInterval(() => {
      setPhaseMessageIndex((current) => current + 1);
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "EXTRACTING") {
      return;
    }

    let isCancelled = false;

    async function pollPatternCount() {
      try {
        const patterns = await getPatterns(params.id);

        if (!isCancelled) {
          setPatternsFound(patterns.length);
        }
      } catch {
        if (!isCancelled) {
          setPatternsFound((current) => current);
        }
      }
    }

    void pollPatternCount();
    const interval = window.setInterval(() => {
      void pollPatternCount();
    }, 5000);

    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [params.id, status]);

  const stats = useMemo(() => {
    if (!data) {
      return {
        totalUrls: 0,
        mismatchedUrls: 0
      };
    }

    const totalUrls = data.sitemap_files.reduce(
      (total, file) => total + numberValue(file.total_urls),
      0
    );
    const mismatchedUrls =
      numberValue(data.session.mismatched_url_count) ||
      data.sitemap_files.reduce(
        (total, file) => total + numberValue(file.mismatched_url_count),
        0
      );

    return {
      totalUrls,
      mismatchedUrls
    };
  }, [data]);

  const isLiveStatus = !isFailedStatus(status) && !isCompleteStatus(status);
  const fileProgress = useMemo(() => {
    // Counts are always derived fresh from the latest poll's sitemap_files array
    // (never accumulated across polls). Every file is in exactly one bucket:
    // parsed (done + valid), failed (done + invalid), or pending (not yet done),
    // so parsedFiles + failedCount + pendingFiles === totalFiles and pending can
    // never go negative.
    const files = data?.sitemap_files ?? [];
    const parsedFiles = files.filter(
      (file) => file.parsed_at && file.is_valid
    ).length;
    const failedFiles = files.filter((file) => !file.is_valid);
    const failedCount = failedFiles.length;
    const totalFiles = files.length;
    const terminalFiles = parsedFiles + failedCount;
    const pendingFiles = Math.max(0, totalFiles - terminalFiles);
    const firstUnparsedIndex = files.findIndex((file) => !file.parsed_at);

    return {
      parsedFiles,
      completedFiles: terminalFiles,
      failedFiles,
      failedCount,
      pendingFiles,
      totalFiles,
      shouldUseSummary: totalFiles > 50,
      progressValue:
        totalFiles === 0 ? 0 : Math.round((terminalFiles / totalFiles) * 100),
      files: files.map((file, index) => ({
        ...file,
        progress_status: fileProgressStatus(
          file,
          status,
          index,
          firstUnparsedIndex
        )
      }))
    };
  }, [data?.sitemap_files, status]);
  const emptyFiles = fileProgress.files.filter((file) => file.is_empty);
  const activePhaseMessages = phaseMessages(status, {
    baseUrl: data?.session.base_url ?? "the target site",
    fileCount: fileProgress.totalFiles,
    sampleSize: data?.session.sample_size ?? 0,
    totalUrls: stats.totalUrls
  });
  const activePhaseMessage =
    activePhaseMessages.length > 0
      ? activePhaseMessages[phaseMessageIndex % activePhaseMessages.length]
      : "";
  const currentStepIndex = isCompleteStatus(status)
    ? 4
    : status === "SAMPLING" || status === "EXTRACTED"
      ? 3
      : status === "EXTRACTING"
        ? 2
        : status === "PROCESSING"
        ? 1
        : 0;
  const processingSteps = [
    "Upload received",
    "Parsing files",
    "Extracting patterns",
    "Sampling URLs",
    "Results ready"
  ];

  async function handleStopAnalysis() {
    if (isStopping) {
      return;
    }

    setIsStopping(true);
    setStopError("");

    try {
      await cancelSession(params.id);
      setIsStopOpen(false);
      router.push("/");
    } catch (stopException) {
      setStopError(
        friendlyApiErrorMessage(stopException, "Unable to stop the analysis.")
      );
    } finally {
      setIsStopping(false);
    }
  }

  return (
    <main className="min-h-[calc(100vh-56px)] bg-slate-50">
      <section className="mx-auto flex w-full max-w-6xl flex-col px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid flex-1 content-start gap-6">
          <Card className="overflow-hidden">
            <CardHeader className="border-b border-slate-200 bg-white px-6 py-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-indigo-600">
                    Processing session
                  </p>
                  <CardTitle className="mt-2 text-2xl font-bold text-slate-900">
                    {data?.session.name ?? "Loading session"}
                  </CardTitle>
                  <CardDescription className="mt-2 break-all font-mono text-xs text-slate-500">
                    {data?.session.base_url ?? "Waiting for session data"}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {isLiveStatus ? (
                    <div className="flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Polling every 3 seconds
                    </div>
                  ) : null}
                  <Badge
                    variant={statusBadgeVariant(status)}
                    className="w-fit rounded-full px-3 py-1"
                  >
                    {status}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6 p-6">
              <div className="grid gap-3 md:grid-cols-5">
                {processingSteps.map((step, index) => {
                  const stepState =
                    isCompleteStatus(status) || index < currentStepIndex
                      ? "complete"
                      : index === currentStepIndex && !isFailedStatus(status)
                        ? "current"
                        : "waiting";

                  return (
                    <div
                      key={step}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border bg-white p-3 shadow-sm",
                        stepState === "current"
                          ? "border-indigo-200 bg-indigo-50/60"
                          : "border-slate-200"
                      )}
                    >
                      <span
                        className={cn(
                          "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                          stepState === "complete" &&
                            "bg-indigo-600 text-white",
                          stepState === "current" &&
                            "border-2 border-indigo-500 bg-white text-indigo-600",
                          stepState === "waiting" &&
                            "border-2 border-slate-300 bg-white text-slate-300"
                        )}
                      >
                        {stepState === "complete" ? (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        ) : stepState === "current" ? (
                          <>
                            <span className="absolute inset-0 rounded-full border border-indigo-300 animate-ping" />
                            <Loader2
                              className="h-4 w-4 animate-spin"
                              aria-hidden="true"
                            />
                          </>
                        ) : (
                          <Hourglass className="h-4 w-4" aria-hidden="true" />
                        )}
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-700">
                        <span className="truncate">{step}</span>
                        {stepState === "current" ? (
                          <span
                            className="flex shrink-0 gap-0.5"
                            aria-hidden="true"
                          >
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500 [animation-delay:150ms]" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500 [animation-delay:300ms]" />
                          </span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>

              {activePhaseMessage ? (
                <div
                  className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-medium text-indigo-800"
                  role="status"
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  <span>{activePhaseMessage}</span>
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <p className="text-base font-semibold text-slate-700">
                      Overall progress
                    </p>
                    <p className="text-sm text-slate-500">
                      {fileProgress.completedFiles} / {fileProgress.totalFiles} files completed
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-slate-900">
                    {fileProgress.progressValue}%
                  </p>
                </div>
                <Progress
                  value={fileProgress.progressValue}
                  className="h-3 bg-slate-200"
                  indicatorClassName="bg-indigo-500 transition-transform duration-700 ease-out"
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                {fileProgress.shouldUseSummary ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-5">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase text-slate-500">
                          Parsed
                        </p>
                        <p className="mt-2 text-2xl font-bold text-slate-900">
                          {formatNumber(fileProgress.parsedFiles)} /{" "}
                          {formatNumber(fileProgress.totalFiles)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">files</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase text-slate-500">
                          Failed
                        </p>
                        {fileProgress.failedFiles.length > 0 ? (
                          <button
                            type="button"
                            className="mt-2 text-left text-2xl font-bold text-red-600 underline-offset-4 hover:underline"
                            onClick={() => setIsFailedFilesOpen(true)}
                          >
                            {formatNumber(fileProgress.failedFiles.length)}
                          </button>
                        ) : (
                          <p className="mt-2 text-2xl font-bold text-slate-900">
                            0
                          </p>
                        )}
                        <p className="mt-1 text-sm text-slate-500">files</p>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                        <p className="text-xs font-semibold uppercase text-slate-500">
                          Pending
                        </p>
                        <p className="mt-2 text-2xl font-bold text-slate-900">
                          {formatNumber(fileProgress.pendingFiles)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">files</p>
                      </div>
                    </div>
                    <div className="mt-5 space-y-2">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="font-semibold text-slate-700">
                          Overall file progress
                        </span>
                        <span className="font-semibold text-slate-900">
                          {fileProgress.progressValue}%
                        </span>
                      </div>
                      <Progress
                        value={fileProgress.progressValue}
                        className="h-3 bg-slate-200"
                        indicatorClassName="bg-indigo-500 transition-transform duration-700 ease-out"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase text-slate-500">
                      <span>Filename</span>
                      <span>Status</span>
                    </div>
                    {fileProgress.files.length > 0 ? (
                      <ul>
                        {fileProgress.files.map((file) => (
                          <li
                            key={file.id}
                            className="grid min-h-14 grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 odd:bg-slate-50/70"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {file.progress_status === "Done" ? (
                                <CheckCircle2
                                  className="h-4 w-4 shrink-0 text-emerald-600"
                                  aria-hidden="true"
                                />
                              ) : file.progress_status === "Parsing" ? (
                                <Loader2
                                  className="h-4 w-4 shrink-0 animate-spin text-indigo-600"
                                  aria-hidden="true"
                                />
                              ) : file.progress_status === "Failed" ? (
                                <AlertCircle
                                  className="h-4 w-4 shrink-0 text-red-500"
                                  aria-hidden="true"
                                />
                              ) : (
                                <FileText
                                  className="h-4 w-4 shrink-0 text-slate-400"
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate font-mono text-xs text-slate-700">
                                {displayFilename(data?.session.id ?? "", file.filename)}
                              </span>
                            </div>
                            <Badge
                              variant={fileStatusBadgeVariant(file.progress_status)}
                              className="w-fit rounded-full"
                            >
                              {file.progress_status}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-4 py-5 text-sm text-slate-500">
                        Waiting for sitemap files.
                      </p>
                    )}
                  </div>
                )}

                <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-indigo-100 bg-indigo-50/70 p-6 text-center">
                  <div className="relative flex h-32 w-32 items-center justify-center">
                    <span className="absolute inset-0 rounded-full border-4 border-indigo-200 animate-ping" />
                    <span className="absolute inset-4 rounded-full border border-indigo-200" />
                    <span className="absolute inset-8 rounded-full bg-indigo-100 animate-pulse" />
                    <Loader2 className="relative h-10 w-10 animate-spin text-indigo-600" />
                  </div>
                  <p className="mt-4 text-sm font-semibold text-indigo-700">
                    Analysis running
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    URL checks continue in the background.
                  </p>
                </div>
              </div>

              <Dialog
                open={isFailedFilesOpen}
                onOpenChange={setIsFailedFilesOpen}
              >
                <DialogContent className="max-h-[80vh] overflow-hidden">
                  <DialogHeader>
                    <DialogTitle>Failed files</DialogTitle>
                    <DialogDescription>
                      Files that could not be parsed for this session.
                    </DialogDescription>
                  </DialogHeader>
                  <ul className="max-h-[55vh] space-y-2 overflow-y-auto pr-2">
                    {fileProgress.failedFiles.map((file) => (
                      <li
                        key={`failed-${file.id}`}
                        className="rounded-md border border-red-100 bg-red-50 px-3 py-2"
                      >
                        <p className="break-all font-mono text-xs text-red-900">
                          {displayFilename(data?.session.id ?? "", file.filename)}
                        </p>
                        {file.parse_error ? (
                          <p className="mt-1 text-xs text-red-700">
                            {file.parse_error}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </DialogContent>
              </Dialog>

              {!fileProgress.shouldUseSummary && emptyFiles.length > 0 ? (
                <div className="space-y-2">
                  {emptyFiles.map((file) => (
                    <div
                      key={`empty-${file.id}`}
                      className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                      role="status"
                    >
                      ⚠️ {displayFilename(data?.session.id ?? "", file.filename)} — Sitemap found but contains no URLs
                    </div>
                  ))}
                </div>
              ) : null}

              {error ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              {connectionWarning ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                  role="status"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{connectionWarning}</span>
                </div>
              ) : null}

              {pendingWarning ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                  role="status"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    This is taking longer than usual — the worker may be busy
                  </span>
                </div>
              ) : null}

              {isFailedStatus(status) ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Session ended with status {status}.</span>
                </div>
              ) : null}

              {isLiveStatus ? (
                <div className="flex flex-col items-center gap-2 border-t border-slate-200 pt-6">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => {
                      setStopError("");
                      setIsStopOpen(true);
                    }}
                  >
                    <StopCircle className="mr-2 h-5 w-5" />
                    Stop Analysis
                  </Button>
                  <p className="text-xs text-slate-500">
                    Stops processing and discards this session.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Dialog open={isStopOpen} onOpenChange={setIsStopOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Stop this analysis?</DialogTitle>
                <DialogDescription>
                  All progress will be lost and you will need to start again.
                </DialogDescription>
              </DialogHeader>
              {stopError ? (
                <p className="text-sm text-red-500" role="alert">
                  {stopError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isStopping}
                  onClick={() => setIsStopOpen(false)}
                >
                  Keep running
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isStopping}
                  onClick={() => void handleStopAnalysis()}
                >
                  {isStopping ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Stopping
                    </>
                  ) : (
                    "Stop Analysis"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="border-l-4 border-l-indigo-500">
              <CardHeader className="pb-2">
                <CardDescription className="text-sm text-slate-500">
                  Total URLs
                </CardDescription>
                <CardTitle className="text-2xl font-bold text-slate-900">
                  {formatNumber(stats.totalUrls)}
                </CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-l-4 border-l-indigo-500">
              <CardHeader className="pb-2">
                <CardDescription className="text-sm text-slate-500">
                  Files
                </CardDescription>
                <CardTitle className="text-2xl font-bold text-slate-900">
                  {fileProgress.parsedFiles} of {fileProgress.totalFiles} parsed
                </CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-l-4 border-l-indigo-500">
              <CardHeader className="pb-2">
                <CardDescription className="text-sm text-slate-500">
                  Mismatched URLs
                </CardDescription>
                <CardTitle className="text-2xl font-bold text-slate-900">
                  {formatNumber(stats.mismatchedUrls)}
                </CardTitle>
              </CardHeader>
            </Card>
            {status === "EXTRACTING" ? (
              <Card className="border-l-4 border-l-indigo-500">
                <CardHeader className="pb-2">
                  <CardDescription className="text-sm text-slate-500">
                    Patterns found so far
                  </CardDescription>
                  <CardTitle className="text-2xl font-bold text-slate-900">
                    {formatNumber(patternsFound)}
                  </CardTitle>
                </CardHeader>
              </Card>
            ) : null}
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading session
            </div>
          ) : null}

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="h-4 w-4" aria-hidden="true" />
            Results open automatically when sampling completes.
          </div>
        </div>
      </section>
    </main>
  );
}
