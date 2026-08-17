// Deciding what a silent progress stream MEANS.
//
// Extracted as pure functions for the same reason cleaner-progress.ts was: this
// is the only logic in the stall path, and inline in the hook it was untestable
// — which is precisely how v1.52 shipped a watchdog that killed healthy runs.
//
// ---- What went wrong in v1.52 ---------------------------------------------
//
// The first watchdog treated "the stream went quiet" as "the backend died". Five
// separate defects, all of which this module exists to make impossible:
//
//   1. One-shot. It cleared its own interval BEFORE probing and never re-armed,
//      so even the benign outcome left nothing able to settle the run — the bar
//      froze forever, which is the bug the watchdog was added to fix.
//   2. A single failed probe failed the whole run. No retry, no backoff.
//   3. The probe travelled the transport that had just gone silent, so the one
//      check meant to disambiguate failed for the same reason the stream did.
//   4. It claimed to distinguish a 404 from a network error and did not:
//      readJsonResponse throws ApiError for ANY non-2xx, and every ApiError
//      landed in the rejection branch. A proxy 502 read as "out of memory".
//   5. A run that had just FINISHED could be reported as failed, because the
//      probe response carries terminal_frame with the download token and the
//      client only looked at `status`.
//
// The rule this encodes: silence is not evidence. Only a definite answer from
// the server — the run is gone, or the run is finished — is allowed to end a run.

import { ApiError } from "./api";
import type { CleanerDone, CleanerRunStatus } from "./api";

/** The server keepalives every 15s, so this is ~4 missed beats. */
export const STREAM_STALL_MS = 60_000;
export const STALL_CHECK_MS = 10_000;
/** Probe attempts before we are willing to conclude anything at all. */
export const STALL_PROBE_ATTEMPTS = 3;
export const STALL_PROBE_BACKOFF_MS = [1000, 3000, 6000];
/** Stream reconnect attempts before giving up on an otherwise-live run. */
export const STREAM_RECONNECT_ATTEMPTS = 5;

export type StallDecision =
  | { kind: "wait"; reason: string }
  | { kind: "reconnect"; notice: string }
  | { kind: "settle"; done: CleanerDone }
  | { kind: "fail"; message: string };

/**
 * What to do given a successful probe response.
 *
 * Note the ordering: a finished run is checked BEFORE anything else, because the
 * response that says "not running" is the same response that carries the result.
 */
export function decideFromStatus(status: CleanerRunStatus): StallDecision {
  const terminal = status.terminal_frame as
    | {
        type?: string;
        summary?: CleanerDone["summary"];
        download_token?: string;
        zip_filename?: string;
        message?: string;
      }
    | null
    | undefined;

  // The run finished while the stream was down. Recover the result rather than
  // reporting a failure for a run that produced a perfectly good ZIP.
  if (
    terminal &&
    terminal.type === "done" &&
    terminal.summary &&
    terminal.download_token
  ) {
    return {
      kind: "settle",
      done: {
        summary: terminal.summary,
        download_token: terminal.download_token,
        zip_filename: terminal.zip_filename ?? "cleaned-sitemaps.zip"
      }
    };
  }

  if (status.status === "running") {
    // Reachable and working. The stream broke, not the run — so reattach to it
    // instead of ending anything. The server replays its last frame on
    // resubscribe, and resubscribing also refreshes the abandonment heartbeat
    // that would otherwise reap this run after 5 minutes.
    return {
      kind: "reconnect",
      notice: "Reconnecting to the cleaning run…"
    };
  }

  if (status.status === "abandoned") {
    return {
      kind: "fail",
      message:
        "The cleaning run was stopped by the server because it lost contact with this page for too long. Please try again."
    };
  }

  if (terminal?.type === "error" && terminal.message) {
    return { kind: "fail", message: terminal.message };
  }

  return {
    kind: "fail",
    message: "The cleaning run stopped on the server before it finished."
  };
}

/**
 * What to do when the probe itself failed.
 *
 * `attempt` is 1-based. Below the attempt budget the answer is always "wait":
 * the probe shares a transport with the stream that just went quiet, so one
 * failure carries almost no information.
 */
export function decideFromProbeError(
  error: unknown,
  attempt: number
): StallDecision {
  const status = error instanceof ApiError ? error.status : 0;

  // A 404 is the one DEFINITE answer a failed probe can give: the server is
  // reachable and says this run does not exist. No point retrying that.
  if (status === 404) {
    return {
      kind: "fail",
      message:
        "This cleaning run is no longer available on the server — it may have expired, or the server restarted. Please upload again."
    };
  }

  if (attempt < STALL_PROBE_ATTEMPTS) {
    return {
      kind: "wait",
      reason: `probe attempt ${attempt} failed (${describe(status)}), retrying`
    };
  }

  // Budget exhausted. Still avoid asserting a cause we have not established —
  // v1.52 said "may have run out of memory" for what was usually a dropped
  // connection, which sent people to the wrong logs.
  return {
    kind: "fail",
    message:
      status >= 500
        ? "The server is not responding to status checks (server error). The cleaning run may still be running — check the backend logs."
        : "Cannot reach the backend to check on the cleaning run. Check that it is still running, then try again."
  };
}

function describe(status: number): string {
  if (status === 0) {
    return "network or timeout";
  }

  return `HTTP ${status}`;
}

/** Whether a stream that closed without a terminal frame is worth reattaching. */
export function shouldReconnectStream(attempt: number): boolean {
  return attempt < STREAM_RECONNECT_ATTEMPTS;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000);
}
