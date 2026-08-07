import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import {
  enumeratePopulation,
  type EnumeratedUrl,
  type PatternRow
} from "./patternPopulation.js";
import type { SampleCheckResult } from "./sampleUrlCheck.js";
import { probeUrl, verifyConcurrency } from "./verifyProbe.js";
import type { VerifyUrlsJobData } from "../queue/verificationQueue.js";

// Full-population URL verification (verify-then-act, step 1).
//
// Sampling only ever HTTP-checks 5-20 URLs per pattern, so "Delete URLs" could
// only act on the sampled preview. This job enumerates EVERY URL belonging to
// the selected patterns from the actual sitemap XML on disk (NOT the capped
// pattern_urls pool), probes each one with the exact same checker sampling uses
// (checkSampleUrl: HEAD -> GET fallback -> soft-404 sniff), and upserts one
// verified_urls row per (session, url). Deletion then acts on the full verified
// set — see processDeleteProblemUrlsJob's use_verified path.
//
// SCOPE IS THE EXPENSIVE DECISION (v1.50). data.pattern_ids restricts the
// population to the patterns the user is actually working on. It was always
// plumbed through here, but the Fix modal never sent it, so every verification
// swept the whole session: a 25,744-URL pattern triggered a 1,324,310-URL run.
// Nothing about this job was slow — it was doing 51x the necessary work. The
// call site is fixed in the Fix modal, and the route now records the scope on
// the job row so a scoped run can never be confused with a session-wide one.
//
// Progress rides the maintenance_jobs row the route created, kind 'verify-urls'.
// FOR THIS KIND ONLY files_total / files_done carry URL counts, not file counts
// ("Verifying 187 of 269 URLs…") — the column names are inherited from the
// table, the meaning is documented here and in migration 038.

// The statuses the delete flow can act on; items_changed reports how many
// verified URLs carry one of these.
export const VERIFY_PROBLEM_STATUSES = [301, 302, 307, 308, 404];

// Persist progress every N completed checks so the status endpoint has
// something live without a DB write per URL.
const PROGRESS_FLUSH_EVERY = 25;

type SessionRow = {
  id: string;
  base_url: string;
  concurrency: number;
  user_agent: string;
};

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'FAILED', error = $2 WHERE id = $1",
    [jobRowId, message]
  );
}

// Batch-upsert check results. ON CONFLICT resets the verification columns but
// deliberately does NOT touch is_deleted_from_sitemap / deleted_from_files, so
// re-verification never un-deletes (or forgets the file scope of) a URL the
// user already removed.
async function upsertVerifiedBatch(
  sessionId: string,
  batch: Array<{ entry: EnumeratedUrl; result: SampleCheckResult }>
) {
  if (batch.length === 0) {
    return;
  }

  const values: string[] = [];
  const params: unknown[] = [sessionId];

  for (const { entry, result } of batch) {
    const base = params.length;

    params.push(
      entry.patternId,
      entry.url,
      result.httpStatus,
      result.httpStatusCategory,
      result.finalUrl,
      result.errorReason,
      Array.from(entry.sourceFiles).sort()
    );
    values.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::text[], now())`
    );
  }

  await pool.query(
    `
      INSERT INTO verified_urls (
        session_id,
        pattern_id,
        url,
        http_status,
        http_status_category,
        final_url,
        error_reason,
        source_files,
        checked_at
      )
      VALUES ${values.join(", ")}
      ON CONFLICT (session_id, url) DO UPDATE SET
        pattern_id = EXCLUDED.pattern_id,
        http_status = EXCLUDED.http_status,
        http_status_category = EXCLUDED.http_status_category,
        final_url = EXCLUDED.final_url,
        error_reason = EXCLUDED.error_reason,
        source_files = EXCLUDED.source_files,
        checked_at = EXCLUDED.checked_at
    `,
    params
  );
}

export async function processVerifyUrlsJob(
  data: VerifyUrlsJobData,
  logger: FastifyBaseLogger
) {
  const {
    session_id: sessionId,
    job_row_id: jobRowId,
    pattern_ids: patternIds,
    target_statuses: targetStatuses
  } = data;

  logger.info(
    {
      session_id: sessionId,
      job_row_id: jobRowId,
      pattern_ids: patternIds,
      scope: patternIds ? "patterns" : "session",
      target_statuses: targetStatuses
    },
    "verify urls job started"
  );

  const startedAtMs = Date.now();

  try {
    const sessionResult = await pool.query<SessionRow>(
      "SELECT id, base_url, concurrency, user_agent FROM sessions WHERE id = $1",
      [sessionId]
    );
    const session = sessionResult.rows[0];

    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const patternsResult = await pool.query<PatternRow>(
      patternIds
        ? `
          SELECT id, template
          FROM patterns
          WHERE session_id = $1 AND source_role = 'current' AND id = ANY($2::uuid[])
          ORDER BY template ASC
        `
        : `
          SELECT id, template
          FROM patterns
          WHERE session_id = $1 AND source_role = 'current'
          ORDER BY template ASC
        `,
      patternIds ? [sessionId, patternIds] : [sessionId]
    );
    const patterns = patternsResult.rows;

    // The DB clock stamps checked_at at flush time, so the stale-row sweep at
    // the end compares against the same clock — capture "before any check" now.
    const runStartedResult = await pool.query<{ now: string }>("SELECT now()");
    const runStarted = runStartedResult.rows[0].now;

    // RUNNING with an unknown total, before enumeration. Enumeration streams
    // every <loc> of every file (tens of seconds on a 1.3M-URL session), and
    // without this the row sits at PENDING throughout, so the modal shows
    // "Verifying 0 of 0" and looks hung. The client reads total = 0 while
    // RUNNING as the enumerating phase.
    await pool.query(
      "UPDATE maintenance_jobs SET status = 'RUNNING', files_total = 0, files_done = 0 WHERE id = $1",
      [jobRowId]
    );

    const enumerateStartedMs = Date.now();
    const population = await enumeratePopulation(sessionId, patterns, logger);
    const enumerateMs = Date.now() - enumerateStartedMs;

    // URLs already deleted from the sitemap keep their rows (restore needs
    // them) but are not re-probed: their live status is irrelevant while they
    // are not being served. Normally they aren't enumerated at all (they're
    // gone from the files); this also covers marks scoped to a subset of a
    // multi-file URL's files.
    const deletedResult = await pool.query<{ url: string }>(
      "SELECT url FROM verified_urls WHERE session_id = $1 AND is_deleted_from_sitemap = true",
      [sessionId]
    );
    const deletedUrls = new Set(deletedResult.rows.map((row) => row.url));

    const entries = Array.from(population.values());
    const toCheck = entries.filter((entry) => !deletedUrls.has(entry.url));
    const skippedDeleted = entries.length - toCheck.length;

    // urls_total is the FULL deduped population (files_total column — URL
    // semantics for this kind); already-deleted URLs count as done up front.
    await pool.query(
      "UPDATE maintenance_jobs SET status = 'RUNNING', files_total = $2, files_done = $3 WHERE id = $1",
      [jobRowId, entries.length, skippedDeleted]
    );

    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        patterns: patterns.length,
        scope: patternIds ? "patterns" : "session",
        urls_total: entries.length,
        skipped_deleted: skippedDeleted,
        // Separated from the HTTP phase so the two costs stay distinguishable
        // in the logs — the whole scoping fix was diagnosed from the fact that
        // urls_total, not enumeration, was the number out of proportion.
        enumerate_ms: enumerateMs,
        concurrency: verifyConcurrency(session.concurrency)
      },
      "verify urls: population enumerated, checking started"
    );

    // Pending upserts, flushed every PROGRESS_FLUSH_EVERY completions and once
    // at the end. splice(0) hands the current batch to one flusher atomically
    // (single-threaded between awaits), so concurrent onSettled calls never
    // double-write a row.
    let pending: Array<{ entry: EnumeratedUrl; result: SampleCheckResult }> = [];

    await runWithBoundedConcurrency(
      toCheck,
      // Clamped to config.verification.maxConcurrency. sessions.concurrency can
      // be set as high as 30, which is a defensible burst for a 20-URL sample
      // and is not defensible for a sustained sweep of someone else's
      // production origin. Rate is bounded separately, inside probeUrl.
      verifyConcurrency(session.concurrency),
      async (entry, index) => {
        // The loc itself is passed as source_url, so resolveSampleTarget applies
        // the same www-equivalence rule sampling uses when base_url and the
        // sitemap disagree about the host label.
        const result = await probeUrl(
          session.base_url,
          entry.url,
          session.user_agent,
          logger,
          {
            sessionId,
            patternId: entry.patternId,
            template: entry.template,
            sampleIndex: index
          }
        );

        return { entry, result };
      },
      async (settled, completed, _total) => {
        pending.push(settled);

        if (completed % PROGRESS_FLUSH_EVERY === 0) {
          const batch = pending.splice(0);

          await upsertVerifiedBatch(sessionId, batch);
          await pool.query(
            "UPDATE maintenance_jobs SET files_done = $2 WHERE id = $1",
            [jobRowId, skippedDeleted + completed]
          );
        }
      }
    );

    // Flush the final partial batch.
    await upsertVerifiedBatch(sessionId, pending.splice(0));

    // Re-verification sweep: rows for the SAME selected patterns whose url was
    // NOT re-enumerated this run no longer exist in the files — drop them so the
    // table mirrors reality. Keyed on checked_at (every enumerated url just got
    // it reset) rather than a giant NOT IN url array. Deleted-from-sitemap rows
    // are kept: restore needs them.
    const sweepPatternIds = patterns.map((pattern) => pattern.id);

    if (sweepPatternIds.length > 0) {
      const swept = await pool.query(
        `
          DELETE FROM verified_urls
          WHERE session_id = $1
            AND pattern_id = ANY($2::uuid[])
            AND is_deleted_from_sitemap = false
            AND (checked_at IS NULL OR checked_at < $3::timestamptz)
        `,
        [sessionId, sweepPatternIds, runStarted]
      );

      if (swept.rowCount) {
        logger.info(
          { session_id: sessionId, job_row_id: jobRowId, swept: swept.rowCount },
          "verify urls: swept rows for urls no longer present in files"
        );
      }
    }

    // items_changed = URLs the delete flow can act on. Normally every problem
    // status; for a status-scoped run ("Verify 404s") only the statuses asked
    // for, so the completion number is the EXACT count of the thing the user
    // asked about rather than a total they then have to re-filter.
    //
    // A status-scoped run still probes the whole scoped population — it has to,
    // since a URL's status is not knowable without asking for it. The filter
    // narrows what is REPORTED, not what is checked. Triage is the layer that
    // avoids the work.
    const countedStatuses =
      targetStatuses && targetStatuses.length > 0
        ? targetStatuses
        : VERIFY_PROBLEM_STATUSES;
    const problemResult = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM verified_urls
        WHERE session_id = $1
          AND pattern_id = ANY($2::uuid[])
          AND is_deleted_from_sitemap = false
          AND http_status = ANY($3::int[])
      `,
      [sessionId, sweepPatternIds, countedStatuses]
    );
    const problemCount = Number(problemResult.rows[0]?.count ?? 0);

    await pool.query(
      `
        UPDATE maintenance_jobs
        SET status = 'COMPLETE', files_done = files_total, items_changed = $2, completed_at = now()
        WHERE id = $1
      `,
      [jobRowId, problemCount]
    );

    const durationMs = Date.now() - startedAtMs;

    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        scope: patternIds ? "patterns" : "session",
        patterns: patterns.length,
        urls_total: entries.length,
        urls_checked: toCheck.length,
        counted_statuses: countedStatuses,
        problem_urls: problemCount,
        enumerate_ms: enumerateMs,
        duration_ms: durationMs,
        // The measurement that made the original bug diagnosable, kept as a
        // first-class field: divide it into a future slow report before
        // assuming the checker got slower.
        checks_per_second:
          durationMs > 0
            ? Math.round((toCheck.length / (durationMs / 1000)) * 100) / 100
            : 0
      },
      "verify urls job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await markFailed(jobRowId, message);
    throw error;
  }
}
