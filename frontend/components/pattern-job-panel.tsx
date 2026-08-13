"use client";

import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { PatternStructureJob } from "@/lib/api";
import type {
  PatternJobPhase,
  PatternJobSkipSummary
} from "@/lib/use-pattern-structure-job";

// The Update Pattern modal's progress view, shown while a rename/transform/undo
// job is running and kept on screen after it settles if anything was skipped.
//
// The skip breakdown lives HERE rather than only in a toast on purpose: a count
// of files that were not edited is precisely what the user needs in front of
// them when deciding whether to retry, and a toast is gone in four seconds.

const KIND_LABELS: Record<string, string> = {
  "pattern-rename": "Renaming pattern",
  "pattern-transform": "Transforming URL structure",
  "pattern-transform-undo": "Undoing transformation"
};

const SKIP_LABELS: Record<keyof Omit<PatternJobSkipSummary, "total">, string> = {
  missing: "missing from storage",
  remote: "remote URL sitemaps with no local file",
  noMatch: "no URLs matched the current structure"
};

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function SkipList({
  label,
  files
}: {
  label: string;
  files: string[];
}) {
  if (files.length === 0) {
    return null;
  }

  const shown = files.slice(0, 3);
  const rest = files.length - shown.length;

  return (
    <li>
      <span className="font-medium">{formatCount(files.length)}</span> {label}
      <span className="block break-all font-mono text-[11px] text-amber-700">
        {shown.join(", ")}
        {rest > 0 ? ` +${formatCount(rest)} more` : ""}
      </span>
    </li>
  );
}

export function PatternJobPanel({
  job,
  phase,
  skips,
  onDismiss
}: {
  job: PatternStructureJob | null;
  phase: PatternJobPhase;
  skips: PatternJobSkipSummary;
  onDismiss: () => void;
}) {
  const filesTotal = job?.files_total ?? 0;
  const filesDone = job?.files_done ?? 0;
  const percent =
    filesTotal > 0 ? Math.min(100, Math.round((filesDone / filesTotal) * 100)) : 0;
  const urlsChanged = Number(job?.items_changed ?? 0);
  const zeroWork = (job?.result as { zero_work_reason?: string | null } | null)
    ?.zero_work_reason;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        {phase === "running" ? (
          <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
        ) : phase === "failed" ? (
          <XCircle className="h-4 w-4 text-rose-500" />
        ) : skips.total > 0 || zeroWork ? (
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        )}
        {KIND_LABELS[job?.kind ?? ""] ?? "Updating pattern"}
        {phase === "running" ? "…" : ""}
      </div>

      {phase === "running" ? (
        <p className="text-sm text-slate-500">
          This runs in the background — you can close this dialog or reload the
          page and it will keep going.
        </p>
      ) : null}

      <div className="space-y-2">
        <Progress value={percent} />
        <div className="flex justify-between text-xs text-slate-500">
          <span>
            {formatCount(filesDone)} of {formatCount(filesTotal)} file
            {filesTotal === 1 ? "" : "s"}
          </span>
          <span>{formatCount(urlsChanged)} URLs rewritten</span>
        </div>
      </div>

      {zeroWork ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {zeroWork}
        </p>
      ) : null}

      {skips.total > 0 ? (
        <div className="space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-medium">
            {formatCount(skips.total)} file{skips.total === 1 ? "" : "s"} skipped
          </p>
          <ul className="space-y-1 text-xs">
            <SkipList label={SKIP_LABELS.missing} files={skips.missing} />
            <SkipList label={SKIP_LABELS.noMatch} files={skips.noMatch} />
            <SkipList label={SKIP_LABELS.remote} files={skips.remote} />
          </ul>
        </div>
      ) : null}

      {phase === "failed" ? (
        <p className="break-words rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {job?.error ?? "The update failed."}
        </p>
      ) : null}

      {phase !== "running" ? (
        <div className="flex justify-end">
          <Button type="button" onClick={onDismiss}>
            Close
          </Button>
        </div>
      ) : null}
    </div>
  );
}
