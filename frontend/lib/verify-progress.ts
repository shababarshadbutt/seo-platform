// Which phase a verification is in, and what to measure its rate against.
//
// A run has three states that all used to render identically, which is the bug
// this exists to fix: a "Check by shape" that was merely QUEUED behind another
// verification showed the same indeterminate bar as one mid-scan and the same as
// one that had hung, for fifteen minutes, with no counts and no ETA.
//
//   "queued"     — PENDING. Nothing is being measured; there is nothing to
//                  divide by, and no ETA can honestly be quoted.
//   "files"      — the enumeration/scan phase. Progress is FILES.
//   "urls"       — the HTTP phase. Progress is URLs. The only rate-limited one.
//   null         — in flight but no denominator published yet.
//
// Extracted from the panel because results/page.tsx and this panel have no test
// harness: the phase choice and the reset key are the parts with real reasoning,
// so they are the parts worth pinning.

export type VerifyPhase = "queued" | "files" | "urls" | null;

export type VerifyProgress = {
  phase: VerifyPhase;
  done: number;
  total: number;
  // Anchor identity for the rate measurement. Carries the phase as well as the
  // job id, so crossing from the file scan into probing RE-MEASURES instead of
  // predicting URL throughput from a file rate — the two differ by orders of
  // magnitude, and reusing the anchor quotes a wildly wrong number at exactly
  // the moment someone starts watching it. Null when there is nothing to
  // measure.
  anchorKey: string | null;
};

export function verifyProgress(
  job: {
    id: string;
    status: string;
    urls_total: number;
    urls_done: number;
    enum_files_total: number | null;
    enum_files_done: number | null;
  } | null
): VerifyProgress {
  if (!job) {
    return { phase: null, done: 0, total: 0, anchorKey: null };
  }

  if (job.status === "PENDING") {
    // Deliberately no denominator: a queued job has made no progress, and a
    // determinate bar at 0% is indistinguishable from a hung one.
    return { phase: "queued", done: 0, total: 0, anchorKey: null };
  }

  // URLs win once they exist. enum_files_* is cleared when the phase ends, but
  // checking urls first means a lingering write cannot drag the display back to
  // the scan phase mid-probe.
  if (job.urls_total > 0) {
    return {
      phase: "urls",
      done: job.urls_done,
      total: job.urls_total,
      anchorKey: `${job.id}:urls`
    };
  }

  if ((job.enum_files_total ?? 0) > 0) {
    return {
      phase: "files",
      done: job.enum_files_done ?? 0,
      total: job.enum_files_total ?? 0,
      anchorKey: `${job.id}:files`
    };
  }

  return { phase: null, done: 0, total: 0, anchorKey: null };
}

// Seconds remaining from the rate a run is ACTUALLY achieving, or null when
// there is not enough evidence yet.
//
// Measured rather than predicted from the configured ceiling, because one URL
// check costs one or two HTTP requests depending on what it returns — so a
// redirect-heavy pattern moves at roughly half the checks/second of a 404-heavy
// one under the same request budget.
export function etaSecondsFrom(input: {
  elapsedSeconds: number;
  completed: number;
  remaining: number;
}): number | null {
  // A couple of polls in, one flush of the progress counter makes the rate look
  // infinite. Needs a real sample before quoting a number.
  if (input.elapsedSeconds < 10 || input.completed <= 0) {
    return null;
  }

  const perSecond = input.completed / input.elapsedSeconds;

  return Math.max(0, Math.round(input.remaining / perSecond));
}
