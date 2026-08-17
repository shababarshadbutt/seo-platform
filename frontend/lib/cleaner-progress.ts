// Pure stage machine for the Sitemap Cleaner run panel. No React, no network —
// this is the only unit-testable piece of the progress work, and every rule
// that fixes the reported bug lives here rather than in the component.
//
// What went wrong before (v1.49): app/cleaner/page.tsx fed every SSE frame
// straight into `setProgress(...)`, so
//   - `event.stage` was ignored entirely — the user never learned WHAT was
//     happening, only that something was;
//   - any frame without current/total (dedup, index, zip) called
//     `setProgress(null)`, which made the bar VANISH mid-run; and
//   - each stage's bar ran 0→100% independently, so the percentage visibly
//     restarted three times per run.
//
// The fix is structural, not cosmetic: seven backend stages collapse onto four
// weighted steps laid end to end, so the overall percentage is a function of
// (step, fraction-within-step) and can only ever move forward.

import type { CleanerProgressEvent, UploadProgress } from "./api";
import { formatNumber } from "./format";

export type CleanerStep = "upload" | "read" | "clean" | "package";

export const CLEANER_STEPS: readonly { key: CleanerStep; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "read", label: "Read" },
  { key: "clean", label: "Clean" },
  { key: "package", label: "Package" }
];

// Share of the overall bar each step owns. Tuned for the 1,681-file case where
// the serial multipart spool dominates wall clock. These affect pacing only,
// never correctness — retune once a real `cleaner run timing` line exists.
const STEP_WEIGHT: Record<CleanerStep, number> = {
  upload: 35,
  read: 25,
  clean: 30,
  package: 10
};

// Cumulative offsets, derived so they can never drift out of sync with the
// weights. Strictly increasing, which is what makes the bar monotonic.
const STEP_START: Record<CleanerStep, number> = (() => {
  const starts = {} as Record<CleanerStep, number>;
  let acc = 0;

  for (const { key } of CLEANER_STEPS) {
    starts[key] = acc;
    acc += STEP_WEIGHT[key];
  }

  return starts;
})();

// Backend stage -> user-facing step. Includes the stages added by the backend
// half of this work (unzip/select/report/cleanup) so the frontend does not need
// a second release to understand them; unknown stages fall through to
// `stageToStep` returning null and simply hold the current step.
const STAGE_TO_STEP: Record<string, CleanerStep> = {
  upload: "upload",
  unzip: "upload",
  start: "read",
  parse: "read",
  select: "read",
  dedup: "clean",
  output: "clean",
  index: "package",
  report: "package",
  cleanup: "package",
  zip: "package"
};

function stageToStep(stage: string): CleanerStep | null {
  return STAGE_TO_STEP[stage] ?? null;
}

export function cleanerStepIndex(step: CleanerStep): number {
  return CLEANER_STEPS.findIndex((entry) => entry.key === step);
}

export type CleanerRunProgress = {
  /** 0-100. Guaranteed non-decreasing across the whole run. */
  overallPercent: number;
  step: CleanerStep;
  stepIndex: number;
  /** Raw backend stage, kept for aria-valuetext and debugging. */
  stage: string;
  /** Plain-language line, e.g. "Cleaning 900 of 1,681 files". */
  label: string;
  /** Null while the current stage reports no counters — never rendered then. */
  current: number | null;
  total: number | null;
  /** False for counterless stages: omit the "N of M" line, pulse the bar. */
  determinate: boolean;
  etaSeconds: number | null;
  startedAt: number;
  stepStartedAt: number;
  /** Highest sequence number applied; drops replays after a reconnect. */
  lastSeq: number;
  /** Items/sec EMA within the current step. Reset on every step change. */
  rate: number | null;
  rateSampleAt: number;
  rateSampleCurrent: number;
  /**
   * True once the server has reported an upload count. Until then the XHR
   * byte-derived file estimate drives the counts; after it, the server wins
   * because it counts files actually spooled to disk.
   */
  hasServerUploadCount: boolean;
};

// ETA is suppressed until a step has run long enough to have a believable rate,
// and again at the very end where "1 sec remaining" just flickers.
const ETA_MIN_ELAPSED_MS = 5_000;
const ETA_MIN_ITEMS = 10;
const ETA_SUPPRESS_ABOVE_PERCENT = 97;
const RATE_MIN_SAMPLE_MS = 500;
const RATE_SMOOTHING = 0.3;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function cleanerProgressInitial(
  fileCount: number,
  now: number = Date.now()
): CleanerRunProgress {
  return {
    overallPercent: 0,
    step: "upload",
    stepIndex: 0,
    stage: "upload",
    label: fileCount > 0 ? `Preparing ${formatNumber(fileCount)} files…` : "Preparing…",
    current: 0,
    total: fileCount > 0 ? fileCount : null,
    determinate: fileCount > 0,
    etaSeconds: null,
    startedAt: now,
    stepStartedAt: now,
    lastSeq: -1,
    rate: null,
    rateSampleAt: now,
    rateSampleCurrent: 0,
    hasServerUploadCount: false
  };
}

// Plain-language label. Deliberately NOT `event.message` — the backend wording
// ("Uploaded 412 of 1681 file(s) — 1269 remaining") is engine-facing, unlocalised
// and duplicates the count line. Unknown stages fall back to it so a new backend
// stage degrades to something readable rather than blank.
function buildLabel(
  stage: string,
  current: number | null,
  total: number | null,
  fallback: string
): string {
  const counted = current !== null && total !== null;
  const n = counted ? formatNumber(current) : "";
  const m = counted ? formatNumber(total) : "";

  switch (stage) {
    case "upload":
      return counted ? `Uploading ${n} of ${m} files` : "Uploading files…";
    case "unzip":
      return counted ? `Extracting ${n} of ${m} files from ZIP` : "Extracting ZIP…";
    case "start":
      return total !== null ? `Received ${m} files` : "Received files";
    case "parse":
      return counted ? `Reading sitemaps — ${n} of ${m}` : "Reading sitemaps…";
    case "select":
      return "Choosing which sitemaps to clean…";
    case "dedup":
      return counted ? `Removing duplicate URLs — ${n} of ${m}` : "Removing duplicate URLs…";
    case "output":
      return counted ? `Cleaning ${n} of ${m} files` : "Cleaning files…";
    case "index":
      return "Rebuilding sitemap-index.xml…";
    case "report":
      return "Writing the duplicates report…";
    case "cleanup":
      return "Removing uploaded inputs…";
    case "zip":
      return counted ? `Packaging ZIP — ${n} of ${m}` : "Packaging ZIP…";
    default:
      return fallback || "Working…";
  }
}

// Exponential moving average of items/sec, sampled no faster than every 500ms
// so a burst of frames in the same tick cannot produce an absurd rate.
function updateRate(
  state: CleanerRunProgress,
  current: number,
  now: number,
  stepChanged: boolean
): Pick<CleanerRunProgress, "rate" | "rateSampleAt" | "rateSampleCurrent"> {
  if (stepChanged) {
    return { rate: null, rateSampleAt: now, rateSampleCurrent: current };
  }

  const dtMs = now - state.rateSampleAt;
  const dItems = current - state.rateSampleCurrent;

  if (dtMs < RATE_MIN_SAMPLE_MS || dItems <= 0) {
    return {
      rate: state.rate,
      rateSampleAt: state.rateSampleAt,
      rateSampleCurrent: state.rateSampleCurrent
    };
  }

  const instant = dItems / (dtMs / 1000);

  return {
    rate:
      state.rate === null
        ? instant
        : RATE_SMOOTHING * instant + (1 - RATE_SMOOTHING) * state.rate,
    rateSampleAt: now,
    rateSampleCurrent: current
  };
}

function computeEta(
  rate: number | null,
  current: number | null,
  total: number | null,
  overallPercent: number,
  stepStartedAt: number,
  now: number
): number | null {
  if (
    rate === null ||
    rate <= 0 ||
    current === null ||
    total === null ||
    current < ETA_MIN_ITEMS ||
    now - stepStartedAt < ETA_MIN_ELAPSED_MS ||
    overallPercent >= ETA_SUPPRESS_ABOVE_PERCENT
  ) {
    return null;
  }

  const remaining = total - current;

  return remaining <= 0 ? null : remaining / rate;
}

/**
 * Fold one backend progress frame into the run state.
 *
 * Invariants, in the order they are enforced:
 *  1. Seq guard  — a replayed frame after a reconnect is dropped.
 *  2. Step guard — a frame for an earlier step is dropped (out-of-order SSE).
 *  3. Monotonic  — overallPercent never decreases.
 *  4. A counterless frame never blanks the panel; it holds the bar at the
 *     step's floor and hides the "N of M" line instead of nulling the state.
 */
export function reduceCleanerProgress(
  state: CleanerRunProgress,
  event: Extract<CleanerProgressEvent, { type: "progress" }>,
  now: number = Date.now()
): CleanerRunProgress {
  // (1) Replay guard.
  if (typeof event.seq === "number" && event.seq <= state.lastSeq) {
    return state;
  }

  const mappedStep = stageToStep(event.stage);
  const step = mappedStep ?? state.step;
  const stepIndex = cleanerStepIndex(step);

  // (2) Out-of-order guard. An unmapped stage keeps the current step, so this
  // only ever rejects a genuinely backwards transition.
  if (stepIndex < state.stepIndex) {
    return state;
  }

  const stepChanged = stepIndex > state.stepIndex;
  const lastSeq = typeof event.seq === "number" ? event.seq : state.lastSeq;

  const determinate =
    typeof event.current === "number" &&
    typeof event.total === "number" &&
    event.total > 0;

  // (4) Counters are nulled rather than carried forward on a counterless stage:
  // `determinate` already hides the count line, and holding the previous
  // stage's numbers risks rendering a stale "900 of 1,681" against a stage
  // those numbers never described. The BAR is what must not blank, and it
  // doesn't — it holds STEP_START[step] below.
  const current = determinate ? (event.current as number) : null;
  const total = determinate ? (event.total as number) : null;

  const fraction = determinate
    ? clamp((current as number) / (total as number), 0, 1)
    : 0;

  // (3) Monotonic. STEP_START is strictly increasing, so a later step's floor
  // always exceeds an earlier step's ceiling.
  const overallPercent = Math.max(
    state.overallPercent,
    STEP_START[step] + fraction * STEP_WEIGHT[step]
  );

  const stepStartedAt = stepChanged ? now : state.stepStartedAt;
  const rateState =
    current === null
      ? { rate: state.rate, rateSampleAt: state.rateSampleAt, rateSampleCurrent: state.rateSampleCurrent }
      : updateRate(state, current, now, stepChanged);

  return {
    ...state,
    overallPercent,
    step,
    stepIndex,
    stage: event.stage,
    label: buildLabel(event.stage, current, total, event.message),
    current,
    total,
    determinate,
    stepStartedAt,
    lastSeq,
    ...rateState,
    hasServerUploadCount:
      state.hasServerUploadCount || (event.stage === "upload" && determinate),
    etaSeconds: computeEta(
      rateState.rate,
      current,
      total,
      overallPercent,
      stepStartedAt,
      now
    )
  };
}

/**
 * Fold a client-side XHR upload progress tick into the run state.
 *
 * This is the half that needs no server at all: `xhr.upload.onprogress` is the
 * browser's own view of bytes sent, so it works even while the response is
 * unreadable — which is exactly the window where v1.49 showed a bare spinner.
 *
 * Bytes are authoritative for the PERCENTAGE (they are exact); the file count
 * is only an estimate derived from bytes, so it yields to the server's spooled
 * count as soon as one arrives, and is clamped non-decreasing either way so the
 * displayed count can never tick backwards when the two sources disagree.
 */
export function reduceCleanerUploadProgress(
  state: CleanerRunProgress,
  upload: UploadProgress,
  now: number = Date.now()
): CleanerRunProgress {
  // Once the run has moved past uploading, late XHR ticks are noise.
  if (state.stepIndex > 0) {
    return state;
  }

  const fraction = clamp(upload.percent / 100, 0, 1);
  const overallPercent = Math.max(
    state.overallPercent,
    STEP_START.upload + fraction * STEP_WEIGHT.upload
  );

  if (state.hasServerUploadCount) {
    // Server counts own the "N of M" line; still let bytes drive the bar.
    return { ...state, overallPercent };
  }

  const current = Math.max(state.current ?? 0, upload.transferredFiles);
  const total = upload.totalFiles > 0 ? upload.totalFiles : state.total;
  const rateState = updateRate(state, current, now, false);

  return {
    ...state,
    overallPercent,
    step: "upload",
    stepIndex: 0,
    stage: "upload",
    label: buildLabel("upload", current, total, "Uploading files…"),
    current,
    total,
    determinate: total !== null && total > 0,
    ...rateState,
    etaSeconds: computeEta(
      rateState.rate,
      current,
      total,
      overallPercent,
      state.stepStartedAt,
      now
    )
  };
}
