"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

// A visible countdown that auto-fires one action unless the user picks a
// different one first — modeled on Cleaner's AUTO_MIGRATION_SECONDS handoff
// countdown (frontend/app/cleaner/page.tsx's done-screen auto-navigate), but
// generalized into its own component since nothing reusable like it existed
// before (Cleaner's version is one-off, tied to its own navigation target).
//
// One setTimeout per second, not setInterval, so a cancel between ticks can
// never leave a scheduled auto-action behind — same reasoning Cleaner's
// version documents.
export function TimedPhaseChoice({
  seconds,
  onTimeout,
  title,
  description,
  actions,
  disabled
}: {
  seconds: number;
  onTimeout: () => void;
  title: string;
  description: string;
  actions: { label: string; onClick: () => void }[];
  disabled?: boolean;
}) {
  const [remaining, setRemaining] = useState<number | null>(seconds);
  const firedRef = useRef(false);

  useEffect(() => {
    if (remaining === null || disabled) {
      return;
    }

    if (remaining <= 0) {
      if (!firedRef.current) {
        firedRef.current = true;
        onTimeout();
      }

      return;
    }

    const timer = setTimeout(() => {
      setRemaining((value) => (value === null ? null : value - 1));
    }, 1000);

    return () => clearTimeout(timer);
  }, [remaining, disabled, onTimeout]);

  function pick(action: () => void) {
    setRemaining(null);
    action();
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <div>
        <p className="text-sm font-medium text-slate-900">{title}</p>
        <p className="mt-1 text-sm text-slate-600">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <Button
            key={action.label}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => pick(action.onClick)}
          >
            {action.label}
          </Button>
        ))}
        {remaining !== null ? (
          <span className="text-xs text-slate-500">
            Starting the sampled check automatically in {remaining}s…
          </span>
        ) : null}
      </div>
    </div>
  );
}
