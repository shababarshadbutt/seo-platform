"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

import {
  applyTrailingSlashes,
  getTrailingSlashStatus,
  previewTrailingSlashes,
  type MaintenanceJob,
  type TrailingSlashPreview
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

const IN_FLIGHT = ["PENDING", "RUNNING", "UNDOING"];

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

type Phase = "loading" | "confirm" | "progress";

export function FixTrailingSlashesDialog({
  sessionId,
  open,
  onOpenChange,
  onFinished
}: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<TrailingSlashPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<MaintenanceJob | null>(null);
  const [error, setError] = useState("");
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    setPhase("loading");
    setPreview(null);
    setSelected(new Set());
    setStatus(null);
    setError("");
    finishedRef.current = false;

    let cancelled = false;

    void (async () => {
      try {
        const result = await previewTrailingSlashes(sessionId);

        if (cancelled) {
          return;
        }

        setPreview(result);
        setSelected(new Set(result.per_file.map((file) => file.filename)));
        setPhase("confirm");
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to load preview."
          );
          setPhase("confirm");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  const handleFinished = useCallback(() => {
    if (finishedRef.current) {
      return;
    }

    finishedRef.current = true;
    onFinished?.();
  }, [onFinished]);

  useEffect(() => {
    if (phase !== "progress") {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const { job } = await getTrailingSlashStatus(sessionId);

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

  function toggleFile(filename: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }

      return next;
    });
  }

  function toggleAll() {
    setSelected((current) => {
      if (!preview) {
        return current;
      }

      return current.size === preview.per_file.length
        ? new Set()
        : new Set(preview.per_file.map((file) => file.filename));
    });
  }

  async function handleApply() {
    if (!preview || selected.size === 0) {
      return;
    }

    setError("");

    try {
      await applyTrailingSlashes(sessionId, Array.from(selected));
      setStatus({
        id: "",
        kind: "fix-trailing-slashes",
        status: "PENDING",
        files_total: selected.size,
        files_done: 0,
        items_changed: 0,
        error: null
      });
      setPhase("progress");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Unable to apply."
      );
    }
  }

  const filesTotal = status?.files_total ?? 0;
  const filesDone = status?.files_done ?? 0;
  const progressValue =
    filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0;
  const isInFlight = status ? IN_FLIGHT.includes(status.status) : false;
  const isDone = status?.status === "COMPLETE";
  const isFailed = status?.status === "FAILED";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fix Trailing Slashes</DialogTitle>
          <DialogDescription>
            URLs missing a trailing slash will have one added.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Scanning sitemaps…
          </div>
        ) : null}

        {phase === "confirm" && preview ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">Files affected</div>
                <div className="text-lg font-semibold text-slate-800">
                  {formatNumber(preview.files_affected)} files
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs text-slate-500">Total URLs</div>
                <div className="text-lg font-semibold text-slate-800">
                  {formatNumber(preview.urls_to_fix)}
                </div>
              </div>
            </div>

            {preview.per_file.length === 0 ? (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                No sitemap files to fix.
              </p>
            ) : (
              <>
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={selected.size === preview.per_file.length}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Select all ({preview.per_file.length} files)
                  </label>
                  <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
                    {preview.per_file.map((file) => (
                      <label
                        key={file.filename}
                        className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected.has(file.filename)}
                            onChange={() => toggleFile(file.filename)}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          <span className="font-mono text-xs text-slate-700">
                            {file.filename}
                          </span>
                        </span>
                        <span className="text-xs text-slate-500">
                          {formatNumber(file.url_count)} URLs
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {preview.sample_before_after.length > 0 ? (
                  <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                    <div className="font-medium text-slate-600">Sample fixes</div>
                    {preview.sample_before_after.slice(0, 2).map((sample, i) => (
                      <div key={i} className="space-y-0.5 font-mono">
                        <div className="text-slate-400">
                          Before: {sample.before}
                        </div>
                        <div className="text-slate-700">
                          After:&nbsp; {sample.after}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                <p className="flex items-start gap-2 text-xs text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This will rewrite selected XML files on disk.
                </p>
              </>
            )}

            {error ? <p className="text-sm text-red-500">{error}</p> : null}
          </div>
        ) : null}

        {phase === "progress" ? (
          <div className="space-y-3 py-4">
            {isDone ? (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle2 className="h-5 w-5" />
                Fixed {formatNumber(Number(status?.items_changed ?? 0))} URLs in{" "}
                {formatNumber(filesDone)} files.
              </div>
            ) : isFailed ? (
              <p className="text-sm text-red-500">
                {status?.error ?? "The fix failed."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Fixing trailing slashes… {formatNumber(filesDone)} /{" "}
                  {formatNumber(filesTotal)} files
                </div>
                <Progress value={progressValue} />
              </>
            )}
          </div>
        ) : null}

        <DialogFooter>
          {phase === "confirm" &&
          preview &&
          preview.per_file.length > 0 ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleApply}
                disabled={selected.size === 0}
                className="gap-1"
              >
                Fix trailing slashes in {selected.size}{" "}
                {selected.size === 1 ? "file" : "files"}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              variant={isInFlight ? "ghost" : "default"}
              onClick={() => onOpenChange(false)}
              disabled={isInFlight}
            >
              {isInFlight ? "Working…" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
