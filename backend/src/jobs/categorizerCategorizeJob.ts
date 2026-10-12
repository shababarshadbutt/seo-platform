import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  buildDepthBoundaryLookup,
  categorizeRfq,
  categorizeUrl,
  DepthBoundaryDetector,
  pathSegmentsFromUrl
} from "../sitemaps/categorizer.js";
import {
  enqueueCategorizerCategorizeContinuation,
  type CategorizerCategorizeJobData
} from "../queue/categorizerQueue.js";
import {
  latestCategorizerJob,
  markCategorizerJobComplete,
  markCategorizerJobRunning,
  startOrResumeCategorizerJob,
  updateCategorizerJobCheckpoint,
  updateCategorizerSessionStatus
} from "./categorizerJobState.js";

// Categorize phase: classify every status-checked, non-404 URL (doc sections
// 3 and 4 — see sitemaps/categorizer.ts for the rules themselves). Two
// sub-passes over the SAME streamed, keyset-paginated population, because
// depth detection needs a FINALIZED boundary map before any URL can be
// assigned a filename — see DepthBoundaryDetector's own notes on why.
//
//   1. "detect" — stream every eligible URL once, feeding non-RFQ ones into a
//      DepthBoundaryDetector. RFQ-shaped URLs are excluded from this pass so
//      literal RFQ path segments ("rfq", "nsn") never pollute the regular
//      depth statistics. RESTARTS ON RESUME rather than resuming mid-pass: it
//      is pure DB-read + in-memory compute (no HTTP), so a full rescan is
//      cheap relative to the status-check phase, and the detector's tracker
//      state is not worth serializing across a worker restart for that
//      saving. Finishes by persisting the resolved boundaries into the job's
//      checkpoint, once, as plain data (bounded by distinct static prefixes).
//   2. "assign" — stream every eligible URL again (category_state='pending'),
//      classify it against the now-finalized boundaries, and write
//      rule_matched + category_state='categorized'. THIS sub-pass is fully
//      resumable by its own keyset cursor, same as the status-check phase.
//
// 404 EXCLUSION HAPPENS IN THE QUERY, not as a later filter: both sub-passes
// select "http_status IS DISTINCT FROM 404" (not just "<> 404", which a NULL
// http_status — an unchecked row — would also satisfy) AND
// "check_state = 'checked'", so a URL that was never verified can never be
// silently treated as non-404 and categorized.

type CategorizerSessionRow = {
  id: string;
};

type CategorizeCheckpoint = {
  pass?: "detect" | "assign";
  last_id?: number;
  boundaries?: string[][];
};

type EligibleUrlRow = {
  id: string;
  url: string;
};

export async function processCategorizerCategorizeJob(
  data: CategorizerCategorizeJobData,
  logger: FastifyBaseLogger,
  job?: Job
) {
  const { session_id: sessionId } = data;

  const sessionResult = await pool.query<CategorizerSessionRow>(
    "SELECT id FROM categorizer_sessions WHERE id = $1",
    [sessionId]
  );

  if (!sessionResult.rows[0]) {
    throw new Error(`Categorizer session not found: ${sessionId}`);
  }

  const statusCheckJob = await latestCategorizerJob(sessionId, "status-check");

  if (!statusCheckJob || statusCheckJob.status !== "COMPLETE") {
    throw new Error(
      "Cannot categorize before the status-check phase has completed for this session"
    );
  }

  const jobRow = await startOrResumeCategorizerJob(sessionId, "categorize");
  const checkpoint = jobRow.checkpoint as CategorizeCheckpoint;

  await updateCategorizerSessionStatus(sessionId, "CATEGORIZING");

  const totalResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categorizer_urls
     WHERE session_id = $1 AND check_state = 'checked' AND http_status IS DISTINCT FROM 404`,
    [sessionId]
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);

  await markCategorizerJobRunning(jobRow.id, total);

  const batchSize = config.categorizerCrawl.batchSize;
  const chunkDeadlineMs = Date.now() + config.categorizerCrawl.chunkMinutes * 60 * 1000;

  let pass: "detect" | "assign" = checkpoint.pass ?? "detect";
  let boundaries = checkpoint.boundaries ?? null;

  if (pass === "detect") {
    const detector = new DepthBoundaryDetector();
    let lastId = 0;
    let scanned = 0;

    for (;;) {
      if (Date.now() > chunkDeadlineMs) {
        await enqueueCategorizerCategorizeContinuation({ session_id: sessionId });
        logger.info(
          { session_id: sessionId, scanned, total },
          "categorizer categorize: detect pass time box reached, continuation enqueued (restarts the detect pass)"
        );

        return { continued: true, pass: "detect", scanned, total };
      }

      const batch = await pool.query<EligibleUrlRow>(
        `
          SELECT id::text AS id, url
          FROM categorizer_urls
          WHERE session_id = $1 AND check_state = 'checked'
            AND http_status IS DISTINCT FROM 404 AND id > $2
          ORDER BY id
          LIMIT $3
        `,
        [sessionId, lastId, batchSize]
      );

      if (batch.rows.length === 0) {
        break;
      }

      for (const row of batch.rows) {
        const segments = pathSegmentsFromUrl(row.url);

        if (segments && !categorizeRfq(segments)) {
          detector.observe(segments);
        }
      }

      lastId = Number(batch.rows[batch.rows.length - 1].id);
      scanned += batch.rows.length;
      await job?.updateProgress({
        stage: "detect-boundaries",
        current: scanned,
        total,
        message: `Detecting category depth (${scanned} of ${total} URL(s) scanned)`
      });
    }

    boundaries = detector.boundaries();
    pass = "assign";
    await updateCategorizerJobCheckpoint(
      jobRow.id,
      { pass: "assign", last_id: 0, boundaries },
      0
    );

    logger.info(
      { session_id: sessionId, boundary_count: boundaries.length },
      "categorizer categorize: depth boundaries resolved"
    );
  }

  const boundaryLookup = buildDepthBoundaryLookup(boundaries ?? []);
  let lastId = checkpoint.pass === "assign" ? checkpoint.last_id ?? 0 : 0;
  let doneCount = jobRow.items_done;

  for (;;) {
    if (Date.now() > chunkDeadlineMs) {
      await enqueueCategorizerCategorizeContinuation({ session_id: sessionId });
      logger.info(
        { session_id: sessionId, last_id: lastId, done: doneCount, total },
        "categorizer categorize: assign pass time box reached, continuation enqueued"
      );

      return { continued: true, pass: "assign", done: doneCount, total };
    }

    const batch = await pool.query<EligibleUrlRow>(
      `
        SELECT id::text AS id, url
        FROM categorizer_urls
        WHERE session_id = $1 AND check_state = 'checked'
          AND http_status IS DISTINCT FROM 404 AND category_state = 'pending'
          AND id > $2
        ORDER BY id
        LIMIT $3
      `,
      [sessionId, lastId, batchSize]
    );

    if (batch.rows.length === 0) {
      break;
    }

    const values: string[] = [];
    const params: unknown[] = [sessionId];

    for (const row of batch.rows) {
      const result = categorizeUrl(row.url, boundaryLookup);
      // The un-chunked base name the generate phase groups by — strip the
      // ".xml" categorizeUrl's result carries for display, since chunking
      // (categoryOutputFilename.ts) re-derives the real per-chunk filename
      // from this base plus a 1-based index.
      const category = result.filename.replace(/\.xml$/, "");
      const base = params.length;

      params.push(row.id, result.ruleId, category);
      values.push(`($${base + 1}::bigint, $${base + 2}, $${base + 3})`);
    }

    await pool.query(
      `
        UPDATE categorizer_urls AS u
        SET rule_matched = v.rule_matched, category = v.category, category_state = 'categorized'
        FROM (VALUES ${values.join(", ")}) AS v(id, rule_matched, category)
        WHERE u.session_id = $1 AND u.id = v.id
      `,
      params
    );

    lastId = Number(batch.rows[batch.rows.length - 1].id);
    doneCount += batch.rows.length;

    await updateCategorizerJobCheckpoint(
      jobRow.id,
      { pass: "assign", last_id: lastId, boundaries },
      doneCount
    );
    await job?.updateProgress({
      stage: "categorizing",
      current: doneCount,
      total,
      message: `Categorized ${doneCount} of ${total} URL(s)`
    });
  }

  await markCategorizerJobComplete(jobRow.id);
  await updateCategorizerSessionStatus(sessionId, "CATEGORIZED");

  logger.info(
    { session_id: sessionId, total, done: doneCount },
    "categorizer categorize complete"
  );

  return { done: doneCount, total };
}
