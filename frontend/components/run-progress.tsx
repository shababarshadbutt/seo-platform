"use client";

import { Check, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatEta, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// Multi-stage run progress: a step strip, ONE overall bar, and a stage line.
//
// Built for the Sitemap Cleaner, where a 1,681-file run moves through seven
// backend stages and previously rendered as a bare "Processing…" spinner. The
// shape is deliberately "one bar, many steps" rather than a bar per stage —
// a per-stage bar is what made the old UI appear to restart from 0% three
// times per run.
//
// This is intentionally NOT a generic <LabelledProgress>. The five other
// <Progress> call sites in this app (download overlay, migration upload, bulk
// replace, trailing slashes, pattern jobs) are poll-driven single-phase
// widgets with genuinely different layouts; covering them all would take ~8
// props and each would still need per-site tweaks. If they ever converge on a
// stage machine, this is the file they should converge into.

export type RunProgressStep = { key: string; label: string };

export type RunProgressNotice = {
  tone: "info" | "warning";
  text: string;
};

export type RunProgressPanelProps = {
  steps: readonly RunProgressStep[];
  /** -1 before anything has started. */
  activeStepIndex: number;
  /** 0-100. The caller guarantees this is monotonic. */
  overallPercent: number;
  stageLabel: string;
  current?: number | null;
  total?: number | null;
  /** False pulses the indicator and hides the "N of M" line. */
  determinate?: boolean;
  etaSeconds?: number | null;
  notice?: RunProgressNotice | null;
  /** Throttled text for the screen-reader live region. */
  announcement?: string;
  onCancel?: () => void;
  cancelling?: boolean;
  className?: string;
};

function StepStrip({
  steps,
  activeStepIndex
}: {
  steps: readonly RunProgressStep[];
  activeStepIndex: number;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((step, index) => {
        const done = index < activeStepIndex;
        const active = index === activeStepIndex;

        return (
          <li key={step.key} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium transition-colors",
                done && "bg-emerald-50 text-emerald-700",
                active && "bg-indigo-50 text-indigo-700",
                !done && !active && "text-slate-400"
              )}
              {...(active ? { "aria-current": "step" as const } : {})}
            >
              {done ? (
                <Check className="h-3 w-3" aria-hidden="true" />
              ) : active ? (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              ) : (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-slate-300"
                  aria-hidden="true"
                />
              )}
              {step.label}
            </span>
            {index < steps.length - 1 ? (
              <span className="text-slate-300" aria-hidden="true">
                —
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function RunProgressPanel({
  steps,
  activeStepIndex,
  overallPercent,
  stageLabel,
  current,
  total,
  determinate = true,
  etaSeconds,
  notice,
  announcement,
  onCancel,
  cancelling = false,
  className
}: RunProgressPanelProps) {
  const percent = Math.round(Math.max(0, Math.min(100, overallPercent)));
  const showCounts =
    determinate &&
    typeof current === "number" &&
    typeof total === "number" &&
    total > 0;
  const remaining = showCounts ? Math.max(0, (total as number) - (current as number)) : 0;

  return (
    // role="status" WITHOUT aria-live: at 1,681 files these counts change many
    // times a second, and an live region on the container would be a screen
    // reader firehose. The throttled sr-only line below is the announcer.
    <div
      role="status"
      className={cn(
        "space-y-3 rounded-lg border border-slate-200 bg-white p-4",
        className
      )}
    >
      <StepStrip steps={steps} activeStepIndex={activeStepIndex} />

      <div className="space-y-1.5">
        <Progress
          value={percent}
          className="h-2.5 bg-slate-100"
          indicatorClassName={cn(
            "bg-indigo-500",
            !determinate && "animate-pulse"
          )}
          aria-label="Overall progress"
          aria-valuetext={`${percent}% — ${stageLabel}`}
        />
        <div className="flex items-baseline justify-between gap-3">
          <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400"
              aria-hidden="true"
            />
            {stageLabel}
          </p>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-600">
            {percent}%
          </span>
        </div>
      </div>

      {/* Fast-moving detail: hidden from the a11y tree, announced on a throttle. */}
      <div
        className="flex items-baseline justify-between gap-3 text-xs text-slate-500"
        aria-hidden="true"
      >
        <span>
          {showCounts
            ? `${formatNumber(current as number)} of ${formatNumber(total as number)}${
                remaining > 0 ? ` · ${formatNumber(remaining)} remaining` : ""
              }`
            : ""}
        </span>
        {typeof etaSeconds === "number" && etaSeconds > 0 ? (
          <span className="shrink-0">~{formatEta(etaSeconds)} left</span>
        ) : null}
      </div>

      {notice ? (
        <p
          role="status"
          className={cn(
            "rounded-md px-3 py-2 text-xs",
            notice.tone === "warning"
              ? "bg-amber-50 text-amber-800"
              : "bg-emerald-50 text-emerald-800"
          )}
        >
          {notice.text}
        </p>
      ) : null}

      {onCancel ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onCancel}
            disabled={cancelling}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement ?? ""}
      </p>
    </div>
  );
}
