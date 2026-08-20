import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { hostStrategyFleetReport } from "../http/hostStrategyReport.js";
import { privateHostMapSnapshot } from "../http/privateHostMap.js";
import { privateRouteHealthSnapshot } from "../http/privateRouteHealth.js";
import { VERIFY_PROBLEM_STATUSES } from "../jobs/verifyUrlsJob.js";
import { enqueueDeleteProblemUrlsJob } from "../queue/maintenanceQueue.js";
import {
  enqueueSamplePatternsJob,
  samplePatternJobId,
  sitemapQueue
} from "../queue/sitemapQueue.js";
import { enqueueTriageSampleJob } from "../queue/triageQueue.js";
import { enqueueVerifyUrlsJob } from "../queue/verificationQueue.js";
import {
  parseStructureFilters,
  resolveStructureFilters,
  urlMatchesStructureFilters,
  type ResolvedStructureFilter
} from "../sitemaps/structureClusters.js";

// Full-population verification routes (verify-then-act, migration 038).
//
// Its own plugin rather than more surface on routes/sessions.ts: everything
// here is scoped to the verified_urls table + the 'verify-urls' maintenance_jobs
// kind, and sessions.ts is already ~5000 lines. Registered in server.ts right
// after sessionRoutes.

// Default page size for the per-pattern verified-URL listing — mirrors the Fix
// modal's FIX_MODAL_PAGE_SIZE on the frontend so one poll fills one page.
const VERIFIED_URLS_PAGE_SIZE = 200;
// Hard ceiling so a hand-crafted ?limit= cannot pull the whole population in
// one response.
const VERIFIED_URLS_MAX_PAGE_SIZE = 1000;

type SessionParams = {
  id: string;
};

type PatternParams = {
  id: string;
  patternId: string;
};

// Same error shape sessions.ts's badRequest helper produces (that one is
// module-private, and sessions.ts is out of bounds for this change).
function badRequest(message: string) {
  return {
    error: "Bad Request",
    message
  };
}

async function sessionExists(sessionId: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM sessions WHERE id = $1", [
    sessionId
  ]);

  return result.rowCount !== null && result.rowCount > 0;
}

// Parse and validate a target_statuses body field. Returns null for "not
// specified" (meaning every problem status) or an Error to be turned into a 400.
function parseTargetStatuses(raw: unknown): number[] | null | Error {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (!Array.isArray(raw) || raw.length === 0) {
    return new Error("target_statuses must be a non-empty array of status codes");
  }

  const statuses = raw.map((value) => Number(value));

  if (statuses.some((value) => !VERIFY_PROBLEM_STATUSES.includes(value))) {
    return new Error(
      `target_statuses must be a subset of ${VERIFY_PROBLEM_STATUSES.join(", ")}`
    );
  }

  return statuses;
}

export async function verificationRoutes(app: FastifyInstance) {
  // THE FLEET REPORT. One request, runnable straight from the box, answering the
  // question 650+ sites made unanswerable from per-URL rows: which hosts can the
  // checker see, at which request profile, and which are refusing it.
  //
  // Lives here rather than in a new plugin because this is the same subject as the
  // rest of this file — what a probe of a host actually produced. `?verdict=REFUSED`
  // narrows it to the allowlist conversation, which is the list devops asked for.
  app.get<{ Querystring: { verdict?: string } }>(
    "/api/host-strategies",
    async (request, reply) => {
      const wanted = request.query.verdict?.toUpperCase();

      if (wanted && wanted !== "OK" && wanted !== "REFUSED") {
        return reply
          .code(400)
          .send(badRequest("verdict must be OK or REFUSED"));
      }

      const rows = await hostStrategyFleetReport();
      const hosts = wanted ? rows.filter((row) => row.verdict === wanted) : rows;

      return {
        hosts,
        // Counted server-side so a caller cannot mis-add them, and because "how many
        // of the fleet refuse us" is the headline number this endpoint exists for.
        totals: {
          hosts: rows.length,
          refused: rows.filter((row) => row.verdict === "REFUSED").length,
          ok: rows.filter((row) => row.verdict === "OK").length
        }
      };
    }
  );

  // IS PRIVATE ROUTING ON, AND IS IT WORKING — the one request ops runs.
  //
  // Read-only, and same home as /api/host-strategies for the same reason: both answer
  // "what does a probe of a host actually do". There is deliberately no reload
  // endpoint. This API is unauthenticated (see the note in docker-compose.aws.yml),
  // the map is re-read on mtime change within a minute anyway, and an endpoint that
  // re-pointed 650 sites at different servers is not something to leave unguarded.
  app.get("/api/private-routes", async () => {
    const map = privateHostMapSnapshot({
      file: config.privateRoute.mapFile,
      reloadSeconds: config.privateRoute.mapReloadSeconds
    });

    return {
      enabled: config.privateRoute.enabled,
      scheme: config.privateRoute.scheme,
      map: {
        file: map.file,
        present: map.present,
        mtime: map.mtimeMs === null ? null : new Date(map.mtimeMs).toISOString(),
        loaded_at:
          map.loadedAt === null ? null : new Date(map.loadedAt).toISOString(),
        hosts: map.entryCount,
        ips: Object.keys(map.hostsByIp).length,
        hosts_by_ip: map.hostsByIp,
        // Hostnames claimed by two different IPs. These route PUBLICLY — first-wins
        // would silently pin a site to one of two servers, and a plausible 200 from
        // the wrong box is the hardest failure here to notice.
        conflicts: map.conflicts,
        warnings: map.warnings
      },
      // recovers_on rather than a bare `disabled: true`, because a breaker that never
      // half-opens is surprising: without saying so, the natural assumption is that it
      // recovers on a timer and a site family sits on the public path for days.
      disabled_routes: privateRouteHealthSnapshot().map((entry) => ({
        private_ip: entry.ip,
        disabled_since: new Date(entry.disabledSince).toISOString(),
        consecutive_failures: entry.consecutiveFailures,
        recovers_on: entry.recoversOn
      })),
      limits: {
        max_requests_per_second: config.privateRoute.maxRequestsPerSecond,
        rate_limit_burst: config.privateRoute.rateLimitBurst,
        max_concurrency: config.privateRoute.maxConcurrency,
        failure_streak: config.privateRoute.failureStreak
      }
    };
  });

  // Start (or attach to) a full-population verification. Body may carry
  // pattern_ids to verify a subset; absent → every current pattern.
  app.post<{
    Params: SessionParams;
    Body: {
      pattern_ids?: unknown;
      target_statuses?: unknown;
      structure_filter?: unknown;
      // "stratified" probes a sample per URL SHAPE instead of every URL (v1.69),
      // turning a 579,034-URL run from 3h17m into roughly 1,150 requests. Shapes
      // whose samples disagree are reported unagreed rather than extrapolated.
      strategy?: unknown;
      shape_sample?: unknown;
    };
  }>(
    "/api/sessions/:id/verify-urls",
    async (request, reply) => {
      const sessionId = request.params.id;

      if (!(await sessionExists(sessionId))) {
        return reply.code(404).send({
          error: "Not Found",
          message: "Session not found"
        });
      }

      const patternIds = Array.isArray(request.body?.pattern_ids)
        ? (request.body.pattern_ids as unknown[]).filter(
            (value): value is string => typeof value === "string"
          )
        : null;

      if (patternIds !== null && patternIds.length === 0) {
        return reply
          .code(400)
          .send(badRequest("pattern_ids must be a non-empty array of ids"));
      }

      const targetStatuses = parseTargetStatuses(request.body?.target_statuses);

      if (targetStatuses instanceof Error) {
        return reply.code(400).send(badRequest(targetStatuses.message));
      }

      // Structure scope (v1.66): "Limit this edit to" in the Fix modal. Only
      // meaningful for a single-pattern request — the filters are {param}
      // ordinals against ONE template, so resolving them against several
      // patterns at once would mean different things per pattern. Rejected
      // rather than silently applied to the first, because a scope that half
      // applies is the one failure mode a scoped run must not have.
      const parsedFilters = parseStructureFilters(request.body?.structure_filter);

      if (parsedFilters === null) {
        return reply.code(400).send(badRequest("structure_filter is malformed"));
      }

      let structureFilters: ResolvedStructureFilter[] | null = null;

      if (parsedFilters.length > 0) {
        if (patternIds === null || patternIds.length !== 1) {
          return reply
            .code(400)
            .send(
              badRequest(
                "structure_filter requires exactly one pattern_id to resolve against"
              )
            );
        }

        const templateResult = await pool.query<{ template: string }>(
          "SELECT template FROM patterns WHERE session_id = $1 AND id = $2",
          [sessionId, patternIds[0]]
        );

        if (templateResult.rowCount === 0) {
          return reply.code(404).send({
            error: "Not Found",
            message: "pattern not found"
          });
        }

        const template = templateResult.rows[0].template;
        const resolved = resolveStructureFilters(parsedFilters, template);

        if (!resolved) {
          return reply
            .code(400)
            .send(
              badRequest(
                `structure_filter param_index ${parsedFilters
                  .map((filter) => filter.param_index)
                  .join(", ")} does not resolve against ${template}`
              )
            );
        }

        structureFilters = resolved;
      }

      // Default "full", so an unspecified request behaves exactly as it did
      // before v1.69 and nothing silently starts extrapolating.
      const strategy =
        request.body?.strategy === "stratified" ? "stratified" : "full";
      const rawSample = Number(request.body?.shape_sample);
      // Clamped rather than rejected: this only decides how much evidence to
      // gather, and a nonsense value should fall back to the default rather than
      // fail a run someone is waiting on. Floor of 5 because a rule distilled
      // from fewer pairs is not evidence of a template behaving consistently.
      const shapeSample =
        Number.isFinite(rawSample) && rawSample > 0
          ? Math.max(5, Math.min(500, Math.floor(rawSample)))
          : undefined;

      // Serialised once and used for BOTH the attach comparison and the insert,
      // so "same scope?" is asked of exactly the value that gets stored.
      const structureFiltersJson = structureFilters
        ? JSON.stringify(structureFilters)
        : null;

      // Attach semantics: a verification can run for a long time, so a re-POST
      // (page reload, second tab) joins the in-flight job instead of stacking a
      // second population check behind it.
      //
      // MATCHED ON SCOPE, not just on session. This query used to accept any
      // in-flight 'verify-urls' row, so a request to verify one 25,744-URL
      // pattern would attach to a running whole-session sweep and report ITS
      // 1.3M-URL progress — indistinguishable, from the modal, from the scoping
      // bug itself. Comparing sorted arrays makes the match independent of the
      // order the ids arrived in; NULL (whole session) only ever matches NULL.
      const active = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM maintenance_jobs
          WHERE session_id = $1
            AND kind = 'verify-urls'
            AND status IN ('PENDING', 'RUNNING')
            AND (
              ($2::uuid[] IS NULL AND pattern_ids IS NULL)
              OR (
                $2::uuid[] IS NOT NULL
                AND pattern_ids IS NOT NULL
                AND (
                  SELECT array_agg(id ORDER BY id) FROM unnest(pattern_ids) AS id
                ) = (
                  SELECT array_agg(id ORDER BY id) FROM unnest($2::uuid[]) AS id
                )
              )
            )
            -- Structure scope is part of the identity of a run (v1.66), for the
            -- same reason pattern_ids is: without this, a request to verify
            -- nsn-parts-{var} attaches to a running whole-pattern verification
            -- of the same pattern — same session, same pattern_ids — reports its
            -- 28,413-URL progress as the 613-URL run's, and leaves the caller
            -- treating a whole-pattern verdict set as the scoped one. Compared
            -- as jsonb of the RESOLVED filters, so representation cannot make
            -- two identical scopes look different.
            AND structure_filters IS NOT DISTINCT FROM $3::jsonb
            -- Strategy is part of the identity too (v1.69): a request for a FULL
            -- verification must never attach to a running STRATIFIED one and
            -- inherit a sampled result set as though it were exhaustive.
            -- COALESCE so pre-v1.69 rows, which are all full runs, still match a
            -- full request.
            AND COALESCE(strategy, 'full') = $4
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [sessionId, patternIds, structureFiltersJson, strategy]
      );

      if (active.rows[0]) {
        return reply.code(202).send({ job_row_id: active.rows[0].id });
      }

      const jobRow = await pool.query<{ id: string }>(
        `
          INSERT INTO maintenance_jobs
            (session_id, kind, pattern_ids, structure_filters, strategy)
          VALUES ($1, 'verify-urls', $2::uuid[], $3::jsonb, $4)
          RETURNING id
        `,
        [sessionId, patternIds, structureFiltersJson, strategy]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueVerifyUrlsJob({
        session_id: sessionId,
        job_row_id: jobRowId,
        pattern_ids: patternIds,
        target_statuses: targetStatuses,
        structure_filters: structureFilters,
        strategy,
        ...(shapeSample === undefined ? {} : { shape_sample: shapeSample })
      });

      return reply.code(202).send({ job_row_id: jobRowId });
    }
  );

  // Poll the latest verification: live progress ("Verifying 187 of 269 URLs…"),
  // per-status counts over the verified population, and a staleness flag for
  // "files changed since this was verified".
  //
  // ?pattern_id= scopes the WHOLE response to one pattern — the job reported is
  // that pattern's job, the counts cover only its verified URLs, and freshness
  // is judged on when IT was last checked. Without this the Fix modal, which is
  // open on exactly one pattern, would poll whatever verification ran most
  // recently in the session and show session-wide per-status counts next to a
  // single pattern's name. Omitting it keeps the original session-wide
  // behaviour, which is what the Delete Problem URLs dialog wants.
  app.get<{ Params: SessionParams; Querystring: { pattern_id?: string } }>(
    "/api/sessions/:id/verify-urls/status",
    async (request) => {
      const sessionId = request.params.id;
      const patternId = request.query.pattern_id ?? null;

      const jobResult = await pool.query<{
        id: string;
        status: string;
        files_total: number;
        files_done: number;
        items_changed: string;
        error: string | null;
        pattern_ids: string[] | null;
        enum_files_total: number | null;
        enum_files_done: number | null;
        urls_reused: number | null;
      }>(
        // A session-wide run (pattern_ids IS NULL) COVERS every pattern, so it
        // matches a pattern-scoped query too. Excluding it would tell a user
        // "not verified yet" while a run that is about to verify their pattern
        // is already going, and their Verify press would queue a second,
        // redundant job behind it. The response carries pattern_ids so the
        // client can say which kind of run it is looking at rather than
        // presenting a 1.3M-URL session progress bar as if it were the
        // pattern's — the confusion this release exists to remove.
        `
          SELECT id, status, files_total, files_done, items_changed, error, pattern_ids,
                 enum_files_total, enum_files_done, urls_reused
          FROM maintenance_jobs
          WHERE session_id = $1
            AND kind = 'verify-urls'
            AND (
              $2::uuid IS NULL
              OR pattern_ids IS NULL
              OR $2::uuid = ANY(pattern_ids)
            )
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [sessionId, patternId]
      );
      const jobRow = jobResult.rows[0] ?? null;

      // verified_at is the newest check timestamp; stale compares it against
      // files_mutated_at (stamped by every file-mutating operation via
      // invalidateSessionZipCache) — the same freshness signal the ZIP cache
      // uses, so "your verification predates an edit" can never disagree with
      // the download gate about what counts as an edit.
      const freshnessResult = await pool.query<{
        verified_at: string | null;
        stale: boolean;
      }>(
        `
          WITH scoped AS (
            SELECT MAX(checked_at) AS verified_at
            FROM verified_urls
            WHERE session_id = $1
              AND ($2::uuid IS NULL OR pattern_id = $2::uuid)
          )
          SELECT
            scoped.verified_at,
            COALESCE(
              (SELECT files_mutated_at FROM sessions WHERE id = $1) > scoped.verified_at,
              false
            ) AS stale
          FROM scoped
        `,
        [sessionId, patternId]
      );

      const countsResult = await pool.query<{
        http_status: number | null;
        count: string;
      }>(
        `
          SELECT http_status, COUNT(*)::text AS count
          FROM verified_urls
          WHERE session_id = $1
            AND is_deleted_from_sitemap = false
            AND ($2::uuid IS NULL OR pattern_id = $2::uuid)
          GROUP BY http_status
          ORDER BY http_status ASC NULLS LAST
        `,
        [sessionId, patternId]
      );

      return {
        // files_total/files_done carry URL counts for kind 'verify-urls' —
        // renamed here so the client never sees the column pun.
        job: jobRow
          ? {
              id: jobRow.id,
              status: jobRow.status,
              urls_total: jobRow.files_total,
              urls_done: jobRow.files_done,
              items_changed: Number(jobRow.items_changed),
              error: jobRow.error,
              // What this run actually covers, so the UI can state it rather
              // than assume it. null = the whole session.
              pattern_ids: jobRow.pattern_ids,
              // Enumeration-phase progress (v1.53). NULL on both = not
              // enumerating; see migration 041 for why these are separate from
              // files_total/files_done rather than reusing them.
              enum_files_total: jobRow.enum_files_total,
              enum_files_done: jobRow.enum_files_done,
              // URLs this run did not have to probe because a recent verdict was
              // still good. Lets the panel explain a bar that starts near the end
              // instead of it reading as work that was silently skipped.
              urls_reused: jobRow.urls_reused
            }
          : null,
        // WHAT A QUEUED JOB IS WAITING BEHIND (v1.70).
        //
        // The verification queue is concurrency 1, so a second request sits
        // PENDING until the first finishes. Nothing said so: the panel had no
        // waiting state, and PENDING rendered identically to enumerating and to
        // hung — a "Check by shape" that was simply queued read as a 15-minute
        // freeze, which is the reported bug.
        //
        // Only looked up when the job we are reporting is actually waiting, and
        // it is a DIFFERENT scope by definition (same scope would have attached
        // rather than queued), which is why the query is not the one above.
        blocked_by:
          jobRow && jobRow.status === "PENDING"
            ? ((
                await pool.query<{
                  urls_total: string | null;
                  urls_done: string | null;
                  pattern_ids: string[] | null;
                }>(
                  `
                    SELECT files_total AS urls_total,
                           files_done AS urls_done,
                           pattern_ids
                    FROM maintenance_jobs
                    WHERE session_id = $1
                      AND kind = 'verify-urls'
                      AND status = 'RUNNING'
                      AND id <> $2
                    ORDER BY started_at ASC
                    LIMIT 1
                  `,
                  [sessionId, jobRow.id]
                )
              ).rows[0] ?? null)
            : null,
        // Echoes the request scope so a client can tell a pattern-scoped
        // response from a session-wide one without tracking what it asked for.
        scope: patternId ? "pattern" : "session",
        verified_at: freshnessResult.rows[0]?.verified_at ?? null,
        stale: freshnessResult.rows[0]?.stale ?? false,
        counts_by_status: countsResult.rows.map((row) => ({
          http_status: row.http_status,
          count: Number(row.count)
        }))
      };
    }
  );

  // Page through a pattern's verified URLs, optionally filtered by status
  // (?statuses=301,404) — feeds the Fix modal's chip-filtered list.
  app.get<{
    Params: PatternParams;
    Querystring: { statuses?: string; limit?: string; offset?: string };
  }>(
    "/api/sessions/:id/patterns/:patternId/verified-urls",
    async (request) => {
      const sessionId = request.params.id;
      const patternId = request.params.patternId;

      const statuses = (request.query.statuses ?? "")
        .split(",")
        .map((value) => Number.parseInt(value.trim(), 10))
        .filter((value) => Number.isFinite(value));
      const limit = Math.min(
        Math.max(Number.parseInt(request.query.limit ?? "", 10) || VERIFIED_URLS_PAGE_SIZE, 1),
        VERIFIED_URLS_MAX_PAGE_SIZE
      );
      const offset = Math.max(
        Number.parseInt(request.query.offset ?? "", 10) || 0,
        0
      );

      // Empty statuses filter → all non-deleted verified rows of the pattern.
      const where = `
        session_id = $1
          AND pattern_id = $2
          AND is_deleted_from_sitemap = false
          ${statuses.length > 0 ? "AND http_status = ANY($3::int[])" : ""}
      `;
      const whereParams: unknown[] = [sessionId, patternId];

      if (statuses.length > 0) {
        whereParams.push(statuses);
      }

      const totalResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM verified_urls WHERE ${where}`,
        whereParams
      );

      const rowsResult = await pool.query<{
        url: string;
        http_status: number | null;
        final_url: string | null;
        source_files: string[];
      }>(
        `
          SELECT url, http_status, final_url, source_files
          FROM verified_urls
          WHERE ${where}
          ORDER BY url ASC
          LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}
        `,
        [...whereParams, limit, offset]
      );

      return {
        total: Number(totalResult.rows[0]?.count ?? 0),
        urls: rowsResult.rows
      };
    }
  );

  // Delete the pattern's verified problem URLs (of the selected statuses) from
  // the sitemap files — the "act" of verify-then-act. Enqueues the SAME delete
  // job the sampled flow uses, in its use_verified mode.
  // WHICH FILES the URLs about to be deleted actually live in, and how many are
  // in each.
  //
  // The delete confirmation used to be a count and a verb: "Delete 2,300 URLs".
  // That is enough to authorise the action but not enough to review it — a
  // reviewer asked to sign off on removing thousands of <loc> entries has no way
  // to tell whether they are spread thinly across the whole set or concentrated
  // in one file that is itself the real problem. The SEO team asked for the
  // breakdown by name for exactly that reason.
  //
  // No new analysis: verified_urls.source_files already records which display
  // files each verified <loc> appears in, and the delete endpoint below already
  // unnests the same column to decide which files to rewrite. This reports what
  // that job is about to do, from the same rows, so the preview cannot disagree
  // with the action.
  //
  // CONFIRMED ONLY, deliberately. These counts come from verified_urls, which is
  // written by a full verification — not by sampling or triage. Deletion already
  // requires that (see the panel's three-mode note), and a per-file number
  // extrapolated from a ~1% draw would be a guess wearing the clothes of an
  // exact count, immediately before an irreversible action.
  app.get<{ Params: PatternParams; Querystring: { statuses?: string } }>(
    "/api/sessions/:id/patterns/:patternId/status-file-breakdown",
    async (request, reply) => {
      const sessionId = request.params.id;
      const patternId = request.params.patternId;

      const requested = (request.query.statuses ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => Number(value));

      if (requested.some((value) => !VERIFY_PROBLEM_STATUSES.includes(value))) {
        return reply
          .code(400)
          .send(
            badRequest(
              `statuses must be a subset of ${VERIFY_PROBLEM_STATUSES.join(", ")}`
            )
          );
      }

      // Empty selection means every problem status — the same convention the
      // status chips use, so the breakdown matches what the chips are showing.
      const statuses =
        requested.length > 0 ? requested : VERIFY_PROBLEM_STATUSES;

      const breakdownResult = await pool.query<{
        source_file: string;
        urls: string;
      }>(
        `
          SELECT unnest(source_files) AS source_file, count(*)::text AS urls
          FROM verified_urls
          WHERE session_id = $1
            AND pattern_id = $2
            AND is_deleted_from_sitemap = false
            AND http_status = ANY($3::int[])
          GROUP BY 1
          ORDER BY count(*) DESC, 1 ASC
        `,
        [sessionId, patternId, statuses]
      );

      // The DISTINCT url count, which is NOT the sum of the per-file counts: one
      // <loc> can appear in several sitemap files, and it is counted once per
      // file above. Reported separately so the dialog can say "2,300 URLs across
      // 7 files" without the two numbers appearing to contradict each other.
      const totalResult = await pool.query<{ urls: string }>(
        `
          SELECT count(*)::text AS urls
          FROM verified_urls
          WHERE session_id = $1
            AND pattern_id = $2
            AND is_deleted_from_sitemap = false
            AND http_status = ANY($3::int[])
        `,
        [sessionId, patternId, statuses]
      );

      return {
        statuses,
        // Zero files with a non-zero total is impossible; zero of both means the
        // pattern has not been verified for these statuses yet, which the client
        // renders as "run a check first" rather than as "nothing to delete".
        total_urls: Number(totalResult.rows[0]?.urls ?? 0),
        files: breakdownResult.rows.map((row) => ({
          source_file: row.source_file,
          urls: Number(row.urls)
        }))
      };
    }
  );

  app.post<{
    Params: PatternParams;
    Body: { statuses?: unknown; structure_filter?: unknown };
  }>(
    "/api/sessions/:id/patterns/:patternId/delete-verified-urls",
    async (request, reply) => {
      const sessionId = request.params.id;
      const patternId = request.params.patternId;

      const statuses = Array.isArray(request.body?.statuses)
        ? (request.body.statuses as unknown[]).map((value) => Number(value))
        : [];

      if (statuses.length === 0) {
        return reply.code(400).send(badRequest("statuses is required"));
      }

      if (
        statuses.some((value) => !VERIFY_PROBLEM_STATUSES.includes(value))
      ) {
        return reply
          .code(400)
          .send(
            badRequest(
              `statuses must be a subset of ${VERIFY_PROBLEM_STATUSES.join(", ")}`
            )
          );
      }

      // Structure scope (v1.66): "Limit this edit to" in the Fix modal governs
      // this delete too. It cannot be a filter on the status query alone,
      // because verified_urls ACCUMULATES across runs — a whole-pattern
      // verification from before the user narrowed the dialog leaves rows
      // outside the chosen structure, and they would be deleted by a request
      // that says it is limited to one structure.
      //
      // So a scoped request resolves to an EXPLICIT url list, which the delete
      // job already supports (DeleteProblemUrlsJobData.urls) — no job change,
      // and the file scope is derived from the surviving rows rather than from
      // the whole status match.
      const parsedFilters = parseStructureFilters(request.body?.structure_filter);

      if (parsedFilters === null) {
        return reply.code(400).send(badRequest("structure_filter is malformed"));
      }

      let scopedUrls: string[] | undefined;
      let fileDisplays: string[];

      if (parsedFilters.length > 0) {
        const patternResult = await pool.query<{ template: string }>(
          "SELECT template FROM patterns WHERE session_id = $1 AND id = $2",
          [sessionId, patternId]
        );

        if (patternResult.rowCount === 0) {
          return reply.code(404).send({
            error: "Not Found",
            message: "pattern not found"
          });
        }

        const template = patternResult.rows[0].template;
        const resolved = resolveStructureFilters(parsedFilters, template);

        if (!resolved) {
          return reply
            .code(400)
            .send(
              badRequest(
                `structure_filter param_index ${parsedFilters
                  .map((filter) => filter.param_index)
                  .join(", ")} does not resolve against ${template}`
              )
            );
        }

        const rowsResult = await pool.query<{
          url: string;
          source_files: string[];
        }>(
          `
            SELECT url, source_files
            FROM verified_urls
            WHERE session_id = $1
              AND pattern_id = $2
              AND is_deleted_from_sitemap = false
              AND http_status = ANY($3::int[])
          `,
          [sessionId, patternId, statuses]
        );
        const inScope = rowsResult.rows.filter((row) =>
          urlMatchesStructureFilters(row.url, resolved)
        );

        scopedUrls = inScope.map((row) => row.url);
        fileDisplays = Array.from(
          new Set(inScope.flatMap((row) => row.source_files ?? []))
        );

        if (scopedUrls.length === 0) {
          return reply
            .code(400)
            .send(
              badRequest(
                "no verified URLs with the selected statuses inside the selected structure"
              )
            );
        }
      } else {
        // The delete job restricts to (and rebuilds) exactly these files; the
        // verified rows already know which display files their <loc> appears in,
        // so the file scope is the union of the target rows' source_files.
        const filesResult = await pool.query<{ display: string }>(
          `
            SELECT DISTINCT unnest(source_files) AS display
            FROM verified_urls
            WHERE session_id = $1
              AND pattern_id = $2
              AND is_deleted_from_sitemap = false
              AND http_status = ANY($3::int[])
          `,
          [sessionId, patternId, statuses]
        );

        fileDisplays = filesResult.rows.map((row) => row.display);
      }

      if (fileDisplays.length === 0) {
        return reply
          .code(400)
          .send(
            badRequest(
              "no verified URLs with the selected statuses — run verification first"
            )
          );
      }

      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'delete-problem-urls') RETURNING id",
        [sessionId]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueDeleteProblemUrlsJob({
        session_id: sessionId,
        job_row_id: jobRowId,
        file_displays: fileDisplays,
        statuses,
        ...(scopedUrls ? { urls: scopedUrls } : {}),
        use_verified: true,
        pattern_id: patternId
      });

      return reply.code(202).send({ job_row_id: jobRowId });
    }
  );

  // Start a sample triage for one pattern: the fast, approximate read that
  // tells a user whether a full verification is worth starting.
  app.post<{ Params: PatternParams; Body: { target_statuses?: unknown } }>(
    "/api/sessions/:id/patterns/:patternId/triage",
    async (request, reply) => {
      const sessionId = request.params.id;
      const patternId = request.params.patternId;

      const patternResult = await pool.query(
        "SELECT 1 FROM patterns WHERE id = $1 AND session_id = $2",
        [patternId, sessionId]
      );

      if (patternResult.rowCount === 0) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "Pattern not found" });
      }

      const targetStatuses = parseTargetStatuses(request.body?.target_statuses);

      if (targetStatuses instanceof Error) {
        return reply.code(400).send(badRequest(targetStatuses.message));
      }

      // Attach to an in-flight triage rather than starting a second one. The
      // unique partial index in migration 040 is the real guard (two triages
      // for one pattern would double the request rate at the client's origin
      // for no extra information); this check just turns that into a clean 202
      // instead of a constraint violation.
      const active = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM verify_triage_runs
          WHERE pattern_id = $1 AND status IN ('PENDING', 'RUNNING')
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [patternId]
      );

      if (active.rows[0]) {
        return reply.code(202).send({ run_id: active.rows[0].id });
      }

      const runRow = await pool.query<{ id: string }>(
        `
          INSERT INTO verify_triage_runs (session_id, pattern_id, target_statuses)
          VALUES ($1, $2, $3::int[])
          RETURNING id
        `,
        [sessionId, patternId, targetStatuses]
      );
      const runId = runRow.rows[0].id;

      await enqueueTriageSampleJob({
        session_id: sessionId,
        pattern_id: patternId,
        run_id: runId,
        target_statuses: targetStatuses
      });

      return reply.code(202).send({ run_id: runId });
    }
  );

  // RE-MEASURE ONE PATTERN'S SAMPLE AND RESCORE IT.
  //
  // The gap this closes: patterns.status / confidence_pct / redirect_pct are
  // written by exactly one thing — the sampling job's persistPatternSamples — and
  // sampling only ran at the end of extraction, or from resume while it was still
  // unfinished. So a completed session's pattern table was frozen at whatever the
  // checker concluded on its first pass, and every later checker fix (the WAF
  // "blocked" classification, the browser-profile retry, the 403 escalation) was
  // invisible on it. The Check button on an unscored row could not help: triage and
  // full verification write verify_triage_runs / verified_urls and never touch
  // patterns.status, so a "Not scored" row stayed "Not scored" no matter what the
  // site answered. Re-running the whole analysis was the only remedy.
  //
  // This re-probes just this pattern's sample pool through the SAME job, checker
  // and per-host rate limiter as the original pass, then rescores the row.
  app.post<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/recheck",
    async (request, reply) => {
      const sessionId = request.params.id;
      const patternId = request.params.patternId;

      const patternResult = await pool.query<{
        source_role: string;
        pool_total: string;
      }>(
        `
          SELECT
            source_role,
            (SELECT count(*) FROM pattern_urls WHERE pattern_id = patterns.id)::text
              AS pool_total
          FROM patterns
          WHERE id = $1 AND session_id = $2
        `,
        [patternId, sessionId]
      );
      const pattern = patternResult.rows[0];

      if (!pattern) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "Pattern not found" });
      }

      // The sampling job only ever walks source_role = 'current' patterns, so a
      // proposed-side pattern would enqueue a job that silently sampled nothing.
      if (pattern.source_role !== "current") {
        return reply
          .code(400)
          .send(badRequest("only current-sitemap patterns can be re-checked"));
      }

      // No stored sample pool means there is nothing to probe — the honest answer
      // is "re-run the analysis", not a job that writes zero rows and leaves the
      // row unscored for a second, more confusing reason.
      if (Number(pattern.pool_total) === 0) {
        return reply
          .code(400)
          .send(
            badRequest(
              "this pattern has no stored sample URLs — re-run the analysis for this session"
            )
          );
      }

      // enqueueSamplePatternsJob is itself a singleton on this job id, so a second
      // press (or a second tab) attaches to the in-flight run instead of doubling
      // the request rate at the client's origin.
      //
      // That is also the whole concurrency guard, and it is enough: two re-checks of
      // one pattern cannot coexist, and a re-check racing the session's ORIGINAL
      // sample job (different job id, only possible on a resumed session) cannot
      // corrupt anything either — persistPatternSamples deletes and re-inserts the
      // pattern's rows inside ONE transaction, so the two serialise and the later
      // commit simply wins. The cost of that race is duplicate requests, not mixed
      // data.
      const job = await enqueueSamplePatternsJob({
        session_id: sessionId,
        pattern_id: patternId
      });

      return reply.code(202).send({ job_id: job.id ?? null });
    }
  );

  // Poll a pattern re-check: is it still running, and what does the row say now.
  //
  // Also the only place the UI can tell "never checked" apart from "checked and
  // BLOCKED" — both render as "Not scored", because patternScore treats a blocked
  // sample as the absence of a measurement rather than a data point. blocked_count
  // and used_fallback_count come straight off sampled_urls so the panel can say
  // which one it is instead of implying nobody has looked.
  app.get<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/recheck",
    async (request, reply) => {
      const sessionId = request.params.id;
      const patternId = request.params.patternId;

      const patternResult = await pool.query<{
        status: string;
        confidence_pct: string | null;
        redirect_pct: string | null;
        sample_total: string;
        blocked_count: string;
        used_fallback_count: string;
        last_checked_at: string | null;
        pool_total: string;
      }>(
        `
          SELECT
            p.status,
            p.confidence_pct,
            p.redirect_pct,
            count(su.id)::text AS sample_total,
            count(su.id) FILTER (
              WHERE su.http_status_category = 'blocked'
            )::text AS blocked_count,
            count(su.id) FILTER (
              WHERE su.used_fallback_profile
            )::text AS used_fallback_count,
            max(su.checked_at)::text AS last_checked_at,
            (SELECT count(*) FROM pattern_urls WHERE pattern_id = p.id)::text
              AS pool_total
          FROM patterns p
          LEFT JOIN sampled_urls su ON su.pattern_id = p.id
          WHERE p.id = $1 AND p.session_id = $2
          GROUP BY p.id, p.status, p.confidence_pct, p.redirect_pct
        `,
        [patternId, sessionId]
      );
      const row = patternResult.rows[0];

      if (!row) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "Pattern not found" });
      }

      const job = await sitemapQueue.getJob(
        samplePatternJobId(sessionId, patternId)
      );
      const jobState = job ? await job.getState() : null;

      return {
        running: jobState === "waiting" || jobState === "active" || jobState === "delayed",
        job_state: jobState,
        status: row.status,
        confidence_pct: row.confidence_pct,
        redirect_pct: row.redirect_pct,
        sample_total: Number(row.sample_total),
        blocked_count: Number(row.blocked_count),
        used_fallback_count: Number(row.used_fallback_count),
        pool_total: Number(row.pool_total),
        last_checked_at: row.last_checked_at
      };
    }
  );

  // Poll the latest triage for a pattern.
  app.get<{ Params: PatternParams }>(
    "/api/sessions/:id/patterns/:patternId/triage",
    async (request) => {
      const patternId = request.params.patternId;

      const result = await pool.query<{
        id: string;
        status: string;
        target_statuses: number[] | null;
        population_total: number;
        sampled_total: number;
        expanded: boolean;
        result: unknown;
        error: string | null;
        completed_at: string | null;
      }>(
        `
          SELECT id, status, target_statuses, population_total, sampled_total,
                 expanded, result, error, completed_at
          FROM verify_triage_runs
          WHERE pattern_id = $1
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [patternId]
      );

      return { run: result.rows[0] ?? null };
    }
  );
}
