import { config } from "../config.js";

// Live Cleaner runs, decoupled from the HTTP request that started them.
//
// The problem this solves: the SFTP clean used to run INSIDE its hijacked
// request. When the client went away nothing noticed — the download loop carried
// on holding one of SFTP_MAX_CONCURRENT_CONNECTIONS for the rest of the run, and
// there was no way to get back to it. Two abandoned runs measurably halved
// throughput for everyone else on the box (found while benchmarking the
// 2,264-file pull), and to the user a dropped stream read as the misleading
// "Processing stream closed before finishing".
//
// So a run is now an object with its own lifecycle. The request SUBSCRIBES to it
// rather than owning it: a disconnect unsubscribes and the run keeps going, and a
// later request can subscribe again and pick up live progress.
//
// SCOPE NOTE — what this is not. Runs live in THIS PROCESS, not in Redis or
// BullMQ. That is deliberate rather than lazy: a finished run's output is held in
// the process-local runCache (a Map of on-disk paths keyed by download token), so
// a run executed in the worker could not be downloaded from the API without
// moving that cache to Redis too. In-process gets the property actually being
// asked for — a run survives its CLIENT — while an API restart still loses it,
// exactly as it always has. Making runs survive a restart is a separate, larger
// change (Redis-backed run cache) and is NOT what the connection-slot leak
// needed.

export type RunFrame = {
  type: string;
  stage?: string;
  current?: number;
  total?: number;
  message?: string;
  [key: string]: unknown;
};

export type RunStatus = "running" | "done" | "error" | "abandoned";

export type LiveRun = {
  runId: string;
  domain: string;
  status: RunStatus;
  startedAt: number;
  // Most recent progress frame. Replayed the instant a client (re)subscribes, so
  // a reconnect shows where the run actually is instead of a blank stream until
  // whatever the next frame happens to be — which on a slow stage can be minutes.
  lastFrame: RunFrame | null;
  // The terminal frame, kept after completion so a client that reconnects AFTER
  // the run finished still gets its result rather than "no such run".
  terminalFrame: RunFrame | null;
  // Heartbeat: refreshed every time a subscriber attaches or the stream ticks.
  lastWatchedAt: number;
  // Aborts the run's own work (the download loop checks it between files).
  controller: AbortController;
  subscribers: Set<(frame: RunFrame) => void>;
};

const runs = new Map<string, LiveRun>();

// How long a finished run's terminal frame is kept so a late reconnect can still
// read the outcome. Short: the download token in that frame has its own 1h TTL
// and is the thing that actually matters for getting the files.
const TERMINAL_RETENTION_MS = 10 * 60 * 1000;

// How often the watchdog looks for unwatched runs. Frequent enough that a slot
// is freed promptly after the grace period, cheap enough to be irrelevant.
const WATCHDOG_INTERVAL_MS = 15 * 1000;

export function createRun(runId: string, domain: string): LiveRun {
  const now = Date.now();
  const run: LiveRun = {
    runId,
    domain,
    status: "running",
    startedAt: now,
    lastFrame: null,
    terminalFrame: null,
    // Starts "watched": the request that created it is about to subscribe, and a
    // run must never be reaped in the window before that happens.
    lastWatchedAt: now,
    controller: new AbortController(),
    subscribers: new Set()
  };

  runs.set(runId, run);

  return run;
}

export function getRun(runId: string): LiveRun | undefined {
  return runs.get(runId);
}

// Refresh the heartbeat. Called on subscribe and on every keepalive tick, so a
// run with a live viewer is never considered abandoned.
export function touchRun(runId: string) {
  const run = runs.get(runId);

  if (run) {
    run.lastWatchedAt = Date.now();
  }
}

// Fan a frame out to every current subscriber and remember it.
//
// A throwing subscriber (a socket that died between the writable check and the
// write) must not abort the publish for the others, or one dead client would
// silence a live one.
export function publishFrame(runId: string, frame: RunFrame) {
  const run = runs.get(runId);

  if (!run) {
    return;
  }

  if (frame.type === "progress") {
    run.lastFrame = frame;
  }

  for (const subscriber of run.subscribers) {
    try {
      subscriber(frame);
    } catch {
      // Ignore; the subscriber's own close handling removes it.
    }
  }
}

// Attach a listener. Returns an unsubscribe function AND the frames the caller
// should replay immediately, so a reconnect is never staring at nothing.
export function subscribeRun(
  runId: string,
  listener: (frame: RunFrame) => void
): { replay: RunFrame[]; unsubscribe: () => void } | null {
  const run = runs.get(runId);

  if (!run) {
    return null;
  }

  run.subscribers.add(listener);
  run.lastWatchedAt = Date.now();

  const replay: RunFrame[] = [];

  if (run.lastFrame) {
    replay.push(run.lastFrame);
  }

  // A run that already finished replays its terminal frame too — the caller then
  // closes the stream, so a late reconnect is a complete, correct exchange.
  if (run.terminalFrame) {
    replay.push(run.terminalFrame);
  }

  return {
    replay,
    unsubscribe: () => {
      run.subscribers.delete(listener);
    }
  };
}

// Mark a run finished and publish its terminal frame. Kept briefly so a client
// that reconnects just after completion still sees the result.
export function finishRun(
  runId: string,
  status: Exclude<RunStatus, "running">,
  frame: RunFrame
) {
  const run = runs.get(runId);

  if (!run) {
    return;
  }

  run.status = status;
  run.terminalFrame = frame;
  publishFrame(runId, frame);

  const timer = setTimeout(() => {
    runs.delete(runId);
  }, TERMINAL_RETENTION_MS);

  timer.unref?.();
}

// Abandonment is decided PURELY by the heartbeat, deliberately not by the
// subscriber count.
//
// This started as `subscribers.size === 0 && heartbeat stale`, and testing found
// the flaw: when a client aborts its fetch, `close` does not always fire on the
// request object, so the subscriber can linger. With a subscriber-count condition
// in the rule, one lingering listener meant the run was never considered
// abandoned — reintroducing exactly the connection-slot leak this is meant to
// stop, and only under the conditions that trigger it.
//
// A heartbeat is the stronger signal because it requires a WRITABLE socket every
// tick, so a listener attached to a dead connection cannot keep a run alive. A
// genuine viewer refreshes it every SSE keepalive (15s), far inside the minimum
// grace period of a minute.
export function isAbandoned(run: LiveRun, now = Date.now()): boolean {
  return (
    run.status === "running" &&
    now - run.lastWatchedAt >= config.cleanerAbandonGraceMs
  );
}

// Abort every running run that nobody has watched for the grace period.
//
// Exported and returning what it did so a test can drive it directly instead of
// waiting on the interval — the whole point is a behaviour that only happens
// after a timeout, and a test that sleeps for the real one is a test nobody runs.
export function reapAbandonedRuns(now = Date.now()): string[] {
  const reaped: string[] = [];

  for (const run of runs.values()) {
    if (!isAbandoned(run, now)) {
      continue;
    }

    run.status = "abandoned";
    // The download loop checks this between files, so the SFTP slot it currently
    // holds is released as soon as the in-flight transfer finishes rather than at
    // the end of the whole batch.
    run.controller.abort();
    reaped.push(run.runId);
  }

  return reaped;
}

let watchdog: NodeJS.Timeout | null = null;

export function startAbandonedRunWatchdog(
  onReap?: (runIds: string[]) => void
): void {
  if (watchdog) {
    return;
  }

  watchdog = setInterval(() => {
    const reaped = reapAbandonedRuns();

    if (reaped.length > 0) {
      onReap?.(reaped);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();
}

export function stopAbandonedRunWatchdog(): void {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
}

// Test seam only.
export function resetRunsForTest(): void {
  runs.clear();
}

export function activeRunCount(): number {
  let count = 0;

  for (const run of runs.values()) {
    if (run.status === "running") {
      count += 1;
    }
  }

  return count;
}
