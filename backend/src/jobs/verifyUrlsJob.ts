import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import { displaySourceFilename, isHttpUrl } from "../sitemaps/filenames.js";
import { streamSitemapUrlLocs } from "../sitemaps/parser.js";
import { pathMatchesTemplate } from "../sitemaps/rewriteLocs.js";
import { checkSampleUrl, type SampleCheckResult } from "./sampleUrlCheck.js";
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

type PatternRow = {
  id: string;
  template: string;
};

type EnumeratedUrl = {
  url: string;
  patternId: string;
  template: string;
  sourceFiles: Set<string>;
};

async function markFailed(jobRowId: string, message: string) {
  await pool.query(
    "UPDATE maintenance_jobs SET status = 'FAILED', error = $2 WHERE id = $1",
    [jobRowId, message]
  );
}

// Enumerate the verification population: stream every <loc> of every current,
// non-deleted, valid, local sitemap file and keep the ones whose pathname
// matches a selected pattern template (first match wins — same one-URL-one-
// pattern rule extraction uses). Deduped by the exact <loc> string, because
// that string is what the deletion engine matches byte-for-byte; the set of
// display files that contained it is recorded for the delete job's file scope.
async function enumeratePopulation(
  sessionId: string,
  patterns: PatternRow[],
  logger: FastifyBaseLogger
): Promise<Map<string, EnumeratedUrl>> {
  const filesResult = await pool.query<{ id: string; filename: string }>(
    `
      SELECT id, filename
      FROM sitemap_files
      WHERE session_id = $1
        AND source_role = 'current'
        AND is_deleted = false
        AND is_valid = true
      ORDER BY filename ASC
    `,
    [sessionId]
  );
  const files = filesResult.rows.filter((row) => !isHttpUrl(row.filename));
  const population = new Map<string, EnumeratedUrl>();

  for (const file of files) {
    const display = displaySourceFilename(sessionId, file.filename);

    try {
      await streamSitemapUrlLocs(file.filename, (loc) => {
        const existing = population.get(loc);

        if (existing) {
          existing.sourceFiles.add(display);
          return;
        }

        let pathname: string;

        try {
          pathname = new URL(loc).pathname;
        } catch {
          // Not a parseable absolute URL — it can't be probed or matched.
          return;
        }

        // First matching selected template wins; a loc matching none is not
        // part of the population.
        const matched = patterns.find((pattern) =>
          pathMatchesTemplate(pathname, pattern.template)
        );

        if (!matched) {
          return;
        }

        population.set(loc, {
          url: loc,
          patternId: matched.id,
          template: matched.template,
          sourceFiles: new Set([display])
        });
      });
    } catch (error) {
      // Missing on disk (cleaned up) or unreadable — skip like the deletion
      // rebuild does, but say so: a silently skipped file shrinks the population.
      logger.warn(
        { session_id: sessionId, filename: file.filename, error },
        "verify urls: could not stream file, skipping"
      );
    }
  }

  return population;
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
    pattern_ids: patternIds
  } = data;

  logger.info(
    { session_id: sessionId, job_row_id: jobRowId, pattern_ids: patternIds },
    "verify urls job started"
  );

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

    const population = await enumeratePopulation(sessionId, patterns, logger);

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
        urls_total: entries.length,
        skipped_deleted: skippedDeleted
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
      Math.max(1, session.concurrency),
      async (entry, index) => {
        // checkSampleUrl never throws — failures come back classified
        // (timeout/ssl_cert/no_response), which is what we want persisted.
        let path: string;

        try {
          const url = new URL(entry.url);

          path = `${url.pathname}${url.search}`;
        } catch {
          path = entry.url;
        }

        // The loc itself is passed as source_url, so resolveSampleTarget applies
        // the same www-equivalence rule sampling uses when base_url and the
        // sitemap disagree about the host label.
        const result = await checkSampleUrl(
          session.base_url,
          path,
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

    // items_changed = URLs with a problem status among what this run verified —
    // the number the delete flow can act on.
    const problemResult = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM verified_urls
        WHERE session_id = $1
          AND pattern_id = ANY($2::uuid[])
          AND is_deleted_from_sitemap = false
          AND http_status = ANY($3::int[])
      `,
      [sessionId, sweepPatternIds, VERIFY_PROBLEM_STATUSES]
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

    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        urls_total: entries.length,
        problem_urls: problemCount
      },
      "verify urls job complete"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await markFailed(jobRowId, message);
    throw error;
  }
}
