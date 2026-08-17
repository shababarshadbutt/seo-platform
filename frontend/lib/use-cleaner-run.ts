"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelCleanerRun,
  CleanerStreamEndedError,
  completeCleanerRun,
  createCleanerRun,
  getCleanerRunStatus,
  processCleaner,
  streamCleanerRun,
  uploadCleanerBatch,
  type CleanerDone,
  type CleanerProgressEvent
} from "./api";
import { chunkFiles } from "./chunk";
import {
  decideFromProbeError,
  decideFromStatus,
  reconnectDelayMs,
  shouldReconnectStream,
  STALL_CHECK_MS,
  STALL_PROBE_ATTEMPTS,
  STALL_PROBE_BACKOFF_MS,
  STREAM_RECONNECT_ATTEMPTS,
  STREAM_STALL_MS,
  type StallDecision
} from "./cleaner-stall";
import {
  cleanerProgressInitial,
  reduceCleanerProgress,
  reduceCleanerUploadProgress,
  type CleanerRunProgress
} from "./cleaner-progress";

// Owns transport and progress state for one Sitemap Cleaner run.
//
// Two paths live here:
//   - BATCHED (loose .xml files): create run → open stream → N concurrent batch
//     uploads → complete. This is the fix for the 1,681-file stall.
//   - LEGACY one-shot (any .zip in the selection): a ZIP is a single part that
//     the server expands, so batching it buys nothing and would complicate the
//     ordering key. It keeps the v1.50 single-request path.

const MAX_CONCURRENT_UPLOADS = 3;
const BATCH_RETRY_DELAYS_MS = [1000, 2000, 4000];
const ANNOUNCE_INTERVAL_MS = 10_000;

function buildAnnouncement(progress: CleanerRunProgress): string {
  return `${progress.label}, ${Math.round(progress.overallPercent)} percent complete.`;
}

function isTransient(error: unknown): boolean {
  // Retry the network, never a 4xx: a rejected batch will be rejected again.
  if (error instanceof TypeError) {
    return true;
  }

  const status = (error as { status?: number } | null)?.status;

  return typeof status === "number" && status >= 500;
}

const delay = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type CleanerRunStart = {
  domain: string;
  subfolder: string;
  files: File[];
};

export function useCleanerRun() {
  const [progress, setProgress] = useState<CleanerRunProgress | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "warning"; text: string } | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const announceRef = useRef({ at: 0, stepIndex: -1 });

  useEffect(() => {
    if (!progress) {
      return;
    }

    const now = Date.now();
    const stepChanged = progress.stepIndex !== announceRef.current.stepIndex;

    if (!stepChanged && now - announceRef.current.at < ANNOUNCE_INTERVAL_MS) {
      return;
    }

    announceRef.current = { at: now, stepIndex: progress.stepIndex };
    setAnnouncement(buildAnnouncement(progress));
  }, [progress]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current = null;
    runIdRef.current = null;
    announceRef.current = { at: 0, stepIndex: -1 };
    setProgress(null);
    setAnnouncement("");
    setNotice(null);
    setCancelling(false);
  }, []);

  const cancel = useCallback(() => {
    setCancelling(true);
    abortRef.current?.abort();

    // Aborting the client's XHR is no longer enough: under batching that stops
    // ONE request and leaves a live run holding a working directory.
    if (runIdRef.current) {
      void cancelCleanerRun(runIdRef.current);
    }
  }, []);

  const start = useCallback(
    async ({ domain, subfolder, files }: CleanerRunStart): Promise<CleanerDone> => {
      // Snapshot before anything async: a re-render or a removed file between
      // batch dispatches would shift positions, and position is part of a file's
      // identity in the canonical ordering.
      const ordered = [...files];
      const controller = new AbortController();

      abortRef.current = controller;
      announceRef.current = { at: 0, stepIndex: -1 };
      setCancelling(false);
      setNotice(null);
      setProgress(cleanerProgressInitial(ordered.length));

      const onFrame = (event: CleanerProgressEvent) => {
        if (event.type !== "progress") {
          return;
        }

        setProgress((prev) => (prev ? reduceCleanerProgress(prev, event) : prev));
      };

      // A ZIP expands server-side into many files from one part — nothing to
      // batch, and it would complicate the ordering key.
      if (ordered.some((file) => /\.zip$/i.test(file.name))) {
        return runLegacy({ domain, subfolder, files: ordered, controller, onFrame, setProgress });
      }

      const handle = await createCleanerRun({
        domain,
        subfolder,
        totalFiles: ordered.length
      });

      runIdRef.current = handle.run_id;

      // Terminal frames arrive on the stream, not as an HTTP response: complete
      // returns 202 before the clean even starts.
      let settle: (done: CleanerDone) => void = () => {};
      let fail: (error: unknown) => void = () => {};
      const finished = new Promise<CleanerDone>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });

      // ---- Stream supervision (rewritten in v1.53) -------------------------
      //
      // v1.52's watchdog treated "the stream went quiet" as "the backend died",
      // and ended healthy runs on a single failed status probe. The rule now is:
      // SILENCE IS NOT EVIDENCE. Only a definite answer from the server — this
      // run is gone, or this run finished — ends a run. Everything else
      // reconnects, which the backend has always supported (it replays its last
      // frame on resubscribe) and which the client simply never used.
      //
      // All the decisions live in lib/cleaner-stall.ts as pure functions, so the
      // cases v1.52 got wrong are unit-tested rather than reasoned about.
      let settled = false;
      let lastActivityAt = Date.now();
      let watchdog: ReturnType<typeof setInterval> | null = null;
      let probing = false;
      // Per-attempt abort, CHILD of the run's controller. A stalled socket that
      // never closes would otherwise leave `reader.read()` pending forever, so
      // the watchdog needs its own way to tear the attempt down and force a
      // reattach. Aborting the run's own controller would cancel the run.
      let streamAbort: AbortController | null = null;
      let forcedReconnect = false;

      const finish = (outcome: StallDecision) => {
        if (settled) {
          return;
        }

        if (outcome.kind === "settle") {
          settled = true;
          settle(outcome.done);
        } else if (outcome.kind === "fail") {
          settled = true;
          fail(new Error(outcome.message));
        }
      };

      const stopWatchdog = () => {
        if (watchdog) {
          clearInterval(watchdog);
          watchdog = null;
        }
      };

      const onStreamEvent = (event: CleanerProgressEvent) => {
        if (event.type === "done") {
          finish({
            kind: "settle",
            done: {
              summary: event.summary,
              download_token: event.download_token,
              zip_filename: event.zip_filename
            }
          });
        } else if (event.type === "error") {
          finish({ kind: "fail", message: event.message });
        } else {
          onFrame(event);
        }
      };

      // Reattach to the run's progress stream. The server sends `started` then
      // replays lastFrame/terminalFrame, and the reducer's seq guard drops the
      // replays — so a reconnect costs nothing and loses nothing. Resubscribing
      // also refreshes the server's abandonment heartbeat, which is what stops
      // the 5-minute reaper from killing a run whose client is merely
      // reconnecting.
      const connect = async (attempt: number): Promise<void> => {
        streamAbort = new AbortController();
        forcedReconnect = false;

        // Cancelling the run must also tear down the in-flight stream.
        const linkAbort = () => streamAbort?.abort();

        controller.signal.addEventListener("abort", linkAbort, { once: true });

        try {
          await streamCleanerRun(
            handle.run_id,
            handle.server_epoch,
            onStreamEvent,
            streamAbort.signal,
            () => {
              lastActivityAt = Date.now();
            }
          );
        } catch (error) {
          if (settled) {
            return;
          }

          // The user cancelled — not a fault, and nothing to reattach to.
          if (controller.signal.aborted) {
            return;
          }

          // Either the socket closed with no terminal frame, or the watchdog
          // tore down a stalled-but-open socket. Both mean "reattach".
          const reattachable = forcedReconnect || error instanceof CleanerStreamEndedError;

          if (reattachable && shouldReconnectStream(attempt)) {
            setNotice({
              tone: "warning",
              text: `Reconnecting to the cleaning run (attempt ${attempt} of ${STREAM_RECONNECT_ATTEMPTS})…`
            });
            await delay(reconnectDelayMs(attempt));

            if (settled || controller.signal.aborted) {
              return;
            }

            return connect(attempt + 1);
          }

          if (reattachable) {
            // Out of reconnect attempts. Ask the server for a verdict rather
            // than assuming the worst — the run may well have finished.
            await probeUntilDecided();

            // CRITICAL: the probe can legitimately return "still running", which
            // settles nothing. Leaving it there would hang `await finished`
            // forever — exactly the freeze this whole change exists to remove.
            // So say something true and terminal instead.
            finish({
              kind: "fail",
              message:
                "Could not stay connected to the cleaning run. It may still be finishing on the server — check the backend logs before re-running, so the work is not repeated."
            });

            return;
          }

          finish({
            kind: "fail",
            message:
              error instanceof Error ? error.message : "The progress stream failed."
          });
        } finally {
          controller.signal.removeEventListener("abort", linkAbort);
        }
      };

      // Probe with retry. Below the attempt budget a failure means nothing: the
      // probe shares a transport with the stream that just went silent, so the
      // two failures are correlated. Only a 404 is informative immediately.
      const probeUntilDecided = async () => {
        if (probing || settled) {
          return;
        }

        probing = true;

        try {
          for (let attempt = 1; attempt <= STALL_PROBE_ATTEMPTS; attempt += 1) {
            if (settled || controller.signal.aborted) {
              return;
            }

            let decision: StallDecision;

            try {
              decision = decideFromStatus(await getCleanerRunStatus(handle.run_id));
            } catch (error) {
              decision = decideFromProbeError(error, attempt);
            }

            if (decision.kind === "wait") {
              await delay(STALL_PROBE_BACKOFF_MS[attempt - 1] ?? 3000);
              continue;
            }

            if (decision.kind === "reconnect") {
              setNotice({ tone: "warning", text: decision.notice });
              // Proof of life, so the watchdog does not fire again while the
              // reattach is in flight.
              lastActivityAt = Date.now();
              // FORCE the reattach. A socket can be silent without ever closing
              // (TCP black hole, VPN re-key, sleep/resume), in which case
              // `reader.read()` stays pending forever and `connect`'s catch never
              // runs. Tearing down this attempt is what turns "the server says
              // it's alive" into an actual reconnection rather than a notice
              // above a frozen bar — which is all v1.52 managed.
              forcedReconnect = true;
              streamAbort?.abort();

              return;
            }

            finish(decision);

            return;
          }
        } finally {
          probing = false;
        }
      };

      const armWatchdog = () => {
        stopWatchdog();
        lastActivityAt = Date.now();
        // Deliberately armed only AFTER the stream is opened. v1.52 armed it
        // before, so an upload-phase stall produced an unhandled rejection while
        // the uploads carried on to completion for nobody.
        watchdog = setInterval(() => {
          if (settled || Date.now() - lastActivityAt < STREAM_STALL_MS) {
            return;
          }

          // NOT cleared here. v1.52 cleared its own interval before probing and
          // never re-armed, so even its benign branch left nothing able to
          // settle the run — the bar froze forever, which is the bug the
          // watchdog existed to fix.
          void probeUntilDecided();
        }, STALL_CHECK_MS);
        watchdog.unref?.();
      };

      armWatchdog();

      const streamed = connect(1).finally(stopWatchdog);

      const batches = chunkFiles(ordered, handle.batch_size);
      const totalBytes = ordered.reduce((sum, file) => sum + file.size, 0);
      // Bytes are exact and known up front, so the aggregate percentage is not
      // an estimate. Completed batches are pinned at their full size, so the sum
      // is monotonic however the in-flight ones report.
      const batchBytes = batches.map((batch) =>
        batch.reduce((sum, file) => sum + file.size, 0)
      );
      const loaded = new Array<number>(batches.length).fill(0);
      const publishBytes = () => {
        const sent = loaded.reduce((sum, value) => sum + value, 0);

        setProgress((prev) =>
          prev
            ? reduceCleanerUploadProgress(prev, {
                loadedBytes: sent,
                totalBytes,
                transferredFiles: 0,
                totalFiles: ordered.length,
                percent: totalBytes > 0 ? (sent / totalBytes) * 100 : 0
              })
            : prev
        );
      };

      let cursor = 0;
      const worker = async () => {
        for (;;) {
          const index = cursor;

          cursor += 1;

          if (index >= batches.length) {
            return;
          }

          for (let attempt = 0; ; attempt += 1) {
            try {
              await uploadCleanerBatch(handle.run_id, index, batches[index], {
                signal: controller.signal,
                onProgress: (sent) => {
                  loaded[index] = sent;
                  publishBytes();
                }
              });
              loaded[index] = batchBytes[index];
              publishBytes();
              break;
            } catch (error) {
              // Retry is legitimate here precisely BECAUSE the server is
              // idempotent on batchIndex — a replay replaces the slot rather
              // than appending to it.
              if (attempt >= BATCH_RETRY_DELAYS_MS.length || !isTransient(error)) {
                throw error;
              }

              setNotice({
                tone: "warning",
                text: `Re-sending part ${index + 1} of ${batches.length}…`
              });
              await delay(BATCH_RETRY_DELAYS_MS[attempt]);
            }
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, batches.length) }, () =>
          worker()
        )
      );

      setNotice(null);

      try {
        await completeCleanerRun(handle.run_id);
      } catch (error) {
        // The server names exactly which batches it is missing, so resume is
        // server-authoritative rather than relying on a client-side ledger.
        const status = await getCleanerRunStatus(handle.run_id).catch(() => null);
        const missing = [
          ...(status?.missing_batches ?? []),
          ...(status?.partial_batches ?? [])
        ];

        if (missing.length === 0) {
          throw error;
        }

        for (const index of missing) {
          await uploadCleanerBatch(handle.run_id, index, batches[index], {
            signal: controller.signal
          });
        }

        await completeCleanerRun(handle.run_id);
      }

      const done = await finished;

      await streamed;

      return done;
    },
    []
  );

  return { progress, announcement, cancelling, notice, start, cancel, reset };
}

// The unchanged v1.50 single-request path, kept for ZIP uploads.
async function runLegacy(options: {
  domain: string;
  subfolder: string;
  files: File[];
  controller: AbortController;
  onFrame: (event: CleanerProgressEvent) => void;
  setProgress: React.Dispatch<React.SetStateAction<CleanerRunProgress | null>>;
}): Promise<CleanerDone> {
  const { domain, subfolder, files, controller, onFrame, setProgress } = options;
  const formData = new FormData();

  formData.append("domain", domain);
  formData.append("subfolder", subfolder || "sitemaps");
  formData.append("fileCount", String(files.length));

  for (const file of files) {
    formData.append("files", file, file.name);
  }

  return processCleaner(formData, onFrame, {
    totalFiles: files.length,
    signal: controller.signal,
    onUploadProgress: (upload) => {
      setProgress((prev) => (prev ? reduceCleanerUploadProgress(prev, upload) : prev));
    }
  });
}
