"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelCleanerRun,
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

      const streamed = streamCleanerRun(
        handle.run_id,
        handle.server_epoch,
        (event) => {
          if (event.type === "done") {
            settle({
              summary: event.summary,
              download_token: event.download_token,
              zip_filename: event.zip_filename
            });
          } else if (event.type === "error") {
            fail(new Error(event.message));
          } else {
            onFrame(event);
          }
        },
        controller.signal
      ).catch(() => undefined);

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
