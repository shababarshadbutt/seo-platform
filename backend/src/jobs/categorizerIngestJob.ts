import { unlink } from "node:fs/promises";
import path from "node:path";

import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  downloadS3Objects,
  listS3SitemapObjects
} from "../s3source/s3SourceClient.js";
import { downloadSftpFiles, listSftpSitemapFiles } from "../sftp/sftpClient.js";
import { streamSitemapUrlLocs } from "../sitemaps/parser.js";
import type { CategorizerIngestJobData } from "../queue/categorizerQueue.js";
import {
  markCategorizerJobComplete,
  markCategorizerJobRunning,
  startOrResumeCategorizerJob,
  updateCategorizerJobCheckpoint,
  updateCategorizerSessionStatus
} from "./categorizerJobState.js";

// Ingest phase: pull every sitemap file for a categorizer session's domain
// (S3 or SFTP, per source_kind) and stream its <loc>s straight into
// categorizer_urls — one row per URL, deduped by (session_id, url).
//
// DELIBERATELY NOT enumeratePopulation (patternPopulation.ts): that holds the
// WHOLE population in one in-memory Map, which is exactly the ceiling this
// tool exists to avoid at tens-of-millions-of-URLs scale. streamSitemapUrlLocs
// is per-URL-callback with zero accumulation across files; only ONE file's
// URL list is ever held in memory at a time (bounded by the sitemap
// protocol's own per-file cap, typically <=50,000), never the whole domain's.
//
// Resumable per FILE, not per URL: checkpoint.files_done is the set of
// filenames already fully ingested. A crash mid-file just re-downloads and
// re-streams that one file on the next run — ON CONFLICT DO NOTHING on the
// (session_id, url) unique index makes that idempotent, so re-ingesting a
// file already partially written never duplicates a row.

type CategorizerSessionRow = {
  id: string;
  source_kind: "s3" | "sftp";
  source_domain: string;
};

type IngestCheckpoint = {
  files_done: string[];
};

// Batches flushed well under Postgres's parameter-count ceiling and small
// enough that one failed INSERT (a deadlock, a transient disconnect) loses at
// most this many pending rows, not a whole large file's worth.
const URL_BATCH_SIZE = 2000;

async function flushUrlBatch(
  sessionId: string,
  sourceFile: string,
  urls: string[]
): Promise<void> {
  if (urls.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: unknown[] = [sessionId];

  for (const url of urls) {
    const base = params.length;

    params.push(url, sourceFile);
    values.push(`($1, $${base + 1}, $${base + 2})`);
  }

  await pool.query(
    `
      INSERT INTO categorizer_urls (session_id, url, source_file)
      VALUES ${values.join(", ")}
      ON CONFLICT (session_id, url) DO NOTHING
    `,
    params
  );
}

export async function processCategorizerIngestJob(
  data: CategorizerIngestJobData,
  logger: FastifyBaseLogger,
  job?: Job
) {
  const { session_id: sessionId } = data;

  const sessionResult = await pool.query<CategorizerSessionRow>(
    "SELECT id, source_kind, source_domain FROM categorizer_sessions WHERE id = $1",
    [sessionId]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new Error(`Categorizer session not found: ${sessionId}`);
  }

  const jobRow = await startOrResumeCategorizerJob(sessionId, "ingest");
  const checkpoint = jobRow.checkpoint as Partial<IngestCheckpoint>;
  const filesDone = new Set(checkpoint.files_done ?? []);

  await updateCategorizerSessionStatus(sessionId, "INGESTING");

  logger.info(
    {
      session_id: sessionId,
      source_kind: session.source_kind,
      domain: session.source_domain,
      already_ingested: filesDone.size
    },
    "categorizer ingest started"
  );

  // Listed fresh every run rather than persisted: a resumed or re-run ingest
  // should pick up any sitemap file published to the source since the last
  // attempt, not just replay a stale list.
  const remoteFiles =
    session.source_kind === "s3"
      ? (await listS3SitemapObjects(session.source_domain)).map((object) => ({
          name: object.name,
          key: object.key
        }))
      : (await listSftpSitemapFiles(session.source_domain)).map((file) => ({
          name: file.name,
          key: file.name
        }));

  const pending = remoteFiles.filter((file) => !filesDone.has(file.name));

  await markCategorizerJobRunning(jobRow.id, remoteFiles.length);
  await job?.updateProgress({
    stage: "ingest",
    current: filesDone.size,
    total: remoteFiles.length,
    message: `Ingesting ${pending.length} of ${remoteFiles.length} file(s) from ${session.source_domain}`
  });

  let failed = 0;

  for (const file of pending) {
    const localPath = path.join(
      config.uploadDir,
      `categorizer-${sessionId}-${file.name}`
    );

    try {
      if (session.source_kind === "s3") {
        const [outcome] = await downloadS3Objects([
          { name: file.name, key: file.key, localPath }
        ]);

        if (!outcome.ok) {
          throw outcome.error ?? new Error(`Failed to download ${file.name}`);
        }
      } else {
        const [outcome] = await downloadSftpFiles(session.source_domain, [
          { name: file.name, localPath }
        ]);

        if (!outcome.ok) {
          throw outcome.error ?? new Error(`Failed to download ${file.name}`);
        }
      }

      // streamSitemapUrlLocs's callback fires synchronously (sax calls it
      // inline), so URLs are collected here and flushed to the DB AFTER the
      // stream settles rather than awaited from inside the callback. Bounded
      // by one file's URL count (the sitemap protocol's own per-file cap,
      // typically <=50,000) — never the whole domain's.
      const urls: string[] = [];

      await streamSitemapUrlLocs(localPath, (loc) => {
        urls.push(loc);
      });

      for (let offset = 0; offset < urls.length; offset += URL_BATCH_SIZE) {
        await flushUrlBatch(
          sessionId,
          file.name,
          urls.slice(offset, offset + URL_BATCH_SIZE)
        );
      }

      filesDone.add(file.name);

      const nextCheckpoint: IngestCheckpoint = {
        files_done: Array.from(filesDone)
      };

      await updateCategorizerJobCheckpoint(
        jobRow.id,
        nextCheckpoint,
        filesDone.size
      );
      await job?.updateProgress({
        stage: "ingest",
        current: filesDone.size,
        total: remoteFiles.length,
        message: `Ingested ${file.name} (${filesDone.size} of ${remoteFiles.length}, ${urls.length} URLs)`
      });
    } catch (error) {
      // A failed file is reported and skipped, not fatal to the whole ingest
      // — the same choice s3PullJob.ts/sftpPullJob.ts make. It stays OUT of
      // files_done, so the next run retries it.
      failed += 1;
      logger.error(
        { session_id: sessionId, file: file.name, error },
        "categorizer ingest: file failed"
      );
    } finally {
      await unlink(localPath).catch(() => undefined);
    }
  }

  await markCategorizerJobComplete(jobRow.id);
  await updateCategorizerSessionStatus(sessionId, "INGESTED");

  logger.info(
    {
      session_id: sessionId,
      files_total: remoteFiles.length,
      files_ingested: filesDone.size,
      files_failed: failed
    },
    "categorizer ingest complete"
  );

  await job?.updateProgress({
    stage: "done",
    current: filesDone.size,
    total: remoteFiles.length,
    message:
      failed > 0
        ? `Ingested ${filesDone.size} of ${remoteFiles.length} file(s), ${failed} failed`
        : `Ingested ${filesDone.size} file(s) from ${session.source_domain}`
  });

  return { filesTotal: remoteFiles.length, filesIngested: filesDone.size, failed };
}
