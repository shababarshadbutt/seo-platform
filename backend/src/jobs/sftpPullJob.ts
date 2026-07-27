import { unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  downloadSftpFile,
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
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, domain } = data;

  const remoteFiles = await listSftpSitemapFiles(domain);

  logger.info(
    { session_id: sessionId, domain, files: remoteFiles.length },
    "sftp pull started"
  );

  let stored = 0;
  let failed = 0;

  for (const remote of remoteFiles) {
    const storedFilename = buildStoredUploadFilename(
      sessionId,
      remote.name,
      "current"
    );
    const localPath = path.join(config.uploadDir, storedFilename);

    try {
      await downloadSftpFile(domain, remote.name, localPath);
      // Identical to the upload path from here on — row + parse job.
      // remote.name is the true filename on the SFTP server — recorded so
      // publishing writes back under exactly that name (migration 031).
      await createStoredSitemapFile(
        sessionId,
        storedFilename,
        "current",
        remote.name
      );
      stored += 1;
    } catch (error) {
      failed += 1;
      // Don't leave a truncated download behind to be parsed as a real sitemap.
      await unlink(localPath).catch(() => undefined);
      logger.error(
        { session_id: sessionId, domain, file: remote.name, error },
        "sftp pull: file failed"
      );
    }
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
}
