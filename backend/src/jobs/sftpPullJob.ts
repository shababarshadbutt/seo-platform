import { unlink } from "node:fs/promises";
import path from "node:path";

import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  downloadSftpFiles,
  listSftpSitemapFiles
} from "../sftp/sftpClient.js";
import { buildStoredUploadFilename } from "../sitemaps/filenames.js";
import type { SftpPullJobData } from "../queue/publishQueue.js";
import { createStoredSitemapFile } from "../sitemaps/ingest.js";

// Background SFTP pull (Phase 1). Downloads every sitemap file for one domain
// into this session's storage and hands them to the SAME ingestion path a
// manual upload uses (createStoredSitemapFile -> sitemap_files row + parse
// job), so nothing downstream of ingestion special-cases the source.
//
// Session-scoped throughout: files are stored under this session's id, exactly
// like uploads, so one user's pull can never appear in another user's session.
export async function processSftpPullJob(
  data: SftpPullJobData,
  logger: FastifyBaseLogger,
  // Progress is written to the BullMQ job so the SSE route can follow it without
  // the API process needing a channel back into this worker — the same mechanism
  // processS3PublishJob already uses, deliberately not a new one.
  job?: Job
) {
  const { session_id: sessionId, domain } = data;

  // Re-check the flag HERE, not just at the route that enqueued this. A job can
  // outlive the process that queued it (retries, a restart with a changed .env),
  // so the worker refuses rather than trusting that the enqueue was gated.
  if (!config.awsPublishEnabled) {
    throw new Error(
      "SFTP pull is disabled on this deployment (AWS_PUBLISH_ENABLED is not true)"
    );
  }

  // The full file set is known BEFORE the download loop — it has to be, to know
  // what to pull — so the total is available from the first frame onward. That is
  // the whole point: a bare incrementing count tells the user nothing about how
  // much is left.
  const remoteFiles = await listSftpSitemapFiles(domain);
  const total = remoteFiles.length;

  logger.info(
    { session_id: sessionId, domain, files: total },
    "sftp pull started"
  );

  await job?.updateProgress({
    stage: "start",
    current: 0,
    total,
    message: `Pulling ${total} file(s) from ${domain}`
  });

  let stored = 0;
  let failed = 0;

  // Downloaded with bounded parallelism (SFTP_MAX_CONCURRENT_CONNECTIONS) rather
  // than one file at a time. Every download is its own SSH connect + fastGet +
  // end, so the sequential loop this replaces paid a full round trip per file and
  // left most of the connection pool idle. At 1,000+ files the pull dominated the
  // whole run.
  //
  // The DB row + parse job stay sequential, in listing order, after the transfers
  // settle: createStoredSitemapFile enqueues parse work and writes rows, and
  // interleaving those with the downloads would trade a well-understood
  // bottleneck for concurrent writes that nothing here needs.
  const targets = remoteFiles.map((remote) => {
    const storedFilename = buildStoredUploadFilename(
      sessionId,
      remote.name,
      "current"
    );

    return {
      name: remote.name,
      storedFilename,
      localPath: path.join(config.uploadDir, storedFilename)
    };
  });

  const outcomes = await downloadSftpFiles(domain, targets, {
    onSettled: async (outcome, completed) => {
      // Awaited, not fire-and-forget: unordered progress writes let a late frame
      // land after the terminal one and clobber it — a defect already found and
      // fixed on the publish path, so it is not repeated here.
      await job?.updateProgress({
        stage: "pull",
        current: completed,
        total,
        message: outcome.ok
          ? `Pulled ${outcome.name} (${completed} of ${total})`
          : `Failed ${outcome.name} (${completed} of ${total})`
      });
    }
  });

  for (const [index, outcome] of outcomes.entries()) {
    if (!outcome.ok) {
      failed += 1;
      // Don't leave a truncated download behind to be parsed as a real sitemap.
      await unlink(outcome.localPath).catch(() => undefined);
      logger.error(
        { session_id: sessionId, domain, file: outcome.name, error: outcome.error },
        "sftp pull: file failed"
      );
      continue;
    }

    // Identical to the upload path from here on — row + parse job.
    // outcome.name is the true filename on the SFTP server — recorded so
    // publishing writes back under exactly that name (migration 031).
    await createStoredSitemapFile(
      sessionId,
      // Carried through from the target rather than recovered from the path with
      // basename(): downloadSftpFiles returns outcomes index-aligned with its
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
    "sftp pull complete"
  );

  await job?.updateProgress({
    stage: "done",
    current: total,
    total,
    message:
      failed > 0
        ? `Pulled ${stored} of ${total} file(s), ${failed} failed`
        : `Pulled ${stored} file(s) from ${domain}`,
    result: { stored, failed, total, domain }
  });

  // Returned as the job's RETURN VALUE too: BullMQ persists that atomically with
  // completion, whereas a progress write can still be in flight when a watcher
  // first sees "completed" (the third defect found on the publish path).
  return { stored, failed, total, domain };
}
