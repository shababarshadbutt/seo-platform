import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { runWithBoundedConcurrency } from "../sitemaps/boundedConcurrency.js";
import {
  coverageFromVerdicts,
  DEFAULT_SHAPE_SAMPLE,
  judgeStratum,
  ShapeReservoir,
  sweepablePatternIds
} from "./shapeStrata.js";
import { sampleShapesForPattern } from "./shapeSampleScan.js";
import { valueShape } from "../sitemaps/transformDryRun.js";
import {
  enumeratePopulation,
  type EnumeratedUrl,
  type PatternRow
} from "./patternPopulation.js";
import {
  isRealMeasurement,
  type RequestProfile,
  type SampleCheckResult
} from "./sampleUrlCheck.js";
import { resolveSampleTarget } from "./sampleTarget.js";
import { probeUrl, verifyConcurrency, verifyTargetFor } from "./verifyProbe.js";
import { rateLimitHostKey } from "../http/hostRateLimiter.js";
import type { ResolvedHostStrategy } from "../http/hostStrategy.js";
import { createHostStrategyRun } from "../http/hostStrategyRun.js";
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

// "This stored verdict still describes what is in the files" — ONE definition,
// used by the two queries that must agree about it.
//
// WHY IT IS SHARED AND NOT WRITTEN TWICE. The reuse filter uses it to decide
// what NOT to re-probe, and the stale-row sweep below uses it to decide what NOT
// to delete. If those two ever disagree, the run reuses a row and then deletes
// it in the same pass — which is exactly what happened when reuse was first
// added: the sweep keys on `checked_at < runStarted` on the assumption that
// "every enumerated url just got checked_at reset", and a reused row by
// definition did not. The result was a re-verify that wiped every verdict it had
// just decided to trust and reported zero problems.
//
// $1 = session id, and the caller supplies the reuse window in hours as the
// named parameter it interpolates. A window of 0 disables reuse, so the
// predicate is false for every row and both queries revert to their old
// behaviour exactly.
const REUSABLE_VERDICT_SQL = `
  $WINDOW$::int > 0
  AND v.checked_at IS NOT NULL
  AND v.checked_at > COALESCE(s.files_mutated_at, 'epoch'::timestamptz)
  AND v.checked_at > now() - ($WINDOW$ || ' hours')::interval
`;

// Persist progress every N completed checks so the status endpoint has
// something live without a DB write per URL.
const PROGRESS_FLUSH_EVERY = 25;

// Same intent as PROGRESS_FLUSH_EVERY, but TIME-based rather than count-based,
// because the enumeration phase's unit cost is nothing like a URL check's. One
// file can be 50 locs or 500,000, so "every 25 files" is somewhere between a
// write storm and a bar that never moves depending on the session. A wall-clock
// interval bounds the writes to ~1/sec regardless of file size or file count —
// on a 10,000-file session that is seconds' worth of writes, not 10,000 of them.
const ENUM_PROGRESS_FLUSH_MS = 1000;

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
      Array.from(entry.sourceFiles).sort(),
      // Which network path measured this URL (mig 045).
      result.viaPrivateRoute
    );
    values.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::text[], now(), $${base + 8})`
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
        checked_at,
        via_private_route
      )
      VALUES ${values.join(", ")}
      ON CONFLICT (session_id, url) DO UPDATE SET
        pattern_id = EXCLUDED.pattern_id,
        http_status = EXCLUDED.http_status,
        http_status_category = EXCLUDED.http_status_category,
        final_url = EXCLUDED.final_url,
        error_reason = EXCLUDED.error_reason,
        source_files = EXCLUDED.source_files,
        checked_at = EXCLUDED.checked_at,
        via_private_route = EXCLUDED.via_private_route
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
    // The scope rides on every selected pattern rather than as a separate
    // argument: enumeratePopulation decides membership per pattern, and the
    // modal that sends a structure scope always sends exactly one pattern id.
    const structureFilters = data.structure_filters ?? null;
    const patterns = patternsResult.rows.map((row) => ({
      ...row,
      structureFilters
    }));

    // The DB clock stamps checked_at at flush time, so the stale-row sweep at
    // the end compares against the same clock — capture "before any check" now.
    const runStartedResult = await pool.query<{ now: string }>("SELECT now()");
    const runStarted = runStartedResult.rows[0].now;

    // RUNNING with an unknown URL total, before enumeration. The zeroing is a
    // RESET, not a placeholder — this row may be a re-run, and stale counters
    // from the previous attempt would render as a live "Verifying X of Y". The
    // client still reads files_total = 0 while RUNNING as "not in the URL phase
    // yet"; what changed in v1.53 is that the phase is no longer SILENT, because
    // enum_files_* below carry real per-file progress through it.
    //
    // enum_* start NULL rather than 0 so the brief window before the file list
    // is known renders as the plain spinner instead of a bogus "0 of 0".
    await pool.query(
      `UPDATE maintenance_jobs
         SET status = 'RUNNING', files_total = 0, files_done = 0,
             enum_files_total = NULL, enum_files_done = NULL
       WHERE id = $1`,
      [jobRowId]
    );

    // Throttled, fire-and-forget enumeration progress.
    //
    // NOT awaited inside the loop: enumeratePopulation's callback is synchronous
    // by contract, and awaiting a DB round trip per file would put the write
    // latency directly into enumeration's critical path. inFlight collapses
    // overlapping writes instead of queueing them, so a slow DB degrades to
    // fewer progress updates rather than to a growing backlog of them.
    //
    // Failures are swallowed deliberately: this is a progress cosmetic, and a
    // transient write error must not fail a verification run that is otherwise
    // proceeding correctly.
    let enumLastFlushMs = 0;
    let enumWriteInFlight = false;
    // The most recent write, kept so it can be settled before the columns are
    // cleared below. Without this, a write issued for the final file could land
    // AFTER the clearing statement and resurrect enum_files_* on a row that has
    // already moved to the URL phase — leaving the client rendering enumeration
    // progress for the rest of the run.
    let enumLastWrite: Promise<unknown> = Promise.resolve();

    const flushEnumProgress = (filesDone: number, filesTotal: number) => {
      enumWriteInFlight = true;

      enumLastWrite = pool
        .query(
          "UPDATE maintenance_jobs SET enum_files_total = $2, enum_files_done = $3 WHERE id = $1",
          [jobRowId, filesTotal, filesDone]
        )
        .catch(() => {})
        .finally(() => {
          enumWriteInFlight = false;
        });
    };

    const onEnumProgress = (filesDone: number, filesTotal: number) => {
      const nowMs = Date.now();
      // Always publish the first call (it carries the denominator) and the last
      // (so the bar reaches 100% rather than stopping mid-way); throttle between.
      const isFirst = filesDone === 0;
      const isLast = filesTotal > 0 && filesDone === filesTotal;

      if (
        !isFirst &&
        !isLast &&
        (enumWriteInFlight || nowMs - enumLastFlushMs < ENUM_PROGRESS_FLUSH_MS)
      ) {
        return;
      }

      enumLastFlushMs = nowMs;
      flushEnumProgress(filesDone, filesTotal);
    };

    // STRATIFIED RUNS DO NOT ENUMERATE (v1.69.1).
    //
    // enumeratePopulation reads every sitemap file in the SESSION and builds a
    // Map of the whole population. Once probing is cut to ~50 URLs per shape that
    // scan is the entire wall clock — and below POPULATION_PARALLEL_THRESHOLD it
    // runs inline on one thread, which is how a "quick shape check" on a 3-file
    // session sat for 15 minutes to then look at 1,150 URLs.
    //
    // The sampled path streams only the files the PATTERN's URLs live in and
    // keeps a bounded reservoir per shape, so the population is counted without
    // ever being held. Everything downstream — the deleted filter, the reuse
    // filter, the circuit breaker, the probe loop — is unchanged: it just receives
    // a much smaller map.
    //
    // Requires exactly one pattern. Shapes and their populations are recorded
    // against a single pattern_id, and the route rejects a stratified request
    // that does not name one; this is the belt to that braces.
    const stratified = data.strategy === "stratified" && patterns.length === 1;
    const shapeSample = data.shape_sample ?? DEFAULT_SHAPE_SAMPLE;
    let reservoir: ShapeReservoir | null = null;

    const enumerateStartedMs = Date.now();
    let population: Map<string, EnumeratedUrl>;

    if (stratified) {
      const pattern = patterns[0];
      const sampled = await sampleShapesForPattern({
        sessionId,
        patternId: pattern.id,
        sourceRole: "current",
        template: pattern.template,
        structureFilters: pattern.structureFilters ?? [],
        sampleSize: shapeSample,
        onProgress: onEnumProgress
      });

      reservoir = sampled.reservoir;
      population = new Map(
        reservoir.sampledUrls().map((url) => [
          url,
          {
            url,
            patternId: pattern.id,
            template: pattern.template,
            // The sampled path does not track which file each loc came from.
            // sourceFiles only feeds the verified_urls row's file list, and for a
            // SAMPLE that list would be a partial answer presented as a complete
            // one — an empty set is the honest version. The delete flow derives
            // its file scope from this column, so a partial one would silently
            // narrow a later deletion.
            sourceFiles: new Set<string>()
          }
        ])
      );

      logger.info(
        {
          session_id: sessionId,
          pattern_id: pattern.id,
          files_scanned: sampled.filesScanned,
          files_skipped: sampled.filesSkipped,
          shapes: reservoir.shapeCount,
          population: reservoir.totalPopulation,
          probing: population.size,
          shape_sample: shapeSample
        },
        "verify urls: sampled by shape, population not enumerated"
      );
    } else {
      population = await enumeratePopulation(
        sessionId,
        patterns,
        logger,
        onEnumProgress
      );
    }

    const enumerateMs = Date.now() - enumerateStartedMs;

    // Settle the last progress write before anything clears enum_files_*, so
    // the clear cannot be overwritten by a write that was already in flight.
    await enumLastWrite;

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

    // URLs whose stored verdict is still good, so they need no request at all.
    //
    // At 5 requests/second the HTTP phase is the entire cost of a run, and a
    // re-verify used to repeat all of it — including for URLs measured minutes
    // earlier. Fix-then-recheck is the common workflow, so the run someone is
    // actually waiting on was the one paying full price to re-confirm what it
    // already knew.
    //
    // TWO CONDITIONS, and the first is correctness, not freshness:
    //   * checked_at > sessions.files_mutated_at — the files have not changed
    //     since the measurement. This is the SAME predicate the Fix modal calls
    //     "stale", so an edit, a rename or an applied redirect invalidates the
    //     cache automatically and no code has to remember to clear it.
    //   * checked_at > now() - reuseWindowHours — the files may be untouched
    //     while the SITE changed underneath us.
    //
    // A NULL files_mutated_at means nothing has ever been edited, which does not
    // block reuse — hence the COALESCE to an always-older timestamp rather than
    // letting the comparison go NULL and silently exclude every row.
    const reuseWindowHours = config.verification.reuseWindowHours;
    const reusableUrls = new Set<string>();

    if (reuseWindowHours > 0) {
      const reusableResult = await pool.query<{ url: string }>(
        `
          SELECT v.url
          FROM verified_urls v
          JOIN sessions s ON s.id = v.session_id
          WHERE v.session_id = $1
            AND v.is_deleted_from_sitemap = false
            AND ${REUSABLE_VERDICT_SQL.replaceAll("$WINDOW$", "$2")}
        `,
        [sessionId, String(reuseWindowHours)]
      );

      for (const row of reusableResult.rows) {
        reusableUrls.add(row.url);
      }
    }

    const entries = Array.from(population.values());
    const notDeleted = entries.filter(
      (entry) => !deletedUrls.has(entry.url) && !reusableUrls.has(entry.url)
    );
    // Counted against the enumerated population, not against the query above:
    // that query is session-wide, while this run may be scoped to one pattern.
    const skippedReused = entries.filter(
      (entry) => !deletedUrls.has(entry.url) && reusableUrls.has(entry.url)
    ).length;

    // THE CIRCUIT BREAKER, on the path where it saves the most.
    //
    // Resolve the host's request strategy ONCE (at most three probes, using a URL
    // from the population itself), then drop every URL whose host refused all of
    // them. On a fully-refused 1.3M-URL site that turns ~2.6M requests over several
    // days into three — and the reason is reported once instead of being spread
    // across 1.3M individually unremarkable rows.
    //
    // Sampling usually resolved this host already; the run-level memo and Redis both
    // return that answer, so this normally costs no requests at all.
    const strategyRun = createHostStrategyRun(session.user_agent, logger, {
      sessionId,
      phase: "verification"
    });
    const ladderByHost = new Map<string, RequestProfile[] | undefined>();
    const toCheck: EnumeratedUrl[] = [];
    let refusedByHost = 0;
    // Counted per host, EMITTED ONCE PER HOST after this loop. See the note at the
    // emit — this loop body runs up to 1.3M times.
    const refusedPerHost = new Map<string, { count: number; strategy: ResolvedHostStrategy }>();

    for (const entry of notDeleted) {
      const { target } = verifyTargetFor(session.base_url, entry.url);
      const strategy = await strategyRun.forTarget(target);

      if (strategy.skip) {
        refusedByHost += 1;

        const seen = refusedPerHost.get(strategy.host);

        if (seen) {
          seen.count += 1;
        } else {
          refusedPerHost.set(strategy.host, { count: 1, strategy });
        }

        continue;
      }

      ladderByHost.set(
        rateLimitHostKey(target),
        strategy.ladder.length ? strategy.ladder : undefined
      );

      toCheck.push(entry);
    }

    // ONE LINE PER HOST, NOT PER URL — the single most important volume rule in these
    // diagnostics. The loop above runs once per enumerated URL, so emitting inside it
    // would write up to 1.3M identical lines and recreate the disk problem these files
    // exist to help diagnose. url_count_affected carries the number that per-URL logging
    // would have been trying to convey anyway, and carries it more usefully.
    for (const [, refused] of refusedPerHost) {
      strategyRun.noteSkipped(refused.strategy, {
        pattern: null,
        url_count_affected: refused.count
      });
    }

    // entries.length - toCheck.length now covers THREE different reasons, and
    // they mean different things to whoever reads the logs: deleted, reused, and
    // host-refused. Derive the deleted count directly rather than by subtraction,
    // or adding a fourth skip reason later silently re-labels it as deleted.
    const skippedDeleted = entries.filter((entry) =>
      deletedUrls.has(entry.url)
    ).length;
    // Everything the run does not have to probe. This is what the progress row
    // starts at, so a run that reuses most of its population shows real progress
    // immediately instead of crawling up from zero.
    const alreadyDone = entries.length - toCheck.length;

    // urls_total is the FULL deduped population (files_total column — URL
    // semantics for this kind); already-deleted URLs count as done up front.
    //
    // enum_* are cleared in the SAME statement that publishes the URL total, so
    // no poll can ever observe both phases as active. Safe against a late
    // fire-and-forget write because enumLastWrite was awaited above — no
    // progress write can still be outstanding at this point.
    await pool.query(
      `UPDATE maintenance_jobs
         SET status = 'RUNNING', files_total = $2, files_done = $3,
             urls_reused = $4,
             enum_files_total = NULL, enum_files_done = NULL
       WHERE id = $1`,
      [jobRowId, entries.length, alreadyDone, skippedReused]
    );

    logger.info(
      {
        session_id: sessionId,
        job_row_id: jobRowId,
        patterns: patterns.length,
        scope: patternIds ? "patterns" : "session",
        urls_total: entries.length,
        skipped_deleted: skippedDeleted,
        // Reused from a previous run: same files, inside the freshness window.
        // Logged separately because a run that suddenly reuses nothing is a
        // signal (the files changed, or the window was set to 0), not noise.
        skipped_reused: skippedReused,
        reuse_window_hours: config.verification.reuseWindowHours,
        // Broken out from skipped_deleted because they mean different things: one is
        // "we deliberately do not check deleted URLs", the other is "this origin
        // refuses us and needs an allowlist".
        skipped_host_refused: refusedByHost,
        host_strategies: strategyRun.resolved().map((strategy) => ({
          host: strategy.host,
          verdict: strategy.verdict,
          rung: strategy.rung,
          edge_server: strategy.edgeServer,
          // "private-route" means no rung was negotiated because the host was reached
          // inside the VPC — otherwise verdict OK / rung R0 reads as "the public edge
          // answered", which it did not.
          source: strategy.source
        })),
        // Separated from the HTTP phase so the two costs stay distinguishable
        // in the logs — the whole scoping fix was diagnosed from the fact that
        // urls_total, not enumeration, was the number out of proportion.
        enumerate_ms: enumerateMs,
        concurrency: verifyConcurrency(session.base_url)
      },
      "verify urls: population enumerated, checking started"
    );

    // Sampling already happened, BEFORE any probing — see the sampled path where
    // the population would otherwise have been enumerated. Nothing narrows
    // toCheck here any more: it arrives holding only the reservoir's URLs, which
    // is why the circuit breaker above still gets to run on them first. (v1.69.1)

    // Probed redirect pairs per shape, for the per-shape rule. Only collected in
    // stratified mode, where it is bounded by shapes x shapeSample (~1,150 on the
    // reported pattern) — cheap to hold, unlike the full population.
    const pairsByShape = new Map<string, Array<{ source: string; dest: string }>>();

    // Pending upserts, flushed every PROGRESS_FLUSH_EVERY completions and once
    // at the end. splice(0) hands the current batch to one flusher atomically
    // (single-threaded between awaits), so concurrent onSettled calls never
    // double-write a row.
    let pending: Array<{ entry: EnumeratedUrl; result: SampleCheckResult }> = [];
    // Counted from results, so a route the breaker abandoned mid-sweep shows as a split
    // rather than being reported as fully private.
    let privateRoutedUrlCount = 0;

    await runWithBoundedConcurrency(
      toCheck,
      // config.verification.maxConcurrency, independent of sessions.concurrency
      // (which sizes the SAMPLER's burst). Load is bounded separately and
      // per-request by the rate limiter inside probeUrl, so this is a throughput
      // parameter rather than a politeness one — see verifyConcurrency.
      verifyConcurrency(session.base_url),
      async (entry, index) => {
        // ONE derivation per URL, shared by the ladder lookup and the outcome note
        // below. It used to be computed twice here (and wrongly — see
        // verifyTargetFor), which meant three chances for the bookkeeping key to
        // disagree with the URL actually requested.
        const host = rateLimitHostKey(
          verifyTargetFor(session.base_url, entry.url).target
        );
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
          },
          {
            // The learned rung leads, so on a host that needs the browser profile
            // every URL succeeds on attempt #1 instead of climbing from R0.
            profileLadder: ladderByHost.get(host)
          }
        );

        strategyRun.noteOutcome(host, isRealMeasurement(result));

        if (result.viaPrivateRoute) {
          privateRoutedUrlCount += 1;
        }

        return { entry, result };
      },
      async (settled, completed, _total) => {
        pending.push(settled);

        if (stratified) {
          const { entry, result } = settled;

          // Only genuine redirects carry a rewrite; everything else tells us
          // nothing about how this shape should be rewritten.
          if (
            result.httpStatusCategory === "redirect" &&
            result.finalUrl &&
            result.finalUrl !== entry.url
          ) {
            let shape: string;

            try {
              shape = valueShape(new URL(entry.url).pathname);
            } catch {
              return;
            }

            const pairs = pairsByShape.get(shape);
            const pair = { source: entry.url, dest: result.finalUrl };

            if (pairs) {
              pairs.push(pair);
            } else {
              pairsByShape.set(shape, [pair]);
            }
          }
        }

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

    // PER-SHAPE VERDICTS (v1.69). One row per shape: the distilled rule when its
    // probed pairs agreed, or an agreed=false row when they did not.
    //
    // WRITTEN TO pattern_shape_rules, NEVER TO verified_urls. v1.68 made
    // apply-redirects treat every verified_urls row carrying a final_url as a URL
    // that was actually FETCHED — that is what fixed "the button says 28,546 and
    // the toast says 10". Writing an extrapolated destination there would
    // re-create that bug with nothing left to distinguish measured from guessed.
    // An unagreed row is kept rather than dropped: "we sampled this shape and its
    // URLs disagree" is what justifies escalating that shape, and a caller who
    // cannot see it would re-sample it forever.
    if (stratified && reservoir && reservoir.shapeCount > 0) {
      // The reservoir holds the SAMPLE in each stratum's `urls`, not the
      // population, so judgeStratum is given the real population separately —
      // that is the number extrapolation is measured against, and reading it off
      // the sample would report a 10,000-URL shape as 50 and extrapolate nothing.
      const verdicts = reservoir.strata().map((stratum) =>
        judgeStratum(
          {
            shape: stratum.shape,
            urls: new Array(reservoir!.populationOf(stratum.shape))
          },
          pairsByShape.get(stratum.shape) ?? [],
          stratum.urls.length
        )
      );
      // stratified is only true for a single-pattern run (see the sampled path),
      // so this is that pattern.
      const shapePatternId = patterns[0].id;

      for (const verdict of verdicts) {
        await pool.query(
          `
            INSERT INTO pattern_shape_rules
              (pattern_id, shape, rule, sample_size, population, agreed)
            VALUES ($1, $2, $3::jsonb, $4, $5, $6)
            ON CONFLICT (pattern_id, shape) DO UPDATE
            SET rule = EXCLUDED.rule,
                sample_size = EXCLUDED.sample_size,
                population = EXCLUDED.population,
                agreed = EXCLUDED.agreed,
                measured_at = now()
          `,
          [
            shapePatternId,
            verdict.shape,
            verdict.rule ? JSON.stringify(verdict.rule) : null,
            verdict.sampleSize,
            verdict.population,
            verdict.agreed
          ]
        );
      }

      const coverage = coverageFromVerdicts(verdicts);

      logger.info(
        {
          session_id: sessionId,
          pattern_id: shapePatternId,
          shapes: verdicts.length,
          trusted_shapes: coverage.trustedShapes,
          unagreed_shapes: coverage.unagreedShapes,
          measured: coverage.measured,
          extrapolated: coverage.extrapolated
        },
        "verify urls: per-shape verdicts recorded"
      );
    }

    // Re-verification sweep: rows for the SAME selected patterns whose url was
    // NOT re-enumerated this run no longer exist in the files — drop them so the
    // table mirrors reality. Keyed on checked_at (every enumerated url just got
    // it reset) rather than a giant NOT IN url array. Deleted-from-sitemap rows
    // are kept: restore needs them.
    // A STRATIFIED RUN MUST NOT SWEEP (v1.69.1).
    //
    // The sweep's premise is "this run enumerated the whole population, so a row
    // it did not touch describes a URL that is no longer in the files". A
    // stratified run looks at ~50 URLs per shape BY DESIGN, so that premise is
    // false by construction: every other verified row for the pattern is older
    // than runStarted and, once outside VERIFY_REUSE_WINDOW_HOURS, not
    // reuse-eligible either — so the DELETE below would take all of them.
    //
    // A "quick shape check" would then destroy the measured verdicts an earlier
    // full verification spent hours producing, and those are exactly the rows
    // v1.68's apply path treats as confirmed destinations. A sampled run has no
    // opinion about which URLs still exist and must not act as though it does.
    const sweepPatternIds = sweepablePatternIds({
      strategy: stratified ? "stratified" : "full",
      patternIds: patterns.map((pattern) => pattern.id)
    });

    if (stratified) {
      logger.info(
        { session_id: sessionId, job_row_id: jobRowId },
        "verify urls: stale-row sweep skipped — a sampled run cannot say which URLs are gone"
      );
    }

    if (sweepPatternIds.length > 0) {
      const swept = await pool.query(
        `
          DELETE FROM verified_urls v
          USING sessions s
          WHERE s.id = v.session_id
            AND v.session_id = $1
            AND v.pattern_id = ANY($2::uuid[])
            AND v.is_deleted_from_sitemap = false
            AND (v.checked_at IS NULL OR v.checked_at < $3::timestamptz)
            -- ...unless it was REUSED this run. Its checked_at is older than
            -- runStarted precisely because it was not re-probed, so the clause
            -- above would otherwise delete the verdict this run just trusted.
            -- A reusable row is one measured after the files last changed, so it
            -- still describes them — which is exactly what the sweep is for.
            AND NOT (${REUSABLE_VERDICT_SQL.replaceAll("$WINDOW$", "$4")})
        `,
        [sessionId, sweepPatternIds, runStarted, String(reuseWindowHours)]
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
        // The saving, stated so a run can be compared against its predecessor:
        // a second verification of an unedited pattern should show almost all of
        // its population here and take almost no time.
        urls_reused: skippedReused,
        counted_statuses: countedStatuses,
        problem_urls: problemCount,
        // Which network path measured this sweep. Counted from results rather than from
        // the config flag, so a route abandoned mid-run shows up as a split instead of
        // being reported as fully private.
        private_routed_url_count: privateRoutedUrlCount,
        public_routed_url_count: toCheck.length - privateRoutedUrlCount,
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
