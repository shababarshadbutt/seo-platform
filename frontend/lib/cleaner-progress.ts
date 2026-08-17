// Pure stage machine for the Sitemap Cleaner run panel. No React, no network —
// this is the only unit-testable piece of the progress work, and every rule that
// keeps the bar honest lives here rather than in the component.
//
// ---- History, because it explains the shape -------------------------------
//
// v1.49: app/cleaner/page.tsx fed SSE frames straight into setProgress(). It
// ignored `event.stage` entirely, and any counterless frame called
// setProgress(null), which made the bar VANISH mid-run. Each stage also ran its
// own 0→100%, so the percentage visibly restarted three times per run.
//
// v1.50 fixed that with a single "current step" plus a monotonic clamp. Correct
// for a strictly sequential pipeline — and wrong the moment v1.51 made upload
// and parse overlap. The old model dropped any frame from a step below the
// current one, so the instant batch 0 finished parsing, BOTH the server upload
// count and the client's own byte progress went dead while 33 batches were still
// uploading. One frozen bar would have been traded for another.
//
// v1.51: each step owns an independent fraction and the overall bar is their
// weighted sum. Monotonicity stops being a clamp bolted on top of a value that
// could otherwise regress and becomes structural — every term only grows, so
// the sum only grows. Two steps can legitimately be in progress at once, which
// is the honest rendering of what the system now does.

import type { CleanerProgressEvent, UploadProgress } from "./api";
import { formatNumber } from "./format";

export type CleanerStep = "upload" | "read" | "clean" | "package";

export const CLEANER_STEPS: readonly { key: CleanerStep; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "read", label: "Read" },
  { key: "clean", label: "Clean" },
  { key: "package", label: "Package" }
];

// Share of the overall bar each step owns. Tuned for the large-upload case where
// the transfer dominates wall clock. Pacing only, never correctness.
const STEP_WEIGHT: Record<CleanerStep, number> = {
  upload: 35,
  read: 25,
  clean: 30,
  package: 10
};

const STEP_KEYS = CLEANER_STEPS.map((step) => step.key);

// Backend stage -> user-facing step. An unknown stage returns null and holds
// whatever the current step is, so a new backend stage degrades gracefully.
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

// Steps that can be running while the step BEFORE them is still running.
//
// Only `read` qualifies: Pass 1 classifies each batch as it arrives, so parsing
// legitimately overlaps uploading. Everything from `clean` onwards runs in the
// terminal phase, which cannot begin until the upload is complete.
const OVERLAPS_PREVIOUS = new Set<CleanerStep>(["read"]);

export function cleanerStepIndex(step: CleanerStep): number {
  return STEP_KEYS.indexOf(step);
}

export type CleanerRunProgress = {
  /** 0-100. Non-decreasing by construction, not by clamping. */
  overallPercent: number;
  /** Per-step completion in [0,1]. Each is individually monotonic. */
  stepFraction: Record<CleanerStep, number>;
  /** The step to highlight: the furthest one that has started but not finished. */
  step: CleanerStep;
  stepIndex: number;
  /** Raw backend stage of the most recent frame, for aria-valuetext and debug. */
  stage: string;
  label: string;
  current: number | null;
  total: number | null;
  determinate: boolean;
  etaSeconds: number | null;
  startedAt: number;
  stepStartedAt: number;
  lastSeq: number;
  rate: number | null;
  rateSampleAt: number;
  rateSampleCurrent: number;
  /**
   * True once the server has reported an upload count. Until then the XHR
   * byte-derived file estimate drives the "N of M" line; after it, the server
   * wins because it counts files actually spooled to disk.
   */
  hasServerUploadCount: boolean;
};

const ETA_MIN_ELAPSED_MS = 5_000;
const ETA_MIN_ITEMS = 10;
const ETA_SUPPRESS_ABOVE_PERCENT = 97;
const RATE_MIN_SAMPLE_MS = 500;
const RATE_SMOOTHING = 0.3;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function emptyFractions(): Record<CleanerStep, number> {
  return { upload: 0, read: 0, clean: 0, package: 0 };
}

/** Weighted sum of the per-step fractions. */
export function overallFromFractions(
  fractions: Record<CleanerStep, number>
): number {
  let total = 0;

  for (const key of STEP_KEYS) {
    total += STEP_WEIGHT[key] * fractions[key];
  }

  return total;
}

/**
 * The step worth highlighting: the furthest one that has started but is not
 * finished. Falls back to the furthest started step (so a run whose last step
 * completed still points at `package` rather than resetting to `upload`).
 */
export function activeStep(fractions: Record<CleanerStep, number>): CleanerStep {
  let started: CleanerStep = "upload";

  for (const key of STEP_KEYS) {
    if (fractions[key] > 0) {
      started = key;
    }

    if (fractions[key] > 0 && fractions[key] < 1) {
      return key;
    }
  }

  return started;
}

export function cleanerProgressInitial(
  fileCount: number,
  now: number = Date.now()
): CleanerRunProgress {
  return {
    overallPercent: 0,
    stepFraction: emptyFractions(),
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

// Plain-language label, built client-side rather than echoed from the backend:
// the engine wording ("Uploaded 412 of 1681 file(s) — 1269 remaining") is
// engine-facing, unlocalised, and duplicates the count line.
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

/** Raise one step's fraction, never lower it. The monotonicity primitive. */
function raise(
  fractions: Record<CleanerStep, number>,
  step: CleanerStep,
  fraction: number
): Record<CleanerStep, number> {
  const next = clamp(fraction, 0, 1);

  if (next <= fractions[step]) {
    return fractions;
  }

  return { ...fractions, [step]: next };
}

/**
 * Fold one backend progress frame into the run state.
 *
 * Invariants:
 *  1. Seq guard — a replayed frame after a reconnect is dropped.
 *  2. No step's fraction ever decreases. (Replaces v1.50's "drop frames from an
 *     earlier step", which was correct only while steps were sequential and
 *     would silently kill the upload display once upload and read overlap.)
 *  3. overallPercent is a sum of non-decreasing terms, so it cannot regress.
 *  4. A counterless frame never blanks the panel: it holds every fraction where
 *     it is and only marks the stage indeterminate.
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
  const lastSeq = typeof event.seq === "number" ? event.seq : state.lastSeq;

  const determinate =
    typeof event.current === "number" &&
    typeof event.total === "number" &&
    event.total > 0;

  const current = determinate ? (event.current as number) : null;
  const total = determinate ? (event.total as number) : null;

  // (2) Only ever raise. A frame for an already-finished step is absorbed
  // harmlessly instead of being dropped, and a late upload frame arriving after
  // a parse frame still advances the upload term.
  let stepFraction = state.stepFraction;

  if (determinate) {
    stepFraction = raise(stepFraction, step, (current as number) / (total as number));
  } else if (stepFraction[step] === 0) {
    // A counterless stage still proves its step has STARTED. Nudge it off zero
    // so the stepper highlights it, without pretending to know how far along.
    stepFraction = raise(stepFraction, step, 0.01);
  }

  // Close out earlier steps — but ONLY where reaching this stage genuinely
  // proves they finished. The backend sends no closing 100% frame per stage, so
  // without this the bar stalls a few percent short for the whole run.
  //
  // The subtlety, and the reason this is not just "complete every earlier step":
  // upload and read OVERLAP by design (Pass 1 classifies each batch as it lands
  // while later batches are still uploading). A `parse` frame therefore proves
  // nothing about the upload, and treating it as proof would slam the upload
  // term to 100% on the very first batch — reintroducing the frozen bar this
  // model exists to prevent.
  //
  // The clean/package stages are different: they run in the terminal phase,
  // which cannot start until `complete` has been called, so reaching them does
  // prove the upload and the reads are done. `start` is the terminal phase's own
  // boundary marker and carries the same proof for the upload.
  for (const key of STEP_KEYS) {
    if (cleanerStepIndex(key) < cleanerStepIndex(step) && !OVERLAPS_PREVIOUS.has(step)) {
      stepFraction = raise(stepFraction, key, 1);
    }
  }

  if (event.stage === "start") {
    stepFraction = raise(stepFraction, "upload", 1);
  }

  // (3) Monotonic by construction.
  const overallPercent = overallFromFractions(stepFraction);
  const nextStep = activeStep(stepFraction);
  const stepChanged = nextStep !== state.step;
  const stepStartedAt = stepChanged ? now : state.stepStartedAt;
  const rateState =
    current === null
      ? {
          rate: state.rate,
          rateSampleAt: state.rateSampleAt,
          rateSampleCurrent: state.rateSampleCurrent
        }
      : updateRate(state, current, now, stepChanged);

  return {
    ...state,
    overallPercent,
    stepFraction,
    step: nextStep,
    stepIndex: cleanerStepIndex(nextStep),
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
 * Fold a client-side XHR upload tick into the run state.
 *
 * This is the half that needs no server at all: `xhr.upload.onprogress` is the
 * browser's own accounting of bytes it has sent. Under batching the caller
 * aggregates across batches, so `percent` is exact rather than estimated —
 * total bytes are known up front from the File objects.
 *
 * Note there is NO early return on "the run has moved past uploading". That
 * guard existed in v1.50 and is exactly what would freeze this display now that
 * Pass 1 overlaps the upload.
 */
export function reduceCleanerUploadProgress(
  state: CleanerRunProgress,
  upload: UploadProgress,
  now: number = Date.now()
): CleanerRunProgress {
  const stepFraction = raise(state.stepFraction, "upload", upload.percent / 100);
  const overallPercent = overallFromFractions(stepFraction);

  // Server counts own the "N of M" line once one has arrived; bytes still drive
  // the bar because they are exact and finer-grained.
  if (state.hasServerUploadCount) {
    const nextStep = activeStep(stepFraction);

    return {
      ...state,
      stepFraction,
      overallPercent,
      step: nextStep,
      stepIndex: cleanerStepIndex(nextStep)
    };
  }

  const current = Math.max(state.current ?? 0, upload.transferredFiles);
  const total = upload.totalFiles > 0 ? upload.totalFiles : state.total;
  const rateState = updateRate(state, current, now, false);
  const nextStep = activeStep(stepFraction);

  return {
    ...state,
    stepFraction,
    overallPercent,
    step: nextStep,
    stepIndex: cleanerStepIndex(nextStep),
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
