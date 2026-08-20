"use client";

import { useMemo } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type {
  TransformDryRunResult,
  TransformSampleResult
} from "@/lib/api";

// The two review panels of the Update Pattern preview step.
//
// They live here rather than in results/page.tsx because that file is already
// ~7,000 lines, and because both are pure presentation over a fetched result —
// nothing here decides anything, it only says what was measured.

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// One real file, transformed into a copy the user can open. The wording is
// deliberate about what did NOT happen: the whole point of this step is that it
// is safe to click, and a user who thinks it edited their session will not use
// it.
export function TransformSamplePanel({
  sample,
  isBuilding,
  isDownloading,
  error,
  onBuild,
  onDownload
}: {
  sample: TransformSampleResult | null;
  isBuilding: boolean;
  isDownloading: boolean;
  error: string | null;
  onBuild: () => void;
  onDownload: () => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-700">
            Step 1 — check a real file
          </p>
          <p className="text-xs text-slate-500">
            Builds a corrected copy of one sitemap file so you can read it. Your
            session is not changed.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isBuilding}
          onClick={onBuild}
          data-testid="build-transform-sample"
        >
          {isBuilding ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Building
            </>
          ) : sample ? (
            "Rebuild sample"
          ) : (
            "Build sample"
          )}
        </Button>
      </div>

      {error ? (
        <p className="break-words text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {sample ? (
        <div className="space-y-3" data-testid="transform-sample-result">
          <div className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs">
            <p className="break-all">
              <span className="text-slate-500">Sample built from: </span>
              <span className="font-mono font-medium text-slate-800">
                {sample.source_file}
              </span>
            </p>
            <p className="text-slate-600">
              {formatNumber(sample.rewritten)} of{" "}
              {formatNumber(sample.total_locs)} URLs in this file would change
              {" · "}
              {formatBytes(sample.bytes)}
            </p>
          </div>

          {sample.samples.length === 0 ? (
            <p className="text-sm text-slate-500">
              Nothing in this file matched — pick a different file or check the
              current structure.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="transform-sample-pairs">
              <li className="text-xs text-slate-500">
                The first {sample.samples.length} change
                {sample.samples.length === 1 ? "" : "s"} in that file:
              </li>
              {sample.samples.map((pair, index) => (
                <li
                  key={index}
                  className="rounded-md border border-slate-200 px-3 py-2 text-xs"
                >
                  <p className="break-all">
                    <span className="text-slate-400">Before: </span>
                    <span className="font-mono">{pair.before}</span>
                  </p>
                  <p className="break-all">
                    <span className="text-emerald-600">After: </span>
                    <span className="font-mono text-emerald-700">
                      {pair.after}
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isDownloading}
            onClick={onDownload}
            data-testid="download-transform-sample"
          >
            {isDownloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download {sample.download_name}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// The full-population measurement.
//
// Every number here is a real count over every file, which is the entire reason
// the panel exists: the before/after list above it — and the preview before that
// — can only ever speak for the URLs they happened to see.
export function TransformDryRunPanel({
  result,
  isRunning,
  progressLabel,
  error,
  required,
  onRun,
  selectedShapes,
  onToggleShape
}: {
  result: TransformDryRunResult | null;
  isRunning: boolean;
  progressLabel: string | null;
  error: string | null;
  // True when the pattern holds more URLs than the preview pool, so the check
  // is not optional.
  required: boolean;
  onRun: () => void;
  // Ticked SOURCE shapes (v1.69). Owned by the parent because the apply request
  // carries them; this panel only renders and toggles.
  selectedShapes: Set<string>;
  onToggleShape: (shape: string) => void;
}) {
  // One row per SOURCE shape, which is what a checkbox selects.
  //
  // The histogram arrives keyed on the source->result PAIR, because one source
  // shape can produce several results (valueShape collapses any letter run to a
  // single "a", so a literal rule can match one member of a shape and miss
  // another). That distinction matters for reading what a rule does, but a
  // checkbox cannot half-select a shape — the filter is applied to the INPUT —
  // so the rows are folded back down here, summing counts and keeping the first
  // example. Folding in the UI rather than server-side keeps the pair detail
  // available for the "→" preview on each row.
  const shapeRows = useMemo(() => {
    const rows = new Map<
      string,
      { beforeShape: string; count: number; before: string; after: string }
    >();

    for (const entry of result?.shapes ?? []) {
      const existing = rows.get(entry.beforeShape);

      if (existing) {
        existing.count += entry.count;
      } else {
        rows.set(entry.beforeShape, {
          beforeShape: entry.beforeShape,
          count: entry.count,
          before: entry.before,
          after: entry.after
        });
      }
    }

    return Array.from(rows.values()).sort((a, b) => b.count - a.count);
  }, [result]);

  const totalCount = shapeRows.reduce((sum, row) => sum + row.count, 0);
  const selectedCount = shapeRows.reduce(
    (sum, row) => (selectedShapes.has(row.beforeShape) ? sum + row.count : sum),
    0
  );

  const anomalies = result
    ? [
        result.clamped_split > 0
          ? {
              key: "clamped",
              text: `${formatNumber(
                result.clamped_split
              )} URL${result.clamped_split === 1 ? " is" : "s are"} shorter than the split position, so the separator lands at the end`,
              example: result.clamped_split_example
            }
          : null,
        result.collisions > 0
          ? {
              key: "collisions",
              text: `${formatNumber(result.collisions)} URL${
                result.collisions === 1 ? "" : "s"
              } would collapse onto a URL another one already produces${
                result.collision_scan_truncated
                  ? " (counted over the first 200,000 results)"
                  : ""
              }`,
              example: result.collision_example
            }
          : null,
        result.double_slash > 0
          ? {
              key: "double-slash",
              text: `${formatNumber(result.double_slash)} result${
                result.double_slash === 1 ? " has" : "s have"
              } an empty path segment (//)`,
              example: null
            }
          : null,
        result.skipped > 0
          ? {
              key: "skipped",
              text: `${formatNumber(result.skipped)} URL${
                result.skipped === 1 ? "" : "s"
              } in this pattern do not match the current structure and would be left unchanged`,
              example: null
            }
          : null
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-700">
            Step 2 — check every URL
          </p>
          <p className="text-xs text-slate-500">
            {required
              ? "This pattern holds more URLs than the preview can see, so this check is required before applying."
              : "Reads every file and reports what the change would produce. Nothing is written."}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isRunning}
          onClick={onRun}
          data-testid="run-transform-dry-run"
        >
          {isRunning ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {progressLabel ?? "Checking"}
            </>
          ) : result ? (
            "Check again"
          ) : (
            "Check all URLs"
          )}
        </Button>
      </div>

      {error ? (
        <p className="break-words text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-3" data-testid="transform-dry-run-result">
          <div className="space-y-1 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <p>
              <span className="font-medium">
                {formatNumber(result.rewritten)}
              </span>{" "}
              of {formatNumber(result.matched)} matching URLs would change,
              across {formatNumber(result.files_scanned)} file
              {result.files_scanned === 1 ? "" : "s"} (
              {formatNumber(result.total_locs)} URLs read).
            </p>
            {result.unchanged > 0 ? (
              <p>
                {formatNumber(result.unchanged)} already match the new structure
                and would be left alone.
              </p>
            ) : null}
            {result.files_skipped > 0 ? (
              <p className="text-amber-700">
                {formatNumber(result.files_skipped)} file
                {result.files_skipped === 1 ? " was" : "s were"} unreadable and
                could not be checked.
              </p>
            ) : null}
          </div>

          {anomalies.length > 0 ? (
            <ul className="space-y-1" data-testid="transform-dry-run-anomalies">
              {anomalies.map((entry) => (
                <li
                  key={entry.key}
                  className="flex gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    {entry.text}
                    {entry.example ? (
                      <>
                        {" — e.g. "}
                        <span className="break-all font-mono">
                          {entry.example}
                        </span>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {shapeRows.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-600">
                Which URLs should this rule change?
              </p>
              {/* CHECKBOXES, NOT A REGEX (v1.69). A pattern usually mixes several
                  value shapes — nsn-parts-12191, nsn-parts-6492, page-1-34 — and
                  one rule rarely serves all of them, which is what the v1.68
                  coverage gate keeps refusing. The gate says a rule is wrong; it
                  cannot say which URLs it is FOR. This can.

                  Shapes are already a canonical form (digit runs to 9xlength,
                  letter runs to a), so selecting them is exact string equality —
                  no pattern to write, nothing to compile, and nothing that can
                  backtrack over millions of URLs. */}
              <p className="text-xs text-slate-500">
                Digits shown as 9, letters as a. Unticked shapes are left exactly
                as they are.
              </p>
              <ul
                className="space-y-1"
                data-testid="transform-dry-run-shapes"
              >
                {shapeRows.map((row) => {
                  const ticked = selectedShapes.has(row.beforeShape);

                  return (
                    <li
                      key={row.beforeShape}
                      className="rounded border border-slate-200 px-2 py-1 text-xs"
                    >
                      <label className="flex flex-wrap items-baseline gap-2">
                        <input
                          type="checkbox"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={ticked}
                          onChange={() => onToggleShape(row.beforeShape)}
                        />
                        <span className="break-all font-mono text-slate-800">
                          {row.beforeShape}
                        </span>
                        <span className="shrink-0 text-slate-500">
                          {formatNumber(row.count)}
                        </span>
                        <span className="w-full break-all pl-6 font-mono text-[11px] text-slate-400">
                          {row.before}
                          <span className="text-slate-300"> → </span>
                          {row.after}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-slate-600">
                {formatNumber(selectedCount)} of {formatNumber(totalCount)} URLs
                selected
                {selectedShapes.size < shapeRows.length
                  ? ` · ${formatNumber(
                      shapeRows.length - selectedShapes.size
                    )} shape${
                      shapeRows.length - selectedShapes.size === 1 ? "" : "s"
                    } left untouched`
                  : ""}
              </p>
              {/* The histogram is capped at 25 shapes. Past that the list is
                  INCOMPLETE, and a class the user could not see must never be
                  rewritten by a selection they could not make — so unlisted
                  shapes count as unticked and the copy says so. */}
              {result.shapes_truncated ? (
                <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  More than 25 shapes — only the first 25 are listed. Shapes not
                  shown here will NOT be changed. Narrow the pattern (or scope by
                  structure above) to see the rest.
                </p>
              ) : null}
              {selectedCount === 0 ? (
                <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-800">
                  Nothing is selected, so applying would change no URLs. Tick at
                  least one shape.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
