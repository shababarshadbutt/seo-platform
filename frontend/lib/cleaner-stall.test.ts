import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "./api.js";
import {
  decideFromProbeError,
  decideFromStatus,
  reconnectDelayMs,
  shouldReconnectStream,
  STALL_PROBE_ATTEMPTS,
  STREAM_RECONNECT_ATTEMPTS
} from "./cleaner-stall.js";
import type { CleanerRunStatus } from "./api.js";

// These are the exact cases v1.52 got wrong. Every one of them ended a healthy
// run, or reported a finished run as failed, on a real 1,603-file upload.

function status(over: Partial<CleanerRunStatus> = {}): CleanerRunStatus {
  return {
    run_id: "r1",
    server_epoch: "e1",
    status: "running",
    phase: "cleaning",
    expected_files: 1603,
    received_files: 1603,
    classified_files: 1603,
    batch_size: 50,
    batch_count: 33,
    missing_batches: [],
    partial_batches: [],
    terminal_frame: null,
    ...over
  };
}

test("ONE failed probe does not end the run", () => {
  // v1.52's central bug: a single dropped request killed a 20-minute run, and
  // the probe shares a transport with the stream that had just gone quiet — so
  // one failure carries almost no information.
  const decision = decideFromProbeError(new TypeError("Failed to fetch"), 1);

  assert.equal(decision.kind, "wait");
});

test("the run only fails once the probe budget is exhausted", () => {
  for (let attempt = 1; attempt < STALL_PROBE_ATTEMPTS; attempt += 1) {
    assert.equal(
      decideFromProbeError(new TypeError("Failed to fetch"), attempt).kind,
      "wait",
      `attempt ${attempt} must not fail the run`
    );
  }

  const final = decideFromProbeError(
    new TypeError("Failed to fetch"),
    STALL_PROBE_ATTEMPTS
  );

  assert.equal(final.kind, "fail");
});

test("a 404 is a definite answer and fails immediately", () => {
  // The one case where a FAILED probe is informative: the server is reachable
  // and says the run does not exist. Retrying that is pointless.
  const decision = decideFromProbeError(
    new ApiError("not found", 404, null),
    1
  );

  assert.equal(decision.kind, "fail");
  assert.match(decision.message, /no longer available/i);
});

test("a 404 and a network error produce different messages", () => {
  // v1.52's comment claimed this distinction existed. It did not:
  // readJsonResponse throws ApiError for ANY non-2xx and every ApiError landed
  // in the same rejection branch, so a proxy 502 read as "out of memory".
  const gone = decideFromProbeError(new ApiError("gone", 404, null), 1);
  const network = decideFromProbeError(
    new TypeError("Failed to fetch"),
    STALL_PROBE_ATTEMPTS
  );
  const serverError = decideFromProbeError(
    new ApiError("bad gateway", 502, null),
    STALL_PROBE_ATTEMPTS
  );

  assert.notEqual(gone.kind === "fail" && gone.message, network.kind === "fail" && network.message);
  assert.notEqual(
    network.kind === "fail" && network.message,
    serverError.kind === "fail" && serverError.message
  );
});

test("no message blames memory without evidence", () => {
  // v1.52 asserted "It may have run out of memory" for what was usually a
  // dropped connection, sending people to the wrong logs.
  const messages = [
    decideFromProbeError(new TypeError("x"), STALL_PROBE_ATTEMPTS),
    decideFromProbeError(new ApiError("x", 502, null), STALL_PROBE_ATTEMPTS),
    decideFromProbeError(new ApiError("x", 404, null), 1),
    decideFromStatus(status({ status: "abandoned" })),
    decideFromStatus(status({ status: "error" }))
  ]
    .filter((d) => d.kind === "fail")
    .map((d) => (d as { message: string }).message);

  assert.ok(messages.length >= 4);

  for (const message of messages) {
    assert.doesNotMatch(message, /out of memory/i, `still guesses at memory: ${message}`);
  }
});

test("a still-running run reconnects instead of ending", () => {
  const decision = decideFromStatus(status({ status: "running" }));

  assert.equal(decision.kind, "reconnect");
});

test("a run that FINISHED while the stream was down settles successfully", () => {
  // The worst v1.52 behaviour: the probe response carries terminal_frame with
  // the download token, and the client read only `status`, discarded it, and
  // reported failure for a run that had produced a perfectly good ZIP.
  const decision = decideFromStatus(
    status({
      status: "done",
      terminal_frame: {
        type: "done",
        summary: { duplicates_removed: 12 } as never,
        download_token: "tok-xyz",
        zip_filename: "cleaned-sitemaps-2026-08-17.zip"
      }
    })
  );

  assert.equal(decision.kind, "settle");
  assert.equal(
    decision.kind === "settle" ? decision.done.download_token : null,
    "tok-xyz"
  );
  assert.equal(
    decision.kind === "settle" ? decision.done.zip_filename : null,
    "cleaned-sitemaps-2026-08-17.zip"
  );
});

test("a finished run is recovered even if `status` says done before the frame is read", () => {
  // Ordering matters: the terminal frame is checked BEFORE the status verdict,
  // because the response that says "not running" is the one carrying the result.
  const decision = decideFromStatus(
    status({
      status: "error",
      terminal_frame: {
        type: "done",
        summary: {} as never,
        download_token: "tok-1",
        zip_filename: "z.zip"
      }
    })
  );

  assert.equal(decision.kind, "settle");
});

test("a server-side error frame is surfaced verbatim, not replaced with a guess", () => {
  const decision = decideFromStatus(
    status({
      status: "error",
      terminal_frame: {
        type: "error",
        message: "Server storage is full. Free up disk space and try again."
      }
    })
  );

  assert.equal(decision.kind, "fail");
  assert.match(
    decision.kind === "fail" ? decision.message : "",
    /storage is full/i
  );
});

test("an abandoned run explains WHY it was stopped", () => {
  const decision = decideFromStatus(status({ status: "abandoned" }));

  assert.equal(decision.kind, "fail");
  assert.match(
    decision.kind === "fail" ? decision.message : "",
    /lost contact with this page/i
  );
});

test("stream reconnect is bounded and backs off", () => {
  assert.equal(shouldReconnectStream(1), true);
  assert.equal(shouldReconnectStream(STREAM_RECONNECT_ATTEMPTS - 1), true);
  assert.equal(shouldReconnectStream(STREAM_RECONNECT_ATTEMPTS), false);

  // Monotonic, and capped so a long outage does not stretch to minutes.
  const delays = [1, 2, 3, 4, 5].map((n) => reconnectDelayMs(n));

  for (let i = 1; i < delays.length; i += 1) {
    assert.ok(delays[i] >= delays[i - 1], "backoff must not decrease");
  }

  assert.ok(delays[delays.length - 1] <= 8000, "backoff must stay capped");
});
