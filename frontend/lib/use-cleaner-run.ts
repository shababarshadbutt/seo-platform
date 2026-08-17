"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { processCleaner, type CleanerDone, type CleanerProgressEvent } from "./api";
import {
  cleanerProgressInitial,
  reduceCleanerProgress,
  reduceCleanerUploadProgress,
  type CleanerRunProgress
} from "./cleaner-progress";

// Owns the transport and progress state for one Sitemap Cleaner run.
//
// Split out of app/cleaner/page.tsx (already 630 lines) so the page stays a
// layout, and so the interesting part — the stage machine in
// lib/cleaner-progress.ts — stays a pure function this hook merely drives.

// The sr-only live region must not narrate every frame; 1,681 files produce
// many per second. Announce on a step change, otherwise at most this often.
const ANNOUNCE_INTERVAL_MS = 10_000;

function buildAnnouncement(progress: CleanerRunProgress): string {
  return `${progress.label}, ${Math.round(progress.overallPercent)} percent complete.`;
}

export type CleanerRunStart = {
  domain: string;
  subfolder: string;
  files: File[];
};

export function useCleanerRun() {
  const [progress, setProgress] = useState<CleanerRunProgress | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
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

  // Abort any in-flight upload if the component unmounts mid-run.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    abortRef.current = null;
    announceRef.current = { at: 0, stepIndex: -1 };
    setProgress(null);
    setAnnouncement("");
    setCancelling(false);
  }, []);

  const cancel = useCallback(() => {
    setCancelling(true);
    abortRef.current?.abort();
  }, []);

  const start = useCallback(
    async ({ domain, subfolder, files }: CleanerRunStart): Promise<CleanerDone> => {
      const controller = new AbortController();

      abortRef.current = controller;
      announceRef.current = { at: 0, stepIndex: -1 };
      setCancelling(false);
      setProgress(cleanerProgressInitial(files.length));

      const formData = new FormData();

      formData.append("domain", domain);
      formData.append("subfolder", subfolder || "sitemaps");
      // Sent BEFORE the files so the backend knows the denominator by the time
      // the first part lands and can report "X of Y" as it spools. (v1.43)
      formData.append("fileCount", String(files.length));

      for (const file of files) {
        formData.append("files", file, file.name);
      }

      try {
        return await processCleaner(
          formData,
          (event: CleanerProgressEvent) => {
            if (event.type !== "progress") {
              return;
            }

            setProgress((prev) =>
              prev ? reduceCleanerProgress(prev, event) : prev
            );
          },
          {
            totalFiles: files.length,
            signal: controller.signal,
            onUploadProgress: (upload) => {
              setProgress((prev) =>
                prev ? reduceCleanerUploadProgress(prev, upload) : prev
              );
            }
          }
        );
      } finally {
        abortRef.current = null;
        setCancelling(false);
      }
    },
    []
  );

  return { progress, announcement, cancelling, start, cancel, reset };
}
