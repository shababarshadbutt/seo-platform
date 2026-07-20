import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import {
  enqueueCleanupUploadsJob,
  enqueueExtractPatternsJob,
  enqueueParseSitemapJobs,
  sitemapQueue
} from "../queue/sitemapQueue.js";
import { enqueuePreGenerateZipJob } from "../queue/preGenerateZipQueue.js";

type SessionReadinessRow = {
  id: string;
  status: string;
  upload_complete: boolean;
  total_file_count: string;
  terminal_file_count: string;
  extractable_file_count: string;
  fallback_sitemap_file_id: string | null;
};

type PendingSitemapFileRow = {
  id: string;
};

type TerminalFileCountRow = {
  terminal_file_count: string;
};

function parsedCountKey(sessionId: string) {
  return `session:${sessionId}:parsed_count`;
}

async function redisClient() {
  return (await sitemapQueue.client) as unknown as {
    get(key: string): Promise<string | null>;
    incr(key: string): Promise<number>;
    del(key: string): Promise<number>;
    set(key: string, value: string): Promise<"OK" | null>;
    expire(key: string, seconds: number): Promise<number>;
  };
}

export async function resetParsedSitemapCount(sessionId: string) {
  const client = await redisClient();

  await client.del(parsedCountKey(sessionId));
}

// Cheap guard for worker job handlers: a job that was already active when the
// user hit Stop must exit without doing (or persisting) any work.
export async function isSessionCancelled(sessionId: string) {
  const result = await pool.query<{ status: string }>(
    "SELECT status FROM sessions WHERE id = $1::uuid",
    [sessionId]
  );

  return result.rows[0]?.status === "CANCELLED";
}

export async function incrementParsedSitemapCount(sessionId: string) {
  const client = await redisClient();
  const parsedCount = await client.incr(parsedCountKey(sessionId));

  await client.expire(parsedCountKey(sessionId), 60 * 60 * 24);

  return parsedCount;
}

export async function syncParsedSitemapCountToDb(sessionId: string) {
  const result = await pool.query<TerminalFileCountRow>(
    `
      SELECT COUNT(*) FILTER (
        WHERE parsed_at IS NOT NULL
           OR is_valid = FALSE
      )::bigint AS terminal_file_count
      FROM sitemap_files
      WHERE session_id = $1::uuid
    `,
    [sessionId]
  );
  const terminalFileCount = Number(result.rows[0]?.terminal_file_count ?? 0);
  const client = await redisClient();

  if (terminalFileCount > 0) {
    await client.set(parsedCountKey(sessionId), String(terminalFileCount));
    await client.expire(parsedCountKey(sessionId), 60 * 60 * 24);
  } else {
    await client.del(parsedCountKey(sessionId));
  }

  return terminalFileCount;
}

export async function enqueuePendingParseSitemapJobs(
  sessionId: string,
  logger: FastifyBaseLogger
) {
  const result = await pool.query<PendingSitemapFileRow>(
    `
      SELECT id
      FROM sitemap_files
      WHERE session_id = $1::uuid
        AND parsed_at IS NULL
        AND is_valid = TRUE
      ORDER BY id ASC
    `,
    [sessionId]
  );

  if (result.rows.length === 0) {
    return 0;
  }

  await enqueueParseSitemapJobs(
    result.rows.map((row) => ({
      sitemap_file_id: row.id,
      session_id: sessionId
    }))
  );

  logger.info(
    {
      session_id: sessionId,
      pending_file_count: result.rows.length
    },
    "pending parse sitemap jobs re-enqueued"
  );

  return result.rows.length;
}

async function currentParsedSitemapCount(sessionId: string) {
  const client = await redisClient();
  const value = await client.get(parsedCountKey(sessionId));
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadSessionReadiness(sessionId: string) {
  const result = await pool.query<SessionReadinessRow>(
    `
      SELECT
        sessions.id,
        sessions.status,
        sessions.upload_complete,
        COUNT(sitemap_files.id)::bigint AS total_file_count,
        COUNT(sitemap_files.id) FILTER (
          WHERE sitemap_files.parsed_at IS NOT NULL
            OR sitemap_files.is_valid = FALSE
        )::bigint AS terminal_file_count,
        COUNT(sitemap_files.id) FILTER (
          WHERE sitemap_files.parsed_at IS NOT NULL
            AND sitemap_files.is_index = FALSE
            AND (
              (sitemap_files.is_valid = TRUE AND sitemap_files.is_empty = FALSE)
              OR EXISTS (
                SELECT 1
                FROM sitemap_partial_urls
                WHERE sitemap_partial_urls.sitemap_file_id = sitemap_files.id
              )
            )
        )::bigint AS extractable_file_count,
        MIN(sitemap_files.id::text) FILTER (
          WHERE sitemap_files.parsed_at IS NOT NULL
             OR sitemap_files.is_valid = FALSE
        ) AS fallback_sitemap_file_id
      FROM sessions
      LEFT JOIN sitemap_files
        ON sitemap_files.session_id = sessions.id
      WHERE sessions.id = $1::uuid
      GROUP BY sessions.id
    `,
    [sessionId]
  );

  return result.rows[0] ?? null;
}

export async function tryFinalizeParsedSession(
  sessionId: string,
  logger: FastifyBaseLogger,
  parsedCountOverride?: number,
  fallbackSitemapFileId?: string
) {
  const readiness = await loadSessionReadiness(sessionId);

  if (!readiness) {
    return false;
  }

  const parsedCount =
    parsedCountOverride ?? (await currentParsedSitemapCount(sessionId));
  const totalFileCount = Number(readiness.total_file_count);
  const terminalFileCount = Number(readiness.terminal_file_count);
  const extractableFileCount = Number(readiness.extractable_file_count);

  if (!readiness.upload_complete) {
    logger.info(
      {
        session_id: sessionId,
        parsed_count: parsedCount,
        total_file_count: totalFileCount
      },
      "session parsing not finalized because upload is not complete"
    );
    return false;
  }

  if (totalFileCount === 0) {
    return false;
  }

  if (parsedCount < totalFileCount || terminalFileCount < totalFileCount) {
    logger.info(
      {
        session_id: sessionId,
        parsed_count: parsedCount,
        total_file_count: totalFileCount,
        terminal_file_count: terminalFileCount
      },
      "session parsing not finalized because files are still pending"
    );
    return false;
  }

  if (!["PENDING", "PROCESSING"].includes(readiness.status)) {
    return false;
  }

  const sitemapFileId =
    fallbackSitemapFileId ?? readiness.fallback_sitemap_file_id;

  if (!sitemapFileId) {
    return false;
  }

  if (extractableFileCount > 0) {
    await enqueueExtractPatternsJob({
      sitemap_file_id: sitemapFileId,
      session_id: sessionId
    });
  } else {
    await markSessionComplete(sessionId);
  }

  return true;
}

export async function markSessionComplete(sessionId: string) {
  await pool.query(
    "UPDATE sessions SET status = 'COMPLETE', completed_at = now() WHERE id = $1::uuid",
    [sessionId]
  );
  await enqueueCleanupUploadsJob({
    session_id: sessionId
  });
  // Pre-generate both download ZIPs in the background so the first download is
  // instant instead of building a fresh archive on demand. Fire-and-forget: a
  // Redis/queue hiccup here must NEVER throw into (and fail-then-retry) the
  // sample job that called us, and must never block session completion. If the
  // enqueue fails, the download simply falls back to on-demand streaming.
  void enqueuePreGenerateZipJob({ session_id: sessionId, type: "all" }).catch(
    () => {}
  );
  void enqueuePreGenerateZipJob({ session_id: sessionId, type: "edited" }).catch(
    () => {}
  );
}
