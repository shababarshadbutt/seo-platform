import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { writeBatchWithFaultIsolation } from "../sitemaps/batchWriteFaultIsolation.js";
import {
  buildDepthBoundaryLookup,
  categorizeRfq,
  categorizeUrl,
  DepthBoundaryDetector,
  pathSegmentsFromUrl,
  type SerializedDepthBoundaryDetector
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

// Categorize phase: classify every ingested URL by path structure (doc
// sections 3 and 4 — see sitemaps/categorizer.ts for the rules themselves).
// Runs right after ingest, BEFORE status-check: categorization only looks at
// a URL's path shape, never its HTTP status, so it does not need to wait
// behind a full per-URL crawl that is not viable at tens-of-millions-of-URLs
// scale. Two sub-passes over the SAME streamed, keyset-paginated population,
// because depth detection needs a FINALIZED boundary map before any URL can
// be assigned a filename — see DepthBoundaryDetector's own notes on why.
//
//   1. "detect" — stream every eligible URL once, feeding non-RFQ ones into a
//      DepthBoundaryDetector. RFQ-shaped URLs are excluded from this pass so
//      literal RFQ path segments ("rfq", "nsn") never pollute the regular
//      depth statistics. RESUMABLE BY ITS OWN KEYSET CURSOR, same shape as
//      "assign" below: a full rescan looked cheap (pure DB-read + in-memory
//      compute, no HTTP) but at tens-of-millions-of-URLs scale one pass can
//      outlast chunkMinutes, and restarting at id=0 every time then NEVER
//      finishes — the detector's tracker state is bounded by distinct static
//      prefixes (see DepthBoundaryDetector.serialize), so checkpointing it is
//      cheap. Finishes by persisting the resolved boundaries into the job's
//      checkpoint, once, as plain data.
//   2. "assign" — stream every eligible URL again (category_state='pending'),
//      classify it against the now-finalized boundaries, and write
//      rule_matched + category_state='categorized'. THIS sub-pass is fully
//      resumable by its own keyset cursor, same as the status-check phase.
//
// ASSIGN WRITES ARE FAULT-ISOLATED (batchWriteFaultIsolation.ts). A batch is
// written as one multi-row UPDATE for throughput, but if a row's bound value
// can't be written (e.g. a corrupted id failing its ::bigint cast), that row
// alone is bisected out, marked category_state='failed' with the error
// captured, and the batch's other rows still write normally — one bad row no
// longer aborts the whole phase. The recovery write matches by (session_id,
// url), not id, specifically so marking a row 'failed' can't hit the exact
// same cast failure that got it isolated in the first place.
//
// 404 EXCLUSION NO LONGER HAPPENS HERE. It used to be a query filter
// ("check_state='checked' AND http_status IS DISTINCT FROM 404"), back when
// status-check ran first — that's gone now that status isn't known yet at
// categorize time. Instead, the status-check phase (sampled or full, run
// AFTER this one) flips a confirmed-404 URL's category_state to 'excluded'
// directly, which categorizerGenerateJob.ts's existing
// "category_state = 'categorized'" query already skips — see
// categorizerStatusSampleJob.ts.

type CategorizerSessionRow = {
  id: string;
};

type CategorizeCheckpoint = {
  pass?: "detect" | "assign";
  last_id?: number;
  boundaries?: string[][];
  trackers?: SerializedDepthBoundaryDetector;
};

type EligibleUrlRow = {
  id: string;
  url: string;
};

type AssignRow = {
  id: string;
  url: string;
  ruleMatched: string;
  category: string;
};

async function writeAssignBatch(sessionId: string, rows: AssignRow[]): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [sessionId];

  for (const row of rows) {
    const base = params.length;

    params.push(row.id, row.ruleMatched, row.category);
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
}

// Matches by (session_id, url) — NOT id — so recovering a row that failed its
// own ::bigint cast doesn't immediately hit that same cast failure again.
async function markAssignRowFailed(
  sessionId: string,
  row: AssignRow,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  await pool.query(
    `UPDATE categorizer_urls SET category_state = 'failed', error = $3
     WHERE session_id = $1 AND url = $2`,
    [sessionId, row.url, message]
  );
}

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

  const ingestJob = await latestCategorizerJob(sessionId, "ingest");

  if (!ingestJob || ingestJob.status !== "COMPLETE") {
    throw new Error(
      "Cannot categorize before the ingest phase has completed for this session"
    );
  }

  const jobRow = await startOrResumeCategorizerJob(sessionId, "categorize");
  const checkpoint = jobRow.checkpoint as CategorizeCheckpoint;

  await updateCategorizerSessionStatus(sessionId, "CATEGORIZING");

  const totalResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1`,
    [sessionId]
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);

  await markCategorizerJobRunning(jobRow.id, total);

  const batchSize = config.categorizerCrawl.batchSize;
  const chunkDeadlineMs = Date.now() + config.categorizerCrawl.chunkMinutes * 60 * 1000;

  let pass: "detect" | "assign" = checkpoint.pass ?? "detect";
  let boundaries = checkpoint.boundaries ?? null;

  const resumingDetect = checkpoint.pass === "detect";

  if (pass === "detect") {
    const detector =
      resumingDetect && checkpoint.trackers
        ? DepthBoundaryDetector.fromSerialized(checkpoint.trackers)
        : new DepthBoundaryDetector();
    let lastId = resumingDetect ? checkpoint.last_id ?? 0 : 0;
    let scanned = resumingDetect ? Number(jobRow.items_done) : 0;

    for (;;) {
      if (Date.now() > chunkDeadlineMs) {
        await updateCategorizerJobCheckpoint(
          jobRow.id,
          { pass: "detect", last_id: lastId, trackers: detector.serialize() },
          scanned
        );
        await enqueueCategorizerCategorizeContinuation({ session_id: sessionId });
        logger.info(
          { session_id: sessionId, scanned, total },
          "categorizer categorize: detect pass time box reached, continuation enqueued (resumes from last_id)"
        );

        return { continued: true, pass: "detect", scanned, total };
      }

      const batch = await pool.query<EligibleUrlRow>(
        `
          SELECT id::text AS id, url
          FROM categorizer_urls
          WHERE session_id = $1 AND id > $2
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

      await updateCategorizerJobCheckpoint(
        jobRow.id,
        { pass: "detect", last_id: lastId, trackers: detector.serialize() },
        scanned
      );
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
  const resumingAssign = checkpoint.pass === "assign";
  let lastId = resumingAssign ? checkpoint.last_id ?? 0 : 0;
  // jobRow.items_done reflects whatever state existed when this job row was
  // fetched, BEFORE the detect pass above ran — for a resumed detect pass
  // that's its (unrelated) scanned-URL count, not an assign count. Only trust
  // it when this run is actually resuming an already-in-progress assign pass;
  // every other path (fresh job, or just-finished detect falling through)
  // starts assign at 0, matching the checkpoint reset above.
  let doneCount = resumingAssign ? Number(jobRow.items_done) : 0;

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
        WHERE session_id = $1 AND category_state = 'pending' AND id > $2
        ORDER BY id
        LIMIT $3
      `,
      [sessionId, lastId, batchSize]
    );

    if (batch.rows.length === 0) {
      break;
    }

    const assignRows: AssignRow[] = batch.rows.map((row) => {
      const result = categorizeUrl(row.url, boundaryLookup);
      // The un-chunked base name the generate phase groups by — strip the
      // ".xml" categorizeUrl's result carries for display, since chunking
      // (categoryOutputFilename.ts) re-derives the real per-chunk filename
      // from this base plus a 1-based index.
      const category = result.filename.replace(/\.xml$/, "");

      return { id: row.id, url: row.url, ruleMatched: result.ruleId, category };
    });

    await writeBatchWithFaultIsolation(
      assignRows,
      (rows) => writeAssignBatch(sessionId, rows),
      async (row, error) => {
        logger.warn(
          {
            session_id: sessionId,
            url: row.url,
            error: error instanceof Error ? error.message : String(error)
          },
          "categorizer categorize: row failed to write, marking category_state='failed' and continuing"
        );
        await markAssignRowFailed(sessionId, row, error);
      }
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

  // Recomputed from the table rather than accumulated in-memory: a chunked
  // run can span several job attempts (time-boxed continuations), so an
  // in-memory counter would reset to 0 on every continuation and undercount.
  const failedResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND category_state = 'failed'`,
    [sessionId]
  );
  const failedCount = Number(failedResult.rows[0]?.count ?? 0);

  await markCategorizerJobComplete(jobRow.id, failedCount);
  await updateCategorizerSessionStatus(sessionId, "CATEGORIZED");

  logger.info(
    { session_id: sessionId, total, done: doneCount, failed: failedCount },
    "categorizer categorize complete"
  );

  return { done: doneCount, total };
}
