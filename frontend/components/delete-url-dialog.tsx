"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import {
  deleteSampledUrlFromFiles,
  getSampledUrlFiles,
  type SampledUrlFile
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";

type Props = {
  sessionId: string;
  urlId: string;
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (result: { deleted_from_files: number; urls_removed: number }) => void;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function DeleteUrlDialog({
  sessionId,
  urlId,
  url,
  open,
  onOpenChange,
  onDeleted
}: Props) {
  const [files, setFiles] = useState<SampledUrlFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      return;
    }

    setLoading(true);
    setError("");
    setFiles([]);
    setSelected(new Set());

    let cancelled = false;

    void (async () => {
      try {
        const result = await getSampledUrlFiles(sessionId, urlId);

        if (cancelled) {
          return;
        }

        setFiles(result.files);
        setSelected(new Set(result.files.map((file) => file.sitemap_file_id)));
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to load files."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, sessionId, urlId]);

  function toggle(fileId: string) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }

      return next;
    });
  }

  function toggleAll() {
    setSelected((current) =>
      current.size === files.length
        ? new Set()
        : new Set(files.map((file) => file.sitemap_file_id))
    );
  }

  async function handleDelete() {
    if (selected.size === 0) {
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const result = await deleteSampledUrlFromFiles(
        sessionId,
        urlId,
        Array.from(selected)
      );
      onDeleted(result);
      onOpenChange(false);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Unable to delete."
      );
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete URL from sitemaps</DialogTitle>
        </DialogHeader>

        <p className="break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-700">
          {url}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Finding files…
          </div>
        ) : files.length === 0 ? (
          <p className="py-4 text-sm text-slate-500">
            This URL was not found in any sitemap file on disk.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">This URL appears in:</p>
            <div className="space-y-1 rounded-lg border border-slate-200 p-2">
              {files.map((file) => (
                <label
                  key={file.sitemap_file_id}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(file.sitemap_file_id)}
                      onChange={() => toggle(file.sitemap_file_id)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    <span className="font-mono text-xs text-slate-700">
                      {file.filename}
                    </span>
                  </span>
                  <span className="text-xs text-slate-500">
                    ({formatNumber(file.occurrence_count)}{" "}
                    {file.occurrence_count === 1 ? "occurrence" : "occurrences"})
                  </span>
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={selected.size === files.length && files.length > 0}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-slate-300"
              />
              Select all ({files.length} files)
            </label>
            <p className="text-xs text-slate-500">
              Deleting 1 URL from {selected.size}{" "}
              {selected.size === 1 ? "file" : "files"}.
            </p>
          </div>
        )}

        {error ? <p className="text-sm text-red-500">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={submitting || selected.size === 0 || files.length === 0}
            className="gap-1"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            Delete from selected files
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
