"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Trash2,
  Undo2
} from "lucide-react";

import {
  deleteSessionFiles,
  friendlyApiErrorMessage,
  getSessionFiles,
  restoreSessionFiles,
  type FileDeletionResult,
  type SessionFile,
  type SessionFilesResponse,
  type SitemapFileStatus
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";
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

type StatusFilter = "all" | SitemapFileStatus;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "deleted", label: "Deleted" },
  { value: "empty", label: "Empty" },
  { value: "invalid", label: "Invalid" }
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function StatusBadge({ status }: { status: SitemapFileStatus }) {
  if (status === "active") {
    return <Badge variant="success">● Active</Badge>;
  }

  if (status === "deleted") {
    return <Badge variant="destructive">● Deleted</Badge>;
  }

  if (status === "invalid") {
    return <Badge variant="warning">● Invalid</Badge>;
  }

  return <Badge variant="secondary">● Empty</Badge>;
}

function gscResultLine(result: FileDeletionResult) {
  if (result.gsc_status === "submitted") {
    return {
      icon: "✅",
      text: `${result.filename} — deleted, GSC deletion submitted`
    };
  }

  if (result.gsc_status === "failed") {
    return {
      icon: "⚠️",
      text: `${result.filename} — deleted locally, GSC submission failed (${
        result.gsc_error ?? "unknown error"
      })`
    };
  }

  return {
    icon: "⚠️",
    text: `${result.filename} — deleted locally, GSC submission skipped (no credentials)`
  };
}

export default function SitemapFilesPage({
  params
}: {
  params: { id: string };
}) {
  const [data, setData] = useState<SessionFilesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [gscPropertyUrl, setGscPropertyUrl] = useState("");
  const [gscCredentials, setGscCredentials] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteResults, setDeleteResults] = useState<FileDeletionResult[] | null>(
    null
  );

  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState("");

  const loadFiles = useCallback(async () => {
    try {
      const response = await getSessionFiles(params.id);
      setData(response);
      setError("");
    } catch (loadError) {
      setError(friendlyApiErrorMessage(loadError, "Failed to load files."));
    } finally {
      setIsLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const files = data?.files ?? [];

  const visibleFiles = useMemo(
    () =>
      statusFilter === "all"
        ? files
        : files.filter((file) => file.status === statusFilter),
    [files, statusFilter]
  );

  const selectedFiles = useMemo(
    () => files.filter((file) => selectedIds.has(file.id)),
    [files, selectedIds]
  );

  const deletedCount = useMemo(
    () => files.filter((file) => file.is_deleted).length,
    [files]
  );

  const allVisibleSelected =
    visibleFiles.length > 0 &&
    visibleFiles.every((file) => selectedIds.has(file.id));

  function toggleSelectAll() {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (allVisibleSelected) {
        for (const file of visibleFiles) {
          next.delete(file.id);
        }
      } else {
        for (const file of visibleFiles) {
          next.add(file.id);
        }
      }

      return next;
    });
  }

  function toggleOne(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function openDeleteDialog() {
    if (selectedFiles.length === 0) {
      return;
    }

    setDeleteResults(null);
    setDeleteError("");
    setGscCredentials("");
    setGscPropertyUrl(
      data?.session.gsc_property_url ?? data?.session.base_url ?? ""
    );
    setIsDialogOpen(true);
  }

  async function confirmDelete() {
    setIsDeleting(true);
    setDeleteError("");

    try {
      const response = await deleteSessionFiles(params.id, {
        fileIds: selectedFiles.map((file) => file.id),
        gscPropertyUrl: gscPropertyUrl.trim() || undefined,
        gscCredentials: gscCredentials.trim() || undefined
      });

      setDeleteResults(response.results);
      setSelectedIds(new Set());
      await loadFiles();
    } catch (submitError) {
      setDeleteError(
        friendlyApiErrorMessage(submitError, "Failed to delete files.")
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleRestore(file: SessionFile) {
    setRestoringId(file.id);
    setRestoreError("");

    try {
      await restoreSessionFiles(params.id, [file.id]);
      await loadFiles();
    } catch (restoreErr) {
      setRestoreError(
        friendlyApiErrorMessage(restoreErr, "Failed to restore file.")
      );
    } finally {
      setRestoringId(null);
    }
  }

  const session = data?.session;
  const gscConfigured = session?.gsc_configured ?? false;

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
              Sitemap Files
            </h1>
            {session ? (
              <div className="mt-2 space-y-1 text-sm text-slate-500">
                <p>
                  <span className="font-medium text-slate-600">Session:</span>{" "}
                  {session.name}
                </p>
                <p className="break-all font-mono text-xs">
                  <span className="font-sans font-medium text-slate-600">
                    Base URL:
                  </span>{" "}
                  {session.base_url}
                </p>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
            <Button asChild variant="outline">
              <Link href={`/sessions/${params.id}/results`}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Results
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {restoreError ? (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {restoreError}
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading files…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    disabled={visibleFiles.length === 0}
                  />
                  Select all ({formatNumber(visibleFiles.length)}{" "}
                  {visibleFiles.length === 1 ? "file" : "files"})
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  Status filter:
                  <select
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    value={statusFilter}
                    onChange={(event) =>
                      setStatusFilter(event.target.value as StatusFilter)
                    }
                  >
                    {STATUS_FILTERS.map((filter) => (
                      <option key={filter.value} value={filter.value}>
                        {filter.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={selectedFiles.length === 0}
                onClick={openDeleteDialog}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Selected
                {selectedFiles.length > 0
                  ? ` (${formatNumber(selectedFiles.length)})`
                  : ""}
              </Button>
            </div>

            {/* Files list */}
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              {visibleFiles.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-slate-500">
                  No files match this filter.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {visibleFiles.map((file) => (
                    <li
                      key={file.id}
                      className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        checked={selectedIds.has(file.id)}
                        onChange={() => toggleOne(file.id)}
                        aria-label={`Select ${file.filename}`}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-slate-800">
                        {file.filename}
                      </span>
                      <span className="w-28 text-right text-sm tabular-nums text-slate-500">
                        {formatNumber(file.total_urls)} URLs
                      </span>
                      <span className="flex w-40 items-center justify-end gap-2">
                        <StatusBadge status={file.status} />
                        {file.is_index ? (
                          <Badge variant="outline">index</Badge>
                        ) : null}
                      </span>
                      <span className="w-24 text-right">
                        {file.is_deleted ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={restoringId === file.id}
                            onClick={() => void handleRestore(file)}
                          >
                            {restoringId === file.id ? (
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            ) : (
                              <Undo2 className="mr-1 h-3 w-3" />
                            )}
                            Restore
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {deletedCount > 0 ? (
              <p className="text-xs text-slate-500">
                {formatNumber(deletedCount)} of {formatNumber(files.length)}{" "}
                files are marked deleted and excluded from downloads.
              </p>
            ) : null}
          </div>
        )}
      </section>

      <Dialog
        open={isDialogOpen}
        onOpenChange={(open) => {
          if (!isDeleting) {
            setIsDialogOpen(open);
          }
        }}
      >
        <DialogContent>
          {deleteResults ? (
            <>
              <DialogHeader>
                <DialogTitle>Deletion complete</DialogTitle>
                <DialogDescription>
                  Results for {deleteResults.length}{" "}
                  {deleteResults.length === 1 ? "file" : "files"}.
                </DialogDescription>
              </DialogHeader>
              <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                {deleteResults.map((result) => {
                  const line = gscResultLine(result);

                  return (
                    <li
                      key={result.file_id}
                      className="flex items-start gap-2 break-all"
                    >
                      <span aria-hidden>{line.icon}</span>
                      <span className="text-slate-700">{line.text}</span>
                    </li>
                  );
                })}
              </ul>
              <DialogFooter>
                <Button
                  type="button"
                  onClick={() => setIsDialogOpen(false)}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  Delete {selectedFiles.length}{" "}
                  {selectedFiles.length === 1 ? "sitemap" : "sitemaps"}?
                </DialogTitle>
                <DialogDescription>This will:</DialogDescription>
              </DialogHeader>
              <ul className="space-y-1 text-sm text-slate-600">
                <li>✓ Mark these sitemaps as deleted in this session</li>
                <li>✓ Remove them from future downloads</li>
                <li>✓ Submit a deletion request to Google Search Console</li>
              </ul>

              <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">
                  Google Search Console credentials are required to submit the
                  deletion. Without them, files are deleted locally only.
                </p>
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-600">
                    GSC Property URL
                  </span>
                  <Input
                    value={gscPropertyUrl}
                    onChange={(event) => setGscPropertyUrl(event.target.value)}
                    placeholder="https://www.example.com"
                  />
                </label>
                {gscConfigured ? (
                  <p className="flex items-center gap-1 text-xs text-emerald-700">
                    <CheckCircle2 className="h-3 w-3" />
                    Credentials stored for this session. Leave blank to reuse
                    them, or paste a new key below to replace.
                  </p>
                ) : null}
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-slate-600">
                    Service account JSON key{" "}
                    {gscConfigured ? "(optional)" : ""}
                  </span>
                  <textarea
                    className="h-24 w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-700 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    value={gscCredentials}
                    onChange={(event) => setGscCredentials(event.target.value)}
                    placeholder='{ "type": "service_account", ... }'
                  />
                </label>
              </div>

              {deleteError ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{deleteError}</span>
                </div>
              ) : null}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isDeleting}
                  onClick={() => setIsDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isDeleting}
                  onClick={() => void confirmDelete()}
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Deleting {selectedFiles.length} files and submitting to
                      GSC…
                    </>
                  ) : (
                    "Delete & Submit to GSC"
                  )}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
