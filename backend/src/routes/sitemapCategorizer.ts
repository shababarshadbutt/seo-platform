import path from "node:path";

import { ZipArchive } from "archiver";
import type { FastifyInstance } from "fastify";

import {
  config,
  s3SourceConfigError,
  sftpConfigError
} from "../config.js";
import { pool } from "../db/pool.js";
import {
  DEFAULT_URLS_PER_FILE,
  validateMaxUrlsPerFile
} from "../sitemaps/categorizerMaxUrlsPerFile.js";
import { buildSyntheticSitemapXml } from "../sitemaps/csvToSitemapXml.js";
import {
  insertSkippedCategorizerJob,
  latestCategorizerJob,
  type CategorizerPhase
} from "../jobs/categorizerJobState.js";
import {
  enqueueCategorizerCategorizeJob,
  enqueueCategorizerGenerateJob,
  enqueueCategorizerIngestJob,
  enqueueCategorizerStatusCheckJob,
  enqueueCategorizerStatusSampleJob
} from "../queue/categorizerQueue.js";

// Routes for the Sitemap Categorizer tool — a standalone module (own session
// table, own queue) from Migration/Cleaner/sitemap-regenerate. Its own plugin
// rather than more surface on sessions.ts, which is already enormous and
// scoped to the Migration tool's session/pattern model.

const PHASES: CategorizerPhase[] = ["ingest", "status-check", "categorize", "generate"];

type SessionParams = { id: string };
type PhaseParams = { id: string; phase: string };
type CategoryParams = { id: string; category: string };
type CursorQuery = { cursor?: string; limit?: string };
type BucketSampleQuery = CursorQuery & { bucket?: string };

const DEFAULT_SAMPLE_LIMIT = 50;
const MAX_SAMPLE_LIMIT = 200;

// Shared cursor/limit parsing for every keyset-paginated preview endpoint
// below — categorizer_urls is hash-partitioned for tens-of-millions-row
// sessions, so these all page by "id > cursor ORDER BY id", never OFFSET.
function parseCursor(raw: string | undefined): number {
  const value = Number(raw ?? 0);

  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseLimit(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_SAMPLE_LIMIT);

  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_SAMPLE_LIMIT;
  }

  return Math.min(value, MAX_SAMPLE_LIMIT);
}

const STATUS_BUCKETS = [
  "2xx",
  "3xx",
  "404",
  "4xx",
  "5xx",
  "probe_failed"
] as const;
type StatusBucket = (typeof STATUS_BUCKETS)[number];

// Mirrors the bucket CASE expression in the /status-breakdown route — kept in
// one place so the breakdown counts and the per-bucket sample/download
// queries can never drift apart.
function statusBucketWhereClause(bucket: string): string | null {
  switch (bucket as StatusBucket) {
    case "2xx":
      return "http_status BETWEEN 200 AND 299";
    case "3xx":
      return "http_status BETWEEN 300 AND 399";
    case "404":
      return "http_status = 404";
    case "4xx":
      return "http_status BETWEEN 400 AND 499 AND http_status <> 404";
    case "5xx":
      return "http_status BETWEEN 500 AND 599";
    case "probe_failed":
      return "http_status IS NULL";
    default:
      return null;
  }
}

function badRequest(message: string) {
  return { error: "Bad Request", message };
}

function notFound(message: string) {
  return { error: "Not Found", message };
}

// A 404 that distinguishes GOOD news (e.g. a site with genuinely zero real
// 404s — nothing to exclude, not a bug) from something the user should
// investigate (e.g. nothing was ever ingested/categorized/generated).
// `reason` is a stable machine-readable tag the frontend branches on;
// `severity` picks the styling — "info" renders as a neutral/positive note,
// "warning" keeps the existing red-alert treatment.
function emptyResult(
  message: string,
  reason: string,
  severity: "info" | "warning"
) {
  return { error: "Not Found", message, reason, severity };
}

type CategorizerSessionRow = {
  id: string;
  name: string;
  base_url: string;
  source_kind: "s3" | "sftp";
  source_domain: string;
  user_agent: string;
  status: string;
  max_urls_per_file: number;
  created_at: string;
  updated_at: string;
  error: string | null;
};

async function fetchSession(sessionId: string): Promise<CategorizerSessionRow | null> {
  const result = await pool.query<CategorizerSessionRow>(
    `SELECT id, name, base_url, source_kind, source_domain, user_agent, status,
            max_urls_per_file, created_at, updated_at, error
     FROM categorizer_sessions
     WHERE id = $1`,
    [sessionId]
  );

  return result.rows[0] ?? null;
}

// The phase immediately before each one — used to gate a phase on its
// predecessor having COMPLETEd, so a route can reject with a clear 409
// instead of letting the job fail asynchronously hours into a run (the job
// processors enforce the same gate themselves as a second line of defense —
// see categorizerCategorizeJob.ts / categorizerGenerateJob.ts).
//
// Categorize now comes right after ingest (it only needs URL path shape, not
// HTTP status — see categorizerCategorizeJob.ts), and status-check moved
// after it: it's a per-CATEGORY confidence pass over categorize's output now,
// not a per-URL gate in front of it (categorizerStatusSampleJob.ts).
const PRECEDING_PHASE: Partial<Record<CategorizerPhase, CategorizerPhase>> = {
  categorize: "ingest",
  "status-check": "categorize",
  generate: "status-check"
};

// A status-check job is "done enough" for generate to proceed whether it
// actually ran (COMPLETE, full or sampled) or was explicitly skipped by the
// user (SKIPPED) — see the status-check POST handler's `mode: 'skip'` branch.
const DONE_STATUSES = new Set(["COMPLETE", "SKIPPED"]);

export async function sitemapCategorizerRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      name?: unknown;
      base_url?: unknown;
      source_kind?: unknown;
      source_domain?: unknown;
      user_agent?: unknown;
      max_urls_per_file?: unknown;
    };
  }>("/api/sitemap-categorizer/sessions", async (request, reply) => {
    const { name, base_url: baseUrl, source_kind: sourceKind, source_domain: sourceDomain } =
      request.body ?? {};

    if (typeof name !== "string" || name.trim() === "") {
      return reply.code(400).send(badRequest("name is required"));
    }

    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      return reply.code(400).send(badRequest("base_url is required"));
    }

    if (sourceKind !== "s3" && sourceKind !== "sftp") {
      return reply.code(400).send(badRequest('source_kind must be "s3" or "sftp"'));
    }

    if (typeof sourceDomain !== "string" || sourceDomain.trim() === "") {
      return reply.code(400).send(badRequest("source_domain is required"));
    }

    const configError =
      sourceKind === "s3" ? s3SourceConfigError() : sftpConfigError();

    if (configError) {
      return reply.code(503).send({ error: "Service Unavailable", message: configError });
    }

    const userAgent =
      typeof request.body?.user_agent === "string" && request.body.user_agent.trim() !== ""
        ? request.body.user_agent
        : config.defaultHttpUserAgent;

    const maxUrlsPerFileInput =
      request.body?.max_urls_per_file === undefined
        ? DEFAULT_URLS_PER_FILE
        : Number(request.body.max_urls_per_file);
    const maxUrlsValidation = validateMaxUrlsPerFile(maxUrlsPerFileInput);

    if (!maxUrlsValidation.ok) {
      return reply.code(400).send(badRequest(maxUrlsValidation.error));
    }

    const inserted = await pool.query<{ id: string }>(
      `
        INSERT INTO categorizer_sessions
          (name, base_url, source_kind, source_domain, user_agent, max_urls_per_file)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [name, baseUrl, sourceKind, sourceDomain, userAgent, maxUrlsValidation.value]
    );

    const session = await fetchSession(inserted.rows[0].id);

    return reply.code(201).send(session);
  });

  app.get("/api/sitemap-categorizer/sessions", async () => {
    const result = await pool.query<CategorizerSessionRow>(
      `SELECT id, name, base_url, source_kind, source_domain, user_agent, status,
              max_urls_per_file, created_at, updated_at, error
       FROM categorizer_sessions
       ORDER BY created_at DESC`
    );

    return result.rows;
  });

  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id",
    async (request, reply) => {
      const session = await fetchSession(request.params.id);

      if (!session) {
        return reply.code(404).send(notFound("Categorizer session not found"));
      }

      return session;
    }
  );

  // One route per phase start/resume: POST .../ingest | status-check |
  // categorize | generate.
  //
  // Guarded by the categorizer_jobs row, NOT by BullMQ job state: a chunked
  // phase's own time-box continuation (see categorizerQueue.ts's
  // enqueueContinuation) runs under a fresh BullMQ job id every chunk, so the
  // ORIGINAL singleton job this route would check shows "completed" after
  // the very first chunk even though the phase is still genuinely running.
  // categorizer_jobs_one_active_per_phase (migration 064) is the real lock —
  // if it shows an active (PENDING/RUNNING) row, this just attaches to it
  // instead of enqueueing a second run.
  for (const phase of PHASES) {
    app.post<{ Params: SessionParams; Body: { mode?: unknown } }>(
      `/api/sitemap-categorizer/sessions/:id/${phase}`,
      async (request, reply) => {
        const sessionId = request.params.id;
        const session = await fetchSession(sessionId);

        if (!session) {
          return reply.code(404).send(notFound("Categorizer session not found"));
        }

        const precedingPhase = PRECEDING_PHASE[phase];

        if (precedingPhase) {
          const precedingJob = await latestCategorizerJob(sessionId, precedingPhase);

          if (!precedingJob || !DONE_STATUSES.has(precedingJob.status)) {
            return reply.code(409).send({
              error: "Conflict",
              message: `The "${precedingPhase}" phase must complete before "${phase}" can start`
            });
          }
        }

        const activeJob = await latestCategorizerJob(sessionId, phase);

        if (activeJob && (activeJob.status === "PENDING" || activeJob.status === "RUNNING")) {
          return reply.code(202).send({ job_id: null, status: activeJob.status });
        }

        // status-check alone offers a choice: 'sampled' (default — a
        // per-category confidence pass, viable at tens-of-millions-of-URLs
        // scale), 'full' (the original per-URL sweep, opt-in), or 'skip'
        // (no HTTP work at all — every categorized URL flows straight to
        // generate, see categorizerGenerateJob.ts which has no status
        // dependency of its own).
        if (phase === "status-check") {
          const mode = request.body?.mode;

          if (mode === "skip") {
            const job = await insertSkippedCategorizerJob(sessionId, "status-check");

            await pool.query(
              "UPDATE categorizer_sessions SET status = 'STATUS_CHECKED', updated_at = now() WHERE id = $1",
              [sessionId]
            );

            return reply.code(202).send({ job_id: job.id, status: job.status });
          }

          const enqueueStatusCheck =
            mode === "full" ? enqueueCategorizerStatusCheckJob : enqueueCategorizerStatusSampleJob;
          const job = await enqueueStatusCheck({ session_id: sessionId });

          return reply.code(202).send({ job_id: job.id });
        }

        const enqueue =
          phase === "ingest"
            ? enqueueCategorizerIngestJob
            : phase === "categorize"
              ? enqueueCategorizerCategorizeJob
              : enqueueCategorizerGenerateJob;

        const job = await enqueue({ session_id: sessionId });

        return reply.code(202).send({ job_id: job.id });
      }
    );
  }

  // Poll one phase's progress — a durable DB row (categorizer_jobs), not
  // BullMQ's own job.updateProgress: a status-check run can span days, far
  // outliving any single BullMQ job attempt, so the DB row is the only
  // source of truth that survives a worker restart. See
  // categorizerStatusCheckJob.ts's continuation-re-enqueue design.
  app.get<{ Params: PhaseParams }>(
    "/api/sitemap-categorizer/sessions/:id/jobs/:phase",
    async (request, reply) => {
      const { id: sessionId, phase } = request.params;

      if (!PHASES.includes(phase as CategorizerPhase)) {
        return reply.code(400).send(badRequest(`phase must be one of: ${PHASES.join(", ")}`));
      }

      const jobRow = await latestCategorizerJob(sessionId, phase as CategorizerPhase);

      if (!jobRow) {
        return reply.code(404).send(notFound(`Phase "${phase}" has not been started`));
      }

      return jobRow;
    }
  );

  // Ingest preview: per-file URL breakdown + a total, so the Ingest step can
  // show real output instead of a bare file count. total_urls is the ground
  // truth for "did ingest actually produce anything" — items_total on the
  // job row is a FILE count, not a URL count (categorizerIngestJob.ts), so it
  // can't tell "0 files found" apart from "files found, 0 URLs extracted".
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/ingest-summary",
    async (request) => {
      const sessionId = request.params.id;

      const totalResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1`,
        [sessionId]
      );
      const filesResult = await pool.query<{ source_file: string | null; url_count: string }>(
        `
          SELECT source_file, COUNT(*)::text AS url_count
          FROM categorizer_urls
          WHERE session_id = $1
          GROUP BY source_file
          ORDER BY COUNT(*) DESC
          LIMIT 50
        `,
        [sessionId]
      );

      return {
        total_urls: Number(totalResult.rows[0]?.count ?? 0),
        files: filesResult.rows.map((row) => ({
          source_file: row.source_file,
          url_count: Number(row.url_count)
        }))
      };
    }
  );

  // A sample page of ingested URLs, keyset-paginated on the table's own PK —
  // this table can hold tens of millions of rows per session, so there is no
  // "list them all" route, only "give me the next page after this cursor".
  app.get<{ Params: SessionParams; Querystring: CursorQuery }>(
    "/api/sitemap-categorizer/sessions/:id/ingest-urls",
    async (request) => {
      const sessionId = request.params.id;
      const cursor = parseCursor(request.query.cursor);
      const limit = parseLimit(request.query.limit);

      const result = await pool.query<{ id: string; url: string; source_file: string | null }>(
        `
          SELECT id::text AS id, url, source_file
          FROM categorizer_urls
          WHERE session_id = $1 AND id > $2
          ORDER BY id
          LIMIT $3
        `,
        [sessionId, cursor, limit]
      );

      return {
        urls: result.rows,
        next_cursor:
          result.rows.length === limit ? result.rows[result.rows.length - 1].id : null
      };
    }
  );

  // HTTP status-code breakdown for the Check-status step. Kept distinct from
  // "checking" (truly unchecked) and "checked but http_status is NULL" (a
  // probe that ran but got no status back) rather than folding either into
  // the others — categorizerCategorizeJob.ts's own "http_status IS DISTINCT
  // FROM 404" treats a NULL the same as a real non-404 response, which this
  // breakdown makes visible rather than silent.
  //
  // skipped_count is its OWN number, not merged into pending or checked: a
  // 'skipped' row (categorizerStatusSampleJob.ts) was never individually
  // probed, but it also isn't "not yet looked at" — it's trusted via its
  // category's sample. Collapsing it into either existing bucket would make
  // one of them lie about what actually happened to those URLs.
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/status-breakdown",
    async (request) => {
      const sessionId = request.params.id;

      const pendingResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND check_state NOT IN ('checked', 'skipped')`,
        [sessionId]
      );
      const checkedResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND check_state = 'checked'`,
        [sessionId]
      );
      const skippedResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND check_state = 'skipped'`,
        [sessionId]
      );
      const bucketsResult = await pool.query<{ bucket: string; count: string }>(
        `
          SELECT
            CASE
              WHEN http_status IS NULL THEN 'probe_failed'
              WHEN http_status = 404 THEN '404'
              WHEN http_status BETWEEN 200 AND 299 THEN '2xx'
              WHEN http_status BETWEEN 300 AND 399 THEN '3xx'
              WHEN http_status BETWEEN 400 AND 499 THEN '4xx'
              WHEN http_status BETWEEN 500 AND 599 THEN '5xx'
              ELSE 'other'
            END AS bucket,
            COUNT(*)::text AS count
          FROM categorizer_urls
          WHERE session_id = $1 AND check_state = 'checked'
          GROUP BY bucket
        `,
        [sessionId]
      );

      const buckets: Record<string, number> = {};

      for (const bucket of STATUS_BUCKETS) {
        buckets[bucket] = 0;
      }

      for (const row of bucketsResult.rows) {
        buckets[row.bucket] = Number(row.count);
      }

      return {
        pending_count: Number(pendingResult.rows[0]?.count ?? 0),
        checked_count: Number(checkedResult.rows[0]?.count ?? 0),
        skipped_count: Number(skippedResult.rows[0]?.count ?? 0),
        buckets
      };
    }
  );

  // A sample of URLs in one status bucket (see statusBucketWhereClause),
  // keyset-paginated the same way as every other preview route here.
  app.get<{ Params: SessionParams; Querystring: BucketSampleQuery }>(
    "/api/sitemap-categorizer/sessions/:id/status-breakdown/sample",
    async (request, reply) => {
      const sessionId = request.params.id;
      const whereClause = statusBucketWhereClause(request.query.bucket ?? "");

      if (!whereClause) {
        return reply
          .code(400)
          .send(badRequest(`bucket must be one of: ${STATUS_BUCKETS.join(", ")}`));
      }

      const cursor = parseCursor(request.query.cursor);
      const limit = parseLimit(request.query.limit);

      const result = await pool.query<{ id: string; url: string; http_status: number | null }>(
        `
          SELECT id::text AS id, url, http_status
          FROM categorizer_urls
          WHERE session_id = $1 AND check_state = 'checked' AND id > $2 AND ${whereClause}
          ORDER BY id
          LIMIT $3
        `,
        [sessionId, cursor, limit]
      );

      return {
        urls: result.rows,
        next_cursor:
          result.rows.length === limit ? result.rows[result.rows.length - 1].id : null
      };
    }
  );

  // Live preview of the categorize phase's output, grouped by category —
  // available as soon as categorize has written rows, even mid-run, and
  // independent of chunking (which only happens at generate time).
  //
  // Includes 'excluded' rows in url_count's source set (not just
  // 'categorized') and left-joins categorizer_categories so a category the
  // sampled status-check dropped entirely (status BAD — see
  // categorizerStatusSampleJob.ts) still shows up here with its real
  // confidence, instead of silently vanishing once every one of its rows is
  // excluded. status/confidencePct are null until that category has been
  // sampled at all.
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/categories",
    async (request) => {
      const result = await pool.query<{
        category: string;
        url_count: string;
        status: string | null;
        confidence_pct: string | null;
      }>(
        `
          SELECT
            u.category,
            COUNT(*) FILTER (WHERE u.category_state = 'categorized')::text AS url_count,
            c.status,
            c.confidence_pct::text AS confidence_pct
          FROM categorizer_urls u
          LEFT JOIN categorizer_categories c
            ON c.session_id = u.session_id AND c.category = u.category
          WHERE u.session_id = $1 AND u.category_state IN ('categorized', 'excluded')
          GROUP BY u.category, c.status, c.confidence_pct
          ORDER BY u.category
        `,
        [request.params.id]
      );

      return result.rows.map((row) => ({
        category: row.category,
        urlCount: Number(row.url_count),
        status: row.status ?? "PENDING",
        confidencePct: row.confidence_pct === null ? null : Number(row.confidence_pct)
      }));
    }
  );

  // Drill-down: a sample of URLs within one category, keyset-paginated via
  // idx_categorizer_urls_session_category (session_id, category, id).
  app.get<{ Params: CategoryParams; Querystring: CursorQuery }>(
    "/api/sitemap-categorizer/sessions/:id/categories/:category/sample",
    async (request) => {
      const { id: sessionId, category } = request.params;
      const cursor = parseCursor(request.query.cursor);
      const limit = parseLimit(request.query.limit);

      const result = await pool.query<{ id: string; url: string }>(
        `
          SELECT id::text AS id, url
          FROM categorizer_urls
          WHERE session_id = $1 AND category = $2 AND category_state = 'categorized' AND id > $3
          ORDER BY id
          LIMIT $4
        `,
        [sessionId, category, cursor, limit]
      );

      return {
        urls: result.rows,
        next_cursor:
          result.rows.length === limit ? result.rows[result.rows.length - 1].id : null
      };
    }
  );

  // The actual generated output files (post-generate), for the download step.
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/output-files",
    async (request) => {
      const result = await pool.query<{
        category: string;
        chunk_index: number;
        filename: string;
        url_count: number;
      }>(
        `
          SELECT category, chunk_index, filename, url_count
          FROM categorizer_output_files
          WHERE session_id = $1
          ORDER BY category, chunk_index
        `,
        [request.params.id]
      );

      return result.rows;
    }
  );

  // ZIP of every generated output file plus sitemap-index.xml.
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/download",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = await fetchSession(sessionId);

      if (!session) {
        return reply.code(404).send(notFound("Categorizer session not found"));
      }

      const filesResult = await pool.query<{ filename: string }>(
        `SELECT filename FROM categorizer_output_files WHERE session_id = $1 ORDER BY category, chunk_index`,
        [sessionId]
      );

      if (filesResult.rowCount === 0) {
        // There's no "good news" version of zero output files — diagnose WHY
        // so the message points at the actual upstream gap instead of a bare
        // "not found".
        const ingestedResult = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1`,
          [sessionId]
        );

        if (Number(ingestedResult.rows[0]?.count ?? 0) === 0) {
          return reply.code(404).send(
            emptyResult(
              "No URLs were ever ingested for this session — check the source domain and that it has sitemap files.",
              "no_urls_ingested",
              "warning"
            )
          );
        }

        const categorizedResult = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND category_state = 'categorized'`,
          [sessionId]
        );

        if (Number(categorizedResult.rows[0]?.count ?? 0) === 0) {
          return reply.code(404).send(
            emptyResult(
              "No URLs were categorized for this session — every ingested URL may have been excluded as a 404, or the categorize phase hasn't completed.",
              "no_categorized_urls",
              "warning"
            )
          );
        }

        return reply.code(404).send(
          emptyResult(
            "No generated files yet for this session — run Generate to write the output sitemap set.",
            "not_generated_yet",
            "warning"
          )
        );
      }

      const archive = new ZipArchive({ zlib: { level: 0 } });

      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename="${session.source_domain}-sitemaps.zip"`
      );

      archive.on("error", (error) => {
        request.log.error({ error }, "categorizer download archive error");
        reply.raw.destroy(error);
      });

      for (const row of filesResult.rows) {
        const storedPath = path.join(
          config.exportDir,
          `categorizer-${sessionId}-${row.filename}`
        );

        archive.file(storedPath, { name: row.filename });
      }

      const indexStoredPath = path.join(
        config.exportDir,
        `categorizer-${sessionId}-sitemap-index.xml`
      );

      archive.file(indexStoredPath, { name: "sitemap-index.xml" });

      void archive.finalize();

      return reply.send(archive);
    }
  );

  // 404 URLs excluded from every output sitemap, as a downloadable list — the
  // same shape as sessions.ts's download-failed-urls endpoint.
  //
  // NOT CURSOR-PAGINATED: buildSyntheticSitemapXml takes a full array by
  // contract (shared with the existing failed-urls download this mirrors),
  // and a single query here is consistent with that. At genuinely extreme
  // scale (hundreds of thousands of 404s) this holds that list in memory for
  // one request — acceptable for a list of URL strings, but worth revisiting
  // with a streaming XML writer if a real session ever makes it the
  // bottleneck.
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/download-404s",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = await fetchSession(sessionId);

      if (!session) {
        return reply.code(404).send(notFound("Categorizer session not found"));
      }

      const urlsResult = await pool.query<{ url: string }>(
        `SELECT url FROM categorizer_urls WHERE session_id = $1 AND http_status = 404 ORDER BY url ASC`,
        [sessionId]
      );

      if (urlsResult.rowCount === 0) {
        // Zero real 404s is a legitimate, GOOD outcome when checking
        // actually happened — not an error — so long as status-check ran at
        // all. If it never ran (or produced nothing), that's the opposite:
        // something upstream the user should look at.
        const checkedResult = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM categorizer_urls WHERE session_id = $1 AND check_state = 'checked'`,
          [sessionId]
        );

        if (Number(checkedResult.rows[0]?.count ?? 0) === 0) {
          return reply.code(404).send(
            emptyResult(
              "No URLs have been status-checked for this session yet.",
              "nothing_checked",
              "warning"
            )
          );
        }

        return reply.code(404).send(
          emptyResult(
            "No 404 URLs were found for this session — every checked URL responded.",
            "no_404s_found",
            "info"
          )
        );
      }

      const xml = buildSyntheticSitemapXml(urlsResult.rows.map((row) => row.url));
      const archive = new ZipArchive({ zlib: { level: 0 } });

      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename="${session.source_domain}-404-urls.zip"`
      );

      archive.on("error", (error) => {
        request.log.error({ error }, "categorizer download-404s archive error");
        reply.raw.destroy(error);
      });

      archive.append(xml, { name: "404-urls.xml" });
      void archive.finalize();

      return reply.send(archive);
    }
  );

  // Rows the categorize / status-check / status-sample phases couldn't write
  // due to a per-row data error (e.g. a corrupted id) and isolated instead of
  // letting the whole phase abort — see batchWriteFaultIsolation.ts. A plain
  // CSV, not a sitemap ZIP like download-404s: these aren't a "resubmit to
  // GSC" list, they're a short operator-review list (expected to be rare —
  // a healthy run produces none).
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/download-categorize-failures",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = await fetchSession(sessionId);

      if (!session) {
        return reply.code(404).send(notFound("Categorizer session not found"));
      }

      const failedResult = await pool.query<{ url: string; error: string | null }>(
        `
          SELECT url, error
          FROM categorizer_urls
          WHERE session_id = $1 AND (category_state = 'failed' OR check_state = 'failed')
          ORDER BY url ASC
        `,
        [sessionId]
      );

      if (failedResult.rowCount === 0) {
        return reply.code(404).send(
          emptyResult(
            "No URLs failed to process for this session — nothing to review.",
            "no_failures_found",
            "info"
          )
        );
      }

      const csvField = (value: string) =>
        /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      const csv = [
        "url,error",
        ...failedResult.rows.map(
          (row) => `${csvField(row.url)},${csvField(row.error ?? "")}`
        )
      ].join("\n");

      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="${session.source_domain}-categorize-failures.csv"`
      );

      return reply.send(csv);
    }
  );

  // The HITL "fix individually" action for a row download-categorize-failures
  // surfaced: manually assign the category a human decided, rather than
  // whatever caused the automatic write to fail. Scoped to rows ALREADY
  // category_state='failed' for this session — this is a recovery action for
  // that specific failure class, not a general-purpose category editor.
  // Matched by url (not a row id) so fixing exactly the kind of row this
  // mechanism exists for never itself requires casting that row's id.
  app.patch<{ Params: SessionParams; Body: { url?: unknown; category?: unknown } }>(
    "/api/sitemap-categorizer/sessions/:id/category-failures",
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = await fetchSession(sessionId);

      if (!session) {
        return reply.code(404).send(notFound("Categorizer session not found"));
      }

      const { url, category } = request.body ?? {};

      if (typeof url !== "string" || url.trim() === "") {
        return reply.code(400).send(badRequest("url is required"));
      }

      if (typeof category !== "string" || category.trim() === "") {
        return reply.code(400).send(badRequest("category is required"));
      }

      const result = await pool.query(
        `
          UPDATE categorizer_urls
          SET category = $3, category_state = 'categorized', rule_matched = 'manual-override', error = NULL
          WHERE session_id = $1 AND url = $2 AND category_state = 'failed'
        `,
        [sessionId, url, category.trim()]
      );

      if (result.rowCount === 0) {
        return reply.code(404).send(
          notFound("No failed row matches that URL for this session — it may already be fixed.")
        );
      }

      return reply.code(204).send();
    }
  );
}
