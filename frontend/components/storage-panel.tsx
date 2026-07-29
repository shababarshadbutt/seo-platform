"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";

import {
  cleanupSessionUploads,
  friendlyApiErrorMessage,
  getStorageOverview,
  type StorageOverview,
  type StorageSession
} from "@/lib/api";
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

// Storage reclamation for sessions whose post-publish prompt was dismissed or
// never seen.
//
// Sessions for large client sites reach ~10 GB and the uploads volume is 500 GB
// shared by 10+ concurrent users, so "come back later and clean up" has to be a
// real workflow rather than relying on catching a dialog at the right moment. The
// delayed safety-net job still exists as a backstop for abandoned sessions, but
// it is deliberately slow (48h by default) — this is the deliberate path.
//
// Deletes ONLY file blobs. The session row, its patterns, its reports and its fix
// history all stay, which is why a cleaned session still appears here with 0 B
// rather than disappearing.

function formatBytes(bytes: number) {
  if (bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** exponent;

  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${
    units[exponent]
  }`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function StoragePanel() {
  const [overview, setOverview] = useState<StorageOverview | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isFreeing, setIsFreeing] = useState(false);
  const [freeError, setFreeError] = useState("");
  const [lastFreedBytes, setLastFreedBytes] = useState<number | null>(null);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoading(true);
    }

    setError("");

    try {
      const next = await getStorageOverview();

      setOverview(next);
      // Drop selections for sessions that no longer have anything to free, so a
      // stale tick can't send a pointless request.
      setSelected((current) => {
        const stillReclaimable = new Set(
          next.sessions
            .filter((session) => session.disk_bytes > 0)
            .map((session) => session.id)
        );

        // Array.from rather than spread: this project's tsconfig target predates
        // downlevel iteration of a Set.
        return new Set(
          Array.from(current).filter((id) => stillReclaimable.has(id))
        );
      });
    } catch (nextError) {
      setError(
        friendlyApiErrorMessage(nextError, "Could not load storage usage.")
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reclaimable = useMemo(
    () => (overview?.sessions ?? []).filter((session) => session.disk_bytes > 0),
    [overview]
  );

  const selectedSessions = useMemo(
    () => reclaimable.filter((session) => selected.has(session.id)),
    [reclaimable, selected]
  );

  const selectedBytes = selectedSessions.reduce(
    (sum, session) => sum + session.disk_bytes,
    0
  );

  function toggle(sessionId: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }

      return next;
    });
  }

  async function handleConfirmFree() {
    if (isFreeing || selectedSessions.length === 0) {
      return;
    }

    setIsFreeing(true);
    setFreeError("");

    let freed = 0;
    const failures: string[] = [];

    // Sequential, not parallel: each call scans the uploads directory, and a
    // bulk clean of a dozen sessions running concurrently would thrash a volume
    // that other users are actively reading from.
    for (const session of selectedSessions) {
      try {
        const result = await cleanupSessionUploads(session.id);

        freed += result.freed_bytes;
      } catch (nextError) {
        failures.push(
          `${session.name}: ${friendlyApiErrorMessage(nextError, "failed")}`
        );
      }
    }

    setIsFreeing(false);
    setLastFreedBytes(freed);

    if (failures.length > 0) {
      // Partial success is reported as-is rather than as a flat failure — the
      // bytes that were freed really were freed.
      setFreeError(
        `Freed ${formatBytes(freed)}. ${failures.length} session${
          failures.length === 1 ? "" : "s"
        } could not be cleaned: ${failures.join("; ")}`
      );
    } else {
      setConfirmOpen(false);
    }

    await load({ silent: true });
  }

  return (
    <>
      <Card data-testid="storage-panel">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold text-slate-700">
              <HardDrive className="h-4 w-4 text-slate-500" />
              Local sitemap storage
            </CardTitle>
            <CardDescription>
              {overview
                ? `${formatBytes(
                    overview.total_disk_bytes
                  )} in use across ${formatNumber(
                    reclaimable.length
                  )} session${reclaimable.length === 1 ? "" : "s"}. Deleting a session's files keeps its reports and history, but disables Undo and needs a fresh SFTP pull to publish again.`
                : "Disk used by uploaded and pulled sitemap files."}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={isLoading}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {isLoading && !overview ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading storage usage
            </div>
          ) : null}

          {overview && reclaimable.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="storage-empty">
              No session has sitemap files on disk right now — nothing to reclaim.
            </p>
          ) : null}

          {reclaimable.length > 0 ? (
            <>
              <div className="overflow-x-auto rounded-md border border-slate-200">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-semibold uppercase text-slate-500">
                      <th className="px-3 py-2">
                        <span className="sr-only">Select</span>
                      </th>
                      <th className="px-3 py-2">Session</th>
                      <th className="px-3 py-2">Domain</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Files</th>
                      <th className="px-3 py-2 text-right">On disk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reclaimable.map((session: StorageSession) => (
                      <tr
                        key={session.id}
                        className="border-b border-slate-100 last:border-b-0"
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Select ${session.name}`}
                            data-testid={`storage-select-${session.id}`}
                            checked={selected.has(session.id)}
                            onChange={() => toggle(session.id)}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                        </td>
                        <td className="max-w-[240px] truncate px-3 py-2 text-slate-700">
                          {session.name}
                        </td>
                        <td className="max-w-[200px] truncate px-3 py-2 font-mono text-xs text-slate-500">
                          {session.sftp_domain ?? session.base_url}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-500">
                          {session.status}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600">
                          {formatNumber(session.disk_file_count)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-slate-700">
                          {formatBytes(session.disk_bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500">
                  {overview
                    ? `Files of a completed session are removed automatically after ${formatNumber(
                        overview.safety_net_hours
                      )} hours as a backstop for abandoned sessions.`
                    : ""}
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={selectedSessions.length === 0}
                  onClick={() => {
                    setFreeError("");
                    setLastFreedBytes(null);
                    setConfirmOpen(true);
                  }}
                  data-testid="storage-free-selected"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {selectedSessions.length === 0
                    ? "Free selected"
                    : `Free ${formatBytes(selectedBytes)} from ${
                        selectedSessions.length
                      } session${selectedSessions.length === 1 ? "" : "s"}`}
                </Button>
              </div>

              {lastFreedBytes !== null && !freeError ? (
                <p
                  className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                  data-testid="storage-freed-result"
                >
                  Freed {formatBytes(lastFreedBytes)}. Reports and history kept.
                </p>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !isFreeing) {
            setConfirmOpen(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Delete sitemap files for {selectedSessions.length} session
              {selectedSessions.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Frees {formatBytes(selectedBytes)}. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <ul className="max-h-[160px] space-y-1 overflow-y-auto rounded-md border border-slate-200 px-3 py-2">
              {selectedSessions.map((session) => (
                <li
                  key={session.id}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="truncate text-slate-700">{session.name}</span>
                  <span className="shrink-0 font-mono text-slate-500">
                    {formatBytes(session.disk_bytes)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
              <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">
                <li>
                  <span className="font-semibold">Undo stops working</span> for
                  these sessions.
                </li>
                <li>
                  Publishing or downloading them again needs a{" "}
                  <span className="font-semibold">fresh SFTP pull</span>.
                </li>
                <li>
                  Reports, patterns and fix history are{" "}
                  <span className="font-semibold">kept</span>.
                </li>
              </ul>
            </div>
          </div>

          {freeError ? (
            <p
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
              role="alert"
            >
              {freeError}
            </p>
          ) : null}

          <DialogFooter>
            {/* Keeping is the safe default and gets the primary button. */}
            <Button
              type="button"
              disabled={isFreeing}
              onClick={() => setConfirmOpen(false)}
            >
              Keep files
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isFreeing}
              onClick={() => void handleConfirmFree()}
              data-testid="storage-confirm-free"
            >
              {isFreeing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Freeing
                </>
              ) : (
                `Delete files, free ${formatBytes(selectedBytes)}`
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
