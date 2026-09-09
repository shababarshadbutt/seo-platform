import { unlink } from "node:fs/promises";
import path from "node:path";

import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  downloadS3Objects,
  listS3SitemapObjects,
  S3OperationTimeoutError
} from "../s3source/s3SourceClient.js";
import { buildStoredUploadFilename } from "../sitemaps/filenames.js";
import type { S3PullJobData } from "../queue/publishQueue.js";
import { createStoredSitemapFile } from "../sitemaps/ingest.js";

// Background S3 pull. Downloads every sitemap object under one domain's prefix
// into this session's storage and hands them to the SAME ingestion path a manual
// upload uses (createStoredSitemapFile -> sitemap_files row + parse job), so
// nothing downstream of ingestion special-cases the source.
//
// The counterpart of processSftpPullJob, deliberately the same shape: the two
// differ only in which client fetches the bytes. What it pulls FROM is the exact
// prefix the publish job writes TO, so a session created this way can be edited
// and published back over the objects it read.
//
// Session-scoped throughout: files are stored under this session's id, exactly
// like uploads, so one user's pull can never appear in another user's session.
export async function processS3PullJob(
  data: S3PullJobData,
  logger: FastifyBaseLogger,
  // Progress is written to the BullMQ job so the SSE route can follow it without
  // the API process needing a channel back into this worker — the same mechanism
  // the SFTP pull and the publish already use, deliberately not a new one.
  job?: Job
) {
  const { session_id: sessionId, domain } = data;

  // Re-check the flag HERE, not just at the route that enqueued this. A job can
  // outlive the process that queued it (retries, a restart with a changed .env),
  // so the worker refuses rather than trusting that the enqueue was gated.
  if (!config.awsPublishEnabled) {
    throw new Error(
      "S3 pull is disabled on this deployment (AWS_PUBLISH_ENABLED is not true)"
    );
  }

  // The full object set is known BEFORE the download loop — it has to be, to know
  // what to pull — so the total is available from the first frame onward. That is
  // the whole point: a bare incrementing count tells the user nothing about how
  // much is left.
  const remoteObjects = await listS3SitemapObjects(domain);
  const total = remoteObjects.length;

  logger.info(
    { session_id: sessionId, domain, files: total },
    "s3 pull started"
  );

  await job?.updateProgress({
    stage: "start",
    current: 0,
    total,
    message: `Pulling ${total} file(s) from ${domain}`
  });

  let stored = 0;
  let failed = 0;

  const targets = remoteObjects.map((remote) => {
    const storedFilename = buildStoredUploadFilename(
      sessionId,
      remote.name,
      "current"
    );

    return {
      name: remote.name,
      key: remote.key,
      storedFilename,
      localPath: path.join(config.uploadDir, storedFilename)
    };
  });

  const outcomes = await downloadS3Objects(targets, {
    onSettled: async (outcome, completed) => {
      // Awaited, not fire-and-forget: unordered progress writes let a late frame
      // land after the terminal one and clobber it — a defect already found and
      // fixed on the publish path, so it is not repeated here.
      const timedOut = !outcome.ok && outcome.error instanceof S3OperationTimeoutError;

      await job?.updateProgress({
        stage: "pull",
        current: completed,
        total,
        // A stalled file gets its own wording, distinct from a generic
        // failure, so the live progress text already tells the user this file
        // was skipped rather than the pull being broken outright.
        message: outcome.ok
          ? `Pulled ${outcome.name} (${completed} of ${total})`
          : timedOut
            ? `Skipped ${outcome.name} — no response from S3 (${completed} of ${total})`
            : `Failed ${outcome.name} (${completed} of ${total})`
      });
    }
  });

  // Names (with a friendly reason) of every file that didn't make it, so the
  // UI can tell the user exactly what to look at instead of just a count.
  const skippedFiles: { name: string; reason: string }[] = [];

  for (const [index, outcome] of outcomes.entries()) {
    if (!outcome.ok) {
      failed += 1;
      skippedFiles.push({
        name: outcome.name,
        reason:
          outcome.error instanceof S3OperationTimeoutError
            ? "took too long to respond"
            : "couldn't be downloaded"
      });
      // Don't leave a truncated download behind to be parsed as a real sitemap.
      await unlink(outcome.localPath).catch(() => undefined);
      logger.error(
        { session_id: sessionId, domain, file: outcome.name, error: outcome.error },
        "s3 pull: file failed"
      );
      continue;
    }

    // Identical to the upload path from here on — row + parse job.
    // outcome.name is the true object basename in the bucket — recorded so
    // publishing writes back under exactly that key (migration 031).
    await createStoredSitemapFile(
      sessionId,
      // Carried through from the target rather than recovered from the path with
      // basename(): downloadS3Objects returns outcomes index-aligned with its
      // input, so the stored name is knowable exactly.
      targets[index].storedFilename,
      "current",
      outcome.name
    );
    stored += 1;
  }

  // Mirrors what the upload flow does once every file has landed.
  await pool.query(
    "UPDATE sessions SET upload_complete = TRUE WHERE id = $1",
    [sessionId]
  );

  logger.info(
    { session_id: sessionId, domain, stored, failed },
    "s3 pull complete"
  );

  await job?.updateProgress({
    stage: "done",
    current: total,
    total,
    message:
      failed > 0
        ? `Pulled ${stored} of ${total} file(s), ${failed} failed`
        : `Pulled ${stored} file(s) from ${domain}`,
    result: { stored, failed, total, domain, skippedFiles }
  });

  // Returned as the job's RETURN VALUE too: BullMQ persists that atomically with
  // completion, whereas a progress write can still be in flight when a watcher
  // first sees "completed" (a defect found on the publish path).
  return { stored, failed, total, domain, skippedFiles };
}
