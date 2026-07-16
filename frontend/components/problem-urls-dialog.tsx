"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent
} from "react";
import { CheckCircle2, Loader2, Trash2 } from "lucide-react";

import {
  deleteProblemUrls,
  getDeleteProblemUrlsStatus,
  getProblemUrls,
  type MaintenanceJob,
  type ProblemUrl
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
const ROW_HEIGHT = 40;
const VIEWPORT_HEIGHT = 400;
const VIRTUALIZE_THRESHOLD = 100;
const OVERSCAN = 8;

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function statusBadgeClass(status: number | null) {
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
  const [urls, setUrls] = useState<ProblemUrl[]>([]);
  const [activeStatuses, setActiveStatuses] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<MaintenanceJob | null>(null);
  const [error, setError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    setPhase("loading");
    setUrls([]);
    setActiveStatuses(new Set());
    setSelected(new Set());
    setStatus(null);
    setError("");
    setScrollTop(0);
    finishedRef.current = false;

    let cancelled = false;

    void (async () => {
      try {
        const { problem_urls } = await getProblemUrls(sessionId);

        if (cancelled) {
          return;
        }

        setUrls(problem_urls);
        setSelected(new Set(problem_urls.map((row) => row.id)));
        setPhase("list");
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to load URLs."
          );
          setPhase("list");
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

  const visibleUrls = useMemo(() => {
    if (activeStatuses.size === 0) {
      return urls;
    }

    return urls.filter(
      (row) => row.http_status != null && activeStatuses.has(row.http_status)
    );
  }, [urls, activeStatuses]);

  const selectedVisibleCount = useMemo(
    () => visibleUrls.filter((row) => selected.has(row.id)).length,
    [visibleUrls, selected]
  );

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

  function toggleRow(id: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = visibleUrls.every((row) => next.has(row.id));

      for (const row of visibleUrls) {
        if (allSelected) {
          next.delete(row.id);
        } else {
          next.add(row.id);
        }
      }

      return next;
    });
  }

  async function handleDelete() {
    const ids = visibleUrls
      .filter((row) => selected.has(row.id))
      .map((row) => row.id);

    if (ids.length === 0) {
      return;
    }

    setError("");

    try {
      await deleteProblemUrls(sessionId, ids);
      setStatus({
        id: "",
        kind: "delete-problem-urls",
        status: "PENDING",
        files_total: 0,
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

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  // Virtualize only when the list is long enough to matter.
  const virtualize = visibleUrls.length > VIRTUALIZE_THRESHOLD;
  const startIndex = virtualize
    ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    : 0;
  const endIndex = virtualize
    ? Math.min(
        visibleUrls.length,
        Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN
      )
    : visibleUrls.length;
  const renderedRows = visibleUrls.slice(startIndex, endIndex);

  const filesTotal = status?.files_total ?? 0;
  const filesDone = status?.files_done ?? 0;
  const progressValue =
    filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0;
  const isInFlight = status ? IN_FLIGHT.includes(status.status) : false;
  const isDone = status?.status === "COMPLETE";
  const isFailed = status?.status === "FAILED";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete Problem URLs from Sitemaps</DialogTitle>
          <DialogDescription>
            URLs returning redirects or 404 errors across all patterns. Select
            which ones to remove from your sitemap files.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading problem URLs…
          </div>
        ) : null}

        {phase === "list" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
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
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2 border-y border-slate-200 py-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={
                  visibleUrls.length > 0 &&
                  selectedVisibleCount === visibleUrls.length
                }
                onChange={toggleAllVisible}
                className="h-4 w-4 rounded border-slate-300"
              />
              Select all ({formatNumber(visibleUrls.length)} URLs)
            </label>

            <div
              onScroll={onScroll}
              className="overflow-y-auto rounded-lg border border-slate-200"
              style={{ maxHeight: VIEWPORT_HEIGHT }}
            >
              {visibleUrls.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-slate-500">
                  No matching URLs.
                </p>
              ) : (
                <div
                  style={
                    virtualize
                      ? { height: visibleUrls.length * ROW_HEIGHT, position: "relative" }
                      : undefined
                  }
                >
                  <div
                    style={
                      virtualize
                        ? {
                            position: "absolute",
                            top: startIndex * ROW_HEIGHT,
                            left: 0,
                            right: 0
                          }
                        : undefined
                    }
                  >
                    {renderedRows.map((row) => (
                      <label
                        key={row.id}
                        className="flex items-center gap-2 px-3 text-sm hover:bg-slate-50"
                        style={{ height: ROW_HEIGHT }}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggleRow(row.id)}
                          className="h-4 w-4 shrink-0 rounded border-slate-300"
                        />
                        <span className="flex-1 truncate font-mono text-xs text-slate-700">
                          {row.url}
                        </span>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${statusBadgeClass(
                            row.http_status
                          )}`}
                        >
                          {row.http_status ?? "—"}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <p className="text-sm text-slate-600">
              {formatNumber(selectedVisibleCount)} of{" "}
              {formatNumber(visibleUrls.length)} selected
            </p>

            {error ? <p className="text-sm text-red-500">{error}</p> : null}
          </div>
        ) : null}

        {phase === "progress" ? (
          <div className="space-y-3 py-4">
            {isDone ? (
              <div className="flex items-center gap-2 text-sm text-emerald-600">
                <CheckCircle2 className="h-5 w-5" />
                Removed {formatNumber(Number(status?.items_changed ?? 0))} URLs
                from {formatNumber(filesDone)} sitemap files.
              </div>
            ) : isFailed ? (
              <p className="text-sm text-red-500">
                {status?.error ?? "The deletion failed."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Deleting URLs… {formatNumber(filesDone)} /{" "}
                  {formatNumber(filesTotal)} files updated
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
                disabled={selectedVisibleCount === 0}
                className="gap-1"
              >
                <Trash2 className="h-4 w-4" />
                Delete {formatNumber(selectedVisibleCount)} URLs from sitemaps
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
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
