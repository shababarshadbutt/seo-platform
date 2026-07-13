import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import {
  enqueuePendingParseSitemapJobs,
  syncParsedSitemapCountToDb,
  tryFinalizeParsedSession
} from "./sessionCompletion.js";

type StuckSessionRow = {
  id: string;
};

export async function processWatchdogStuckSessionsJob(
  logger: FastifyBaseLogger
) {
  const result = await pool.query<StuckSessionRow>(
    `
      SELECT id
      FROM sessions
      WHERE upload_complete = TRUE
        AND status IN ('PENDING', 'PROCESSING')
      ORDER BY created_at ASC
      LIMIT 50
    `
  );

  for (const session of result.rows) {
    const reEnqueuedCount = await enqueuePendingParseSitemapJobs(
      session.id,
      logger
    );
    const terminalFileCount = await syncParsedSitemapCountToDb(session.id);
    const finalized = await tryFinalizeParsedSession(session.id, logger);

    logger.info(
      {
        session_id: session.id,
        re_enqueued_count: reEnqueuedCount,
        terminal_file_count: terminalFileCount,
        finalized
      },
      "stuck session watchdog checked session"
    );
  }
}
