"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Trash2
} from "lucide-react";

import {
  deleteProblemUrls,
  getDeleteProblemUrlsStatus,
  getProblemFiles,
  getVerificationStatus,
  startUrlVerification,
  type MaintenanceJob,
  type ProblemFile,
  type VerificationStatus
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

type Props = {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFinished?: () => void;
};

const ALL_STATUSES = [301, 302, 307, 308, 404];
const IN_FLIGHT = ["PENDING", "RUNNING", "UNDOING"];
const MAX_PATTERNS_SHOWN = 3;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function statusBadgeClass(status: number) {
  return status === 404
    ? "bg-red-100 text-red-700"
    : "bg-amber-100 text-amber-700";
}

type Phase = "loading" | "list" | "progress";

export function ProblemUrlsDialog({
  sessionId,
  open,
  onOpenChange,
  onFinished
}: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [files, setFiles] = useState<ProblemFile[]>([]);
  const [activeStatuses, setActiveStatuses] = useState<Set<number>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listLoading, setListLoading] = useState(false);
  const [status, setStatus] = useState<MaintenanceJob | null>(null);
  const [error, setError] = useState("");
  const finishedRef = useRef(false);
  // Full-population verification (verify-then-act, v1.49). Until a verification
  // has run, the counts below only cover the sampled URLs (≤ sample_size per
  // pattern); after one, they cover every URL in the uploaded files.
  const [verification, setVerification] = useState<VerificationStatus | null>(
    null
  );
  const [verifyPolling, setVerifyPolling] = useState(false);
  const [verifyStartError, setVerifyStartError] = useState("");
  // Bumped when a verification completes so the file list refetches with the
  // verified counts.
  const [refreshKey, setRefreshKey] = useState(0);

  // "All" (empty set) means every problem status.
  const effectiveStatuses = useMemo(
    () =>
      activeStatuses.size > 0
        ? ALL_STATUSES.filter((code) => activeStatuses.has(code))
        : ALL_STATUSES,
    [activeStatuses]
  );
  const statusKey = effectiveStatuses.join(",");

  // Reset everything when the dialog opens.
  useEffect(() => {
    if (!open) {
      return;
    }

    setPhase("loading");
    setFiles([]);
    setActiveStatuses(new Set());
    setSelectedFiles(new Set());
    setExpanded(new Set());
    setStatus(null);
    setError("");
    setVerifyStartError("");
    finishedRef.current = false;

    // Pick up the verification state on open — and resume the progress display
    // if a run is already going (it survives the dialog being closed).
    void (async () => {
      try {
        const current = await getVerificationStatus(sessionId);

        setVerification(current);

        if (
          current.job &&
          (current.job.status === "PENDING" || current.job.status === "RUNNING")
        ) {
          setVerifyPolling(true);
        }
      } catch {
        // Non-fatal: the dialog still works sample-backed.
      }
    })();
  }, [open, sessionId]);

  // Poll the verification job while it runs; when it finishes, refetch the
  // file list so counts/chips reflect the full verified population.
  useEffect(() => {
    if (!verifyPolling) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const current = await getVerificationStatus(sessionId);

        if (cancelled) {
          return;
        }

        setVerification(current);

        if (
          current.job &&
          (current.job.status === "PENDING" || current.job.status === "RUNNING")
        ) {
          timer = setTimeout(tick, 1500);
        } else {
          setVerifyPolling(false);
          setRefreshKey((key) => key + 1);
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(tick, 1500);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [verifyPolling, sessionId]);

  // Fetch (re-fetch on filter change) so counts + deletion stay aligned to the
  // active statuses.
  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    setListLoading(true);
    setError("");

    void (async () => {
      try {
        const result = await getProblemFiles(
          sessionId,
          activeStatuses.size > 0 ? effectiveStatuses : undefined
        );

        if (cancelled) {
          return;
        }

        setFiles(result.files);
        // Default to every shown file selected.
        setSelectedFiles(new Set(result.files.map((file) => file.file_id)));
        setPhase("list");
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to load files."
          );
          setPhase("list");
        }
      } finally {
        if (!cancelled) {
          setListLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, statusKey, refreshKey]);

  const handleFinished = useCallback(() => {
    if (finishedRef.current) {
      return;
    }

    finishedRef.current = true;
    onFinished?.();
  }, [onFinished]);

  // Poll the deletion job while it runs.
  useEffect(() => {
    if (phase !== "progress") {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const { job } = await getDeleteProblemUrlsStatus(sessionId);

        if (cancelled) {
          return;
        }

        setStatus(job);

        if (job && IN_FLIGHT.includes(job.status)) {
          timer = setTimeout(tick, 2000);
        } else {
          handleFinished();
        }
      } catch {
        if (!cancelled) {
          timer = setTimeout(tick, 2000);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, sessionId, handleFinished]);

  async function handleVerify() {
    setVerifyStartError("");

    try {
      await startUrlVerification(sessionId);
      setVerifyPolling(true);
    } catch (nextError) {
      setVerifyStartError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to start verification."
      );
    }
  }

  function toggleStatus(code: number) {
    setActiveStatuses((current) => {
      const next = new Set(current);

      if (next.has(code)) {
        next.delete(code);
      } else {
        next.add(code);
      }

      return next;
    });
  }

  function toggleFile(fileId: string) {
    setSelectedFiles((current) => {
      const next = new Set(current);

      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }

      return next;
    });
  }

  function toggleAllFiles() {
    setSelectedFiles((current) =>
      current.size === files.length
        ? new Set()
        : new Set(files.map((file) => file.file_id))
    );
  }

  function toggleExpanded(fileId: string) {
    setExpanded((current) => {
      const next = new Set(current);

      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }

      return next;
    });
  }

  async function handleDelete() {
    const ids = files
      .filter((file) => selectedFiles.has(file.file_id))
      .map((file) => file.file_id);

    if (ids.length === 0) {
      return;
    }

    setError("");

    try {
      await deleteProblemUrls(sessionId, ids, effectiveStatuses);
      setStatus({
        id: "",
        kind: "delete-problem-urls",
        status: "PENDING",
        files_total: ids.length,
        files_done: 0,
        items_changed: 0,
        error: null
      });
      setPhase("progress");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Unable to delete."
      );
    }
  }

  // Per-status counts over the verified full population — shown on the chips
  // once a fresh verification exists so "404 · 2,113" means every 404 in the
  // files, not the sampled handful.
  const verifiedCountByStatus = useMemo(() => {
    const counts = new Map<number, number>();

    for (const entry of verification?.counts_by_status ?? []) {
      counts.set(entry.http_status, entry.count);
    }

    return counts;
  }, [verification]);
  const showVerifiedCounts = Boolean(
    verification?.verified_at && !verification.stale && !verifyPolling
  );

  const selectedCount = useMemo(
    () => files.filter((file) => selectedFiles.has(file.file_id)).length,
    [files, selectedFiles]
  );
  const allSelected = files.length > 0 && selectedCount === files.length;

  const filesTotal = status?.files_total ?? 0;
  const filesDone = status?.files_done ?? 0;
  const progressValue =
    filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0;
  const isInFlight = status ? IN_FLIGHT.includes(status.status) : false;
  const isDone = status?.status === "COMPLETE";
  const isFailed = status?.status === "FAILED";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (phase === "progress" && isInFlight && !next) {
          return;
        }

        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete Problem URLs from Sitemaps</DialogTitle>
          <DialogDescription>
            Remove all redirecting or 404 URLs from selected sitemap files.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading problem files…
          </div>
        ) : null}

        {phase === "list" ? (
          <div className="space-y-3">
            {/* Full-population verification (v1.49) */}
            {verifyPolling ? (
              <div
                className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2"
                data-testid="verify-progress"
              >
                <p className="flex items-center gap-2 text-sm text-indigo-900">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Verifying{" "}
                  {formatNumber(verification?.job?.urls_done ?? 0)} of{" "}
                  {formatNumber(verification?.job?.urls_total ?? 0)} URLs…
                </p>
                <Progress
                  value={
                    (verification?.job?.urls_total ?? 0) > 0
                      ? Math.round(
                          ((verification?.job?.urls_done ?? 0) /
                            (verification?.job?.urls_total ?? 1)) *
                            100
                        )
                      : 0
                  }
                />
              </div>
            ) : verification?.verified_at && !verification.stale ? (
              <p className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Every URL in the uploaded files has been HTTP-verified — the
                counts below cover the full population, not just the samples.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="min-w-0 flex-1 text-sm text-amber-900">
                  {verification?.verified_at
                    ? "Files changed since the last verification — re-verify to refresh the full-population counts."
                    : "Counts below cover only the sampled URLs (a handful per pattern). Verify to find every problem URL in the uploaded files."}
                </p>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 bg-amber-600 hover:bg-amber-700"
                  onClick={() => void handleVerify()}
                >
                  {verification?.verified_at ? "Re-verify all URLs" : "Verify all URLs"}
                </Button>
              </div>
            )}
            {verifyStartError ? (
              <p className="text-sm text-red-500">{verifyStartError}</p>
            ) : null}

            {/* Status filter */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium text-slate-500">
                Filter:
              </span>
              <button
                type="button"
                onClick={() => setActiveStatuses(new Set())}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  activeStatuses.size === 0
                    ? "bg-slate-800 text-white"
                    : "bg-slate-100 text-slate-600"
                }`}
              >
                All
              </button>
              {ALL_STATUSES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggleStatus(code)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    activeStatuses.has(code)
                      ? "bg-slate-800 text-white"
                      : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {code}
                  {showVerifiedCounts && verifiedCountByStatus.has(code)
                    ? ` · ${formatNumber(verifiedCountByStatus.get(code) ?? 0)}`
                    : ""}
                </button>
              ))}
              {listLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
              ) : null}
            </div>

            {/* Select all */}
            <label className="flex items-center gap-2 border-y border-slate-200 py-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAllFiles}
                disabled={files.length === 0}
                className="h-4 w-4 rounded border-slate-300"
              />
              Select all ({formatNumber(files.length)}{" "}
              {files.length === 1 ? "file" : "files"})
            </label>

            {/* File list */}
            <div className="max-h-[400px] overflow-y-auto rounded-lg border border-slate-200">
              {files.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-slate-500">
                  No files with problem URLs.
                </p>
              ) : (
                files.map((file) => {
                  const isExpanded = expanded.has(file.file_id);
                  const hiddenCount =
                    file.problem_url_count - file.sample_urls.length;

                  return (
                    <div
                      key={file.file_id}
                      className="border-b border-slate-100 last:border-b-0"
                    >
                      <div className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50">
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.file_id)}
                          onChange={() => toggleFile(file.file_id)}
                          className="h-4 w-4 shrink-0 rounded border-slate-300"
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className="truncate font-mono text-xs text-slate-800"
                            title={file.filename}
                          >
                            {file.filename}
                          </p>
                          {file.patterns.length > 0 ? (
                            <p className="mt-0.5 truncate text-xs text-slate-400">
                              {file.patterns.length === 1
                                ? "Pattern: "
                                : "Patterns: "}
                              <span className="font-mono text-slate-500">
                                {file.patterns
                                  .slice(
                                    0,
                                    file.patterns.length > MAX_PATTERNS_SHOWN
                                      ? 2
                                      : file.patterns.length
                                  )
                                  .map((pattern) => pattern.template)
                                  .join(" · ")}
                              </span>
                              {file.patterns.length > MAX_PATTERNS_SHOWN ? (
                                <span className="text-slate-400">
                                  {" "}
                                  + {file.patterns.length - 2} more
                                </span>
                              ) : null}
                            </p>
                          ) : null}
                        </div>
                        <span className="shrink-0 text-xs text-slate-500">
                          {formatNumber(file.problem_url_count)} problem{" "}
                          {file.problem_url_count === 1 ? "URL" : "URLs"}
                        </span>
                        <button
                          type="button"
                          onClick={() => toggleExpanded(file.file_id)}
                          className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                          aria-label={isExpanded ? "Collapse" : "Expand"}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                      </div>

                      {isExpanded ? (
                        <div className="space-y-1 bg-slate-50 px-3 pb-2 pl-9">
                          {file.sample_urls.map((sample) => (
                            <div
                              key={sample.url}
                              className="flex items-center gap-2 text-xs"
                            >
                              <span
                                className="min-w-0 flex-1 truncate font-mono text-slate-600"
                                title={sample.url}
                              >
                                {sample.url}
                              </span>
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 font-semibold ${statusBadgeClass(
                                  sample.http_status
                                )}`}
                              >
                                {sample.http_status}
                              </span>
                            </div>
                          ))}
                          {hiddenCount > 0 ? (
                            <p className="pt-0.5 text-xs text-slate-400">
                              + {formatNumber(hiddenCount)} more
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            <p className="text-sm text-slate-600">
              Deleting from {formatNumber(selectedCount)}{" "}
              {selectedCount === 1 ? "file" : "files"}
            </p>

            {error ? <p className="text-sm text-red-500">{error}</p> : null}
          </div>
        ) : null}

        {phase === "progress" ? (
          <div className="space-y-3 py-4">
            {isDone ? (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle2 className="h-5 w-5" />
                Deleted problem URLs from {formatNumber(filesDone)}{" "}
                {filesDone === 1 ? "file" : "files"} (
                {formatNumber(Number(status?.items_changed ?? 0))} URLs removed).
              </div>
            ) : isFailed ? (
              <p className="text-sm text-red-500">
                {status?.error ?? "The deletion failed."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Processing file {formatNumber(Math.min(filesDone + 1, filesTotal))}{" "}
                  of {formatNumber(filesTotal)}…
                </div>
                <Progress value={progressValue} />
              </>
            )}
          </div>
        ) : null}

        <DialogFooter>
          {phase === "list" ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={selectedCount === 0}
                className="gap-1"
              >
                <Trash2 className="h-4 w-4" />
                Delete from {formatNumber(selectedCount)}{" "}
                {selectedCount === 1 ? "file" : "files"}
              </Button>
            </>
          ) : phase === "progress" ? (
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isInFlight}
            >
              {isInFlight ? "Working…" : "Close"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
