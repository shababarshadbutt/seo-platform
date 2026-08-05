import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { ingestFilesIntoSession } from "../sitemaps/batchIngest.js";
import type { CleanerIngestJobData } from "../queue/publishQueue.js";

// Background Cleaner -> Migration handoff ingest.
//
// This was a sequential loop inside POST /api/sessions/:id/sources/cleaner:
// copyFile + createStoredSitemapFile, one file at a time, for every cleaned file.
// At the reported 2,700 files that is 2,700 serial rounds of three I/O operations
// with no progress reporting and no upper bound, and the request died with
// "Server error — fetch failed" — undici in the frontend proxy abandoning the wait
// for response headers at 300s (measured: 305.1s, UND_ERR_HEADERS_TIMEOUT). The
// backend itself never aborted anything; it was still working.
//
// Modelled on processSftpPullJob, which is the same operation from a different
// source (pull N files into a session, hand each to createStoredSitemapFile, then
// set upload_complete) and already runs on this queue with BullMQ job progress.
// Deliberately NOT given a tracking table: the SFTP sibling needs none, and unlike
// the pattern-structure jobs there is no retry-fingerprint or one-at-a-time
// invariant to enforce — createStoredSitemapFile is idempotent per
// (session_id, filename), so a repeated ingest is a no-op rather than damage.
export async function processCleanerIngestJob(
  data: CleanerIngestJobData,
  logger: FastifyBaseLogger,
  job?: Job
) {
  const { session_id: sessionId, domain, files } = data;
  const total = files.length;

  logger.info(
    { session_id: sessionId, domain, files: total },
    "cleaner ingest started"
  );

  // The total is known before the first file, so every frame carries current AND
  // total — a bare incrementing count says nothing about how much is left.
  await job?.updateProgress({
    stage: "start",
    current: 0,
    total,
    message: `Ingesting ${total} cleaned file(s)`
  });

  const outcomes = await ingestFilesIntoSession({
    sessionId,
    files,
    onSettled: async (outcome, completed) => {
      await job?.updateProgress({
        stage: "ingest",
        current: completed,
        total,
        message: `${completed} of ${total} files ingested`
      });
    }
  });

  let stored = 0;
  let skipped = 0;
  let failed = 0;

  for (const outcome of outcomes) {
    if (outcome.ok) {
      stored += 1;

      // Already ingested by an earlier attempt — counted as ingested (it IS), and
      // reported separately so a retry's cheapness is visible rather than looking
      // like it silently did nothing.
      if (outcome.skipped) skipped += 1;

      continue;
    }

    failed += 1;
    logger.error(
      {
        session_id: sessionId,
        file: outcome.filename,
        error: outcome.error
      },
      "cleaner ingest: file failed"
    );
  }

  if (stored === 0) {
    // Nothing landed: fail the job rather than marking the session ready to
    // analyse an empty file set. Matches the old route's 500.
    throw new Error("Could not ingest any cleaned files.");
  }

  // Same completion signal the upload and SFTP-pull flows send.
  await pool.query("UPDATE sessions SET upload_complete = TRUE WHERE id = $1", [
    sessionId
  ]);

  logger.info(
    {
      session_id: sessionId,
      domain,
      stored,
      // newly_copied vs already_present makes a resumed retry legible in the logs.
      newly_copied: stored - skipped,
      already_present: skipped,
      failed,
      total
    },
    "cleaner ingest complete"
  );

  const result = {
    ingested: stored,
    already_present: skipped,
    failed,
    total,
    domain
  };

  await job?.updateProgress({
    stage: "done",
    current: total,
    total,
    message:
      failed > 0
        ? `Ingested ${stored} of ${total} file(s), ${failed} failed`
        : skipped > 0
          ? `Ingested ${stored} file(s) (${skipped} already present)`
          : `Ingested ${stored} file(s)`,
    result
  });

  // Returned as the job's RETURN VALUE too: BullMQ persists that atomically with
  // completion, whereas a progress write can still be in flight when a watcher
  // first sees "completed" (a defect already found on the publish path).
  return result;
}
