import type { FastifyInstance } from "fastify";

import { pool } from "../db/pool.js";
import { VERIFY_PROBLEM_STATUSES } from "../jobs/verifyUrlsJob.js";
import { enqueueDeleteProblemUrlsJob } from "../queue/maintenanceQueue.js";
import { enqueueVerifyUrlsJob } from "../queue/verificationQueue.js";

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

export async function verificationRoutes(app: FastifyInstance) {
  // Start (or attach to) a full-population verification. Body may carry
  // pattern_ids to verify a subset; absent → every current pattern.
  app.post<{ Params: SessionParams; Body: { pattern_ids?: unknown } }>(
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

      // Attach semantics: a verification can run for hours, so a re-POST (page
      // reload, second tab) joins the in-flight job instead of stacking a
      // second full population check behind it.
      const active = await pool.query<{ id: string }>(
        `
          SELECT id
          FROM maintenance_jobs
          WHERE session_id = $1
            AND kind = 'verify-urls'
            AND status IN ('PENDING', 'RUNNING')
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [sessionId]
      );

      if (active.rows[0]) {
        return reply.code(202).send({ job_row_id: active.rows[0].id });
      }

      const jobRow = await pool.query<{ id: string }>(
        "INSERT INTO maintenance_jobs (session_id, kind) VALUES ($1, 'verify-urls') RETURNING id",
        [sessionId]
      );
      const jobRowId = jobRow.rows[0].id;

      await enqueueVerifyUrlsJob({
        session_id: sessionId,
        job_row_id: jobRowId,
        pattern_ids: patternIds
      });

      return reply.code(202).send({ job_row_id: jobRowId });
    }
  );

  // Poll the latest verification: live progress ("Verifying 187 of 269 URLs…"),
  // per-status counts over the verified population, and a staleness flag for
  // "files changed since this was verified".
  app.get<{ Params: SessionParams }>(
    "/api/sessions/:id/verify-urls/status",
    async (request) => {
      const sessionId = request.params.id;

      const jobResult = await pool.query<{
        id: string;
        status: string;
        files_total: number;
        files_done: number;
        items_changed: string;
        error: string | null;
      }>(
        `
          SELECT id, status, files_total, files_done, items_changed, error
          FROM maintenance_jobs
          WHERE session_id = $1 AND kind = 'verify-urls'
          ORDER BY started_at DESC
          LIMIT 1
        `,
        [sessionId]
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
          SELECT
            (SELECT MAX(checked_at) FROM verified_urls WHERE session_id = $1) AS verified_at,
            COALESCE(
              (SELECT files_mutated_at FROM sessions WHERE id = $1) >
                (SELECT MAX(checked_at) FROM verified_urls WHERE session_id = $1),
              false
            ) AS stale
        `,
        [sessionId]
      );

      const countsResult = await pool.query<{
        http_status: number | null;
        count: string;
      }>(
        `
          SELECT http_status, COUNT(*)::text AS count
          FROM verified_urls
          WHERE session_id = $1 AND is_deleted_from_sitemap = false
          GROUP BY http_status
          ORDER BY http_status ASC NULLS LAST
        `,
        [sessionId]
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
              error: jobRow.error
            }
          : null,
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
  app.post<{ Params: PatternParams; Body: { statuses?: unknown } }>(
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
      const fileDisplays = filesResult.rows.map((row) => row.display);

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
        use_verified: true,
        pattern_id: patternId
      });

      return reply.code(202).send({ job_row_id: jobRowId });
    }
  );
}
