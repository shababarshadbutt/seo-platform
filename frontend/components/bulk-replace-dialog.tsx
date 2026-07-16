"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2
} from "lucide-react";

import {
  applyBulkReplace,
  getBulkReplaceStatus,
  previewBulkReplace,
  undoBulkReplace,
  type BulkReplacePreview,
  type BulkReplaceStatus
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
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

export type BulkReplacePattern = { id: string; template: string };

type Mode = "apply" | "undo";

type Props = {
  sessionId: string;
  mode: Mode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patterns: BulkReplacePattern[];
  initialFromPattern?: string | null;
  // For undo mode: the completed operation being reverted.
  currentStatus?: BulkReplaceStatus | null;
  // Fired once when the operation reaches a terminal state, so the page can
  // reload results + refresh the bulk-replace status.
  onFinished?: () => void;
};

function countParams(template: string) {
  return (template.match(/\{param\}/g) ?? []).length;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(seconds: number) {
  if (seconds < 60) {
    return `~${Math.max(1, Math.round(seconds))} seconds`;
  }

  const minutes = Math.round(seconds / 60);

  return `~${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const IN_FLIGHT: BulkReplaceStatus["status"][] = ["PENDING", "RUNNING", "UNDOING"];

export function BulkReplaceDialog({
  sessionId,
  mode,
  open,
  onOpenChange,
  patterns,
  initialFromPattern,
  currentStatus,
  onFinished
}: Props) {
  const [fromPattern, setFromPattern] = useState("");
  const [toPattern, setToPattern] = useState("");
  const [preview, setPreview] = useState<BulkReplacePreview | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"form" | "preview" | "confirm" | "progress">(
    "form"
  );
  const [status, setStatus] = useState<BulkReplaceStatus | null>(null);
  const finishedRef = useRef(false);

  // Reset every time the dialog opens.
  useEffect(() => {
    if (!open) {
      return;
    }

    setFromPattern(initialFromPattern ?? "");
    setToPattern("");
    setPreview(null);
    setSelectedFiles(new Set());
    setIsPreviewing(false);
    setIsSubmitting(false);
    setError("");
    setStatus(null);
    finishedRef.current = false;
    setPhase(mode === "undo" ? "confirm" : "form");
  }, [open, mode, initialFromPattern]);

  // A change to either pattern invalidates a stale preview.
  useEffect(() => {
    setPreview(null);

    if (phase === "preview") {
      setPhase("form");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromPattern, toPattern]);

  const validationError = useMemo(() => {
    if (mode !== "apply") {
      return null;
    }

    if (!fromPattern) {
      return "Select a From pattern.";
    }

    const trimmedTo = toPattern.trim();

    if (!trimmedTo) {
      return "Enter a To pattern.";
    }

    if (trimmedTo === fromPattern) {
      return "To pattern must differ from From pattern.";
    }

    const fromParams = countParams(fromPattern);
    const toParams = countParams(trimmedTo);

    if (fromParams !== toParams) {
      return `From pattern has ${fromParams} params but To pattern has ${toParams} — counts must match`;
    }

    return null;
  }, [mode, fromPattern, toPattern]);

  async function handlePreview() {
    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setIsPreviewing(true);

    try {
      const result = await previewBulkReplace(sessionId, {
        fromPattern,
        toPattern: toPattern.trim()
      });
      setPreview(result);
      // Default to all files selected.
      setSelectedFiles(new Set(result.files.map((file) => file.filename)));
      setPhase("preview");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Unable to preview."
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  function toggleFile(filename: string) {
    setSelectedFiles((current) => {
      const next = new Set(current);

      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }

      return next;
    });
  }

  function toggleAllFiles() {
    setSelectedFiles((current) => {
      if (!preview) {
        return current;
      }

      // All selected → clear; otherwise select all.
      return current.size === preview.files.length
        ? new Set()
        : new Set(preview.files.map((file) => file.filename));
    });
  }

  async function handleApply() {
    if (!preview || selectedFiles.size === 0) {
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      await applyBulkReplace(sessionId, {
        fromPattern,
        toPattern: toPattern.trim(),
        selectedFiles: Array.from(selectedFiles)
      });
      setStatus({
        status: "PENDING",
        files_total: selectedFiles.size,
        files_done: 0
      });
      setPhase("progress");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Unable to apply."
      );
      setIsSubmitting(false);
    }
  }

  async function handleUndo() {
    setIsSubmitting(true);
    setError("");

    try {
      await undoBulkReplace(sessionId);
      setStatus({
        status: "UNDOING",
        files_total: currentStatus?.files_total ?? 0,
        files_done: 0
      });
      setPhase("progress");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Unable to undo."
      );
      setIsSubmitting(false);
    }
  }

  const handleFinished = useCallback(() => {
    if (finishedRef.current) {
      return;
    }

    finishedRef.current = true;
    onFinished?.();
  }, [onFinished]);

  // Poll status every 2s while an operation is in flight.
  useEffect(() => {
    if (phase !== "progress") {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await getBulkReplaceStatus(sessionId);

        if (cancelled) {
          return;
        }

        setStatus(next);

        if (IN_FLIGHT.includes(next.status)) {
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

  const filesTotal = status?.files_total ?? 0;
  const filesDone = status?.files_done ?? 0;
  const progressValue =
    filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0;
  const isInFlight = status ? IN_FLIGHT.includes(status.status) : false;
  const isFailed = status?.status === "FAILED";
  const isDone = status?.status === "COMPLETE" || status?.status === "UNDONE";
  const busy = phase === "progress" && isInFlight;

  const selectedUrlCount = preview
    ? preview.files
        .filter((file) => selectedFiles.has(file.filename))
        .reduce((sum, file) => sum + file.url_count, 0)
    : 0;
  const allFilesSelected =
    preview !== null &&
    preview.files.length > 0 &&
    selectedFiles.size === preview.files.length;

  const title = mode === "undo" ? "Undo Bulk Replace" : "Bulk Pattern Replace";
  const description =
    mode === "undo"
      ? "Restore every sitemap file rewritten by the last bulk replace."
      : "Replace a URL pattern across all sitemap files in this session.";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow closing mid-operation.
        if (busy && !next) {
          return;
        }

        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* APPLY — form */}
        {phase === "form" ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                From pattern
              </label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                value={fromPattern}
                onChange={(event) => setFromPattern(event.target.value)}
              >
                <option value="">Select a pattern…</option>
                {patterns.map((pattern) => (
                  <option key={pattern.id} value={pattern.template}>
                    {pattern.template}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">
                To pattern
              </label>
              <Input
                className="font-mono"
                placeholder="/aviation/manufacturer/{param}"
                value={toPattern}
                onChange={(event) => setToPattern(event.target.value)}
              />
              <p className="text-xs text-slate-500">
                Use {"{param}"} to keep dynamic segments unchanged.
              </p>
            </div>

            {error || validationError ? (
              <p className="text-sm text-destructive">
                {error || validationError}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={Boolean(validationError) || isPreviewing}
                onClick={() => void handlePreview()}
              >
                {isPreviewing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Previewing
                  </>
                ) : (
                  "Preview"
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {/* APPLY — preview */}
        {phase === "preview" && preview ? (
          <div className="space-y-4">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">From:</span>
                <span className="text-slate-900">{fromPattern}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-slate-500">To:</span>
                <span className="text-emerald-700">{toPattern.trim()}</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-lg font-bold text-slate-900">
                  {formatNumber(preview.files_affected)}
                </p>
                <p className="text-xs text-slate-500">files affected</p>
              </div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-lg font-bold text-slate-900">
                  {formatNumber(preview.urls_affected)}
                </p>
                <p className="text-xs text-slate-500">URLs to rewrite</p>
              </div>
              <div className="rounded-md border border-slate-200 p-3">
                <p className="text-lg font-bold text-slate-900">
                  {formatDuration(preview.estimated_seconds)}
                </p>
                <p className="text-xs text-slate-500">estimated</p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Select files to apply to
              </p>
              <div className="overflow-hidden rounded-md border border-slate-200">
                <label className="flex cursor-pointer items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={allFilesSelected}
                    onChange={toggleAllFiles}
                  />
                  Select all ({preview.files.length} file
                  {preview.files.length === 1 ? "" : "s"})
                </label>
                <div className="max-h-[250px] overflow-y-auto">
                  {preview.files.map((file) => (
                    <label
                      key={file.filename}
                      className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300"
                        checked={selectedFiles.has(file.filename)}
                        onChange={() => toggleFile(file.filename)}
                      />
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700"
                        title={file.filename}
                      >
                        {file.filename}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">
                        {formatNumber(file.url_count)} URLs
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="text-xs text-slate-600">
                Selected: {formatNumber(selectedFiles.size)} file
                {selectedFiles.size === 1 ? "" : "s"} •{" "}
                {formatNumber(selectedUrlCount)} URLs will be rewritten
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Sample URLs
              </p>
              {preview.sample_urls.length === 0 ? (
                <p className="text-sm text-slate-500">No sample URLs found.</p>
              ) : (
                preview.sample_urls.map((sample) => (
                  <div
                    key={sample.before}
                    className="rounded-md border border-slate-200 p-2 font-mono text-xs"
                  >
                    <p className="truncate text-slate-500" title={sample.before}>
                      {sample.before}
                    </p>
                    <p
                      className="mt-1 flex items-center gap-1 truncate text-emerald-700"
                      title={sample.after}
                    >
                      <ArrowRight className="h-3 w-3 shrink-0" />
                      {sample.after}
                    </p>
                  </div>
                ))
              )}
            </div>

            <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              This will rewrite {formatNumber(selectedFiles.size)} XML file
              {selectedFiles.size === 1 ? "" : "s"} on disk. A backup is kept for
              undo.
            </p>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => setPhase("form")}
              >
                Back
              </Button>
              <Button
                type="button"
                disabled={isSubmitting || selectedFiles.size === 0}
                onClick={() => void handleApply()}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Starting
                  </>
                ) : (
                  `Apply to ${formatNumber(selectedFiles.size)} file${
                    selectedFiles.size === 1 ? "" : "s"
                  }`
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {/* UNDO — confirm */}
        {phase === "confirm" ? (
          <div className="space-y-4">
            {currentStatus?.to_pattern ? (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-slate-500">Revert:</span>
                  <span className="text-slate-900">
                    {currentStatus.to_pattern}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-slate-500">Back to:</span>
                  <span className="text-emerald-700">
                    {currentStatus.from_pattern}
                  </span>
                </div>
              </div>
            ) : null}

            <p className="text-sm text-slate-600">
              Every rewritten XML file will be restored from its backup and the
              pattern reverted. This runs in the background.
            </p>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={isSubmitting}
                onClick={() => void handleUndo()}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Starting
                  </>
                ) : (
                  "Undo bulk replace"
                )}
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {/* Shared progress / result */}
        {phase === "progress" ? (
          <div className="space-y-4">
            {isDone ? (
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="h-5 w-5" />
                {status?.status === "UNDONE"
                  ? "Bulk replace undone — files restored."
                  : `Bulk replace complete — ${formatNumber(
                      status?.files_done ?? 0
                    )} files rewritten, ${formatNumber(
                      status?.urls_rewritten ?? 0
                    )} URLs updated.`}
              </div>
            ) : isFailed ? (
              <div className="flex items-start gap-2 text-sm font-medium text-destructive">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
                {status?.error ?? "The operation failed."}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {status?.status === "UNDOING"
                    ? "Undoing bulk replace…"
                    : "Applying bulk replace…"}
                </p>
                <Progress value={progressValue} />
                <p className="text-xs text-slate-500">
                  {formatNumber(filesDone)} / {formatNumber(filesTotal)} files
                  {filesTotal > 0 ? ` (${progressValue}%)` : ""}
                </p>
              </div>
            )}

            {!busy ? (
              <DialogFooter>
                <Button type="button" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </DialogFooter>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
