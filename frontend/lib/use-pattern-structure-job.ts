"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  getPatternStructureJobStatus,
  isPatternJobInFlight,
  type PatternStructureJob
} from "./api";

// Tracks the pattern's rename / transform / undo background job.
//
// Two jobs it does, both of which the old synchronous flow could not:
//
//  - Live progress. The work now runs on the maintenance queue, so the only way
//    to know how far it got is to ask. Poll cadence and error handling mirror
//    components/fix-trailing-slashes-dialog.tsx: 2s, and a failed tick RE-ARMS
//    rather than giving up, so a transient blip can't strand the UI showing a
//    frozen bar forever.
//
//  - Reattach. attach() is called when the modal opens, so a page reload during
//    a 4-minute transform picks the run back up instead of orphaning it.

const POLL_INTERVAL_MS = 2000;

export type PatternJobPhase = "idle" | "running" | "complete" | "failed";

export function usePatternStructureJob(
  sessionId: string,
  patternId: string | null
) {
  const [job, setJob] = useState<PatternStructureJob | null>(null);
  const [phase, setPhase] = useState<PatternJobPhase>("idle");
  // Set by attach() so a job that was already finished when the modal opened is
  // treated as history, not as something this session just completed.
  const watchingRef = useRef(false);
  const onSettledRef = useRef<((job: PatternStructureJob) => void) | null>(null);

  const reset = useCallback(() => {
    watchingRef.current = false;
    onSettledRef.current = null;
    setJob(null);
    setPhase("idle");
  }, []);

  // Start watching a job we just kicked off, or one already in flight.
  const watch = useCallback(
    (onSettled?: (job: PatternStructureJob) => void) => {
      watchingRef.current = true;
      onSettledRef.current = onSettled ?? null;
      setPhase("running");
    },
    []
  );

  // Called when the modal opens: adopt a run that is already in progress.
  const attach = useCallback(
    async (onSettled?: (job: PatternStructureJob) => void) => {
      if (!patternId) {
        return null;
      }

      try {
        const existing = await getPatternStructureJobStatus(sessionId, patternId);

        if (isPatternJobInFlight(existing)) {
          setJob(existing);
          watchingRef.current = true;
          onSettledRef.current = onSettled ?? null;
          setPhase("running");
        }

        return existing;
      } catch {
        // A failed probe must not block the modal from opening — the user can
        // still act, and the 409 guard on the routes is the real protection
        // against starting a second run.
        return null;
      }
    },
    [sessionId, patternId]
  );

  useEffect(() => {
    if (phase !== "running" || !patternId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const next = await getPatternStructureJobStatus(sessionId, patternId);

        if (cancelled) {
          return;
        }

        if (next) {
          setJob(next);
        }

        if (!next || isPatternJobInFlight(next)) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }

        setPhase(next.status === "COMPLETE" ? "complete" : "failed");

        if (watchingRef.current) {
          watchingRef.current = false;
          onSettledRef.current?.(next);
        }
      } catch {
        // Re-arm. A dropped poll is not a failed job.
        if (!cancelled) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    };

    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, sessionId, patternId]);

  return { job, phase, watch, attach, reset };
}

// Non-React counterpart for the row-level Undo buttons, which act outside the
// modal and just need the row spinner to stay up until the job settles. Same
// re-arm-on-error rule: a dropped poll is not a failed job.
export async function waitForPatternStructureJob(
  sessionId: string,
  patternId: string
): Promise<PatternStructureJob | null> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    try {
      const job = await getPatternStructureJobStatus(sessionId, patternId);

      if (job && !isPatternJobInFlight(job)) {
        return job;
      }
    } catch {
      // Keep polling.
    }
  }
}

export type PatternJobSkipSummary = {
  total: number;
  missing: string[];
  remote: string[];
  noMatch: string[];
};

export function summarisePatternJobSkips(
  job: PatternStructureJob | null
): PatternJobSkipSummary {
  const warnings = job?.warnings ?? [];

  return {
    total: warnings.length,
    missing: warnings
      .filter((entry) => entry.reason === "missing-on-disk")
      .map((entry) => entry.file),
    remote: warnings
      .filter((entry) => entry.reason === "remote-source")
      .map((entry) => entry.file),
    noMatch: warnings
      .filter((entry) => entry.reason === "no-urls-matched")
      .map((entry) => entry.file)
  };
}
