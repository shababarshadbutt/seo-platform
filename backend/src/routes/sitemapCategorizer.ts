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
  latestCategorizerJob,
  type CategorizerPhase
} from "../jobs/categorizerJobState.js";
import {
  enqueueCategorizerCategorizeJob,
  enqueueCategorizerGenerateJob,
  enqueueCategorizerIngestJob,
  enqueueCategorizerStatusCheckJob
} from "../queue/categorizerQueue.js";

// Routes for the Sitemap Categorizer tool — a standalone module (own session
// table, own queue) from Migration/Cleaner/sitemap-regenerate. Its own plugin
// rather than more surface on sessions.ts, which is already enormous and
// scoped to the Migration tool's session/pattern model.

const PHASES: CategorizerPhase[] = ["ingest", "status-check", "categorize", "generate"];

type SessionParams = { id: string };
type PhaseParams = { id: string; phase: string };

function badRequest(message: string) {
  return { error: "Bad Request", message };
}

function notFound(message: string) {
  return { error: "Not Found", message };
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
const PRECEDING_PHASE: Partial<Record<CategorizerPhase, CategorizerPhase>> = {
  "status-check": "ingest",
  categorize: "status-check",
  generate: "categorize"
};

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
  // categorize | generate. Each enqueues onto the per-session singleton job
  // (categorizerQueue.ts), so a repeat call while one is already running
  // attaches to it rather than starting a second.
  for (const phase of PHASES) {
    app.post<{ Params: SessionParams }>(
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

          if (!precedingJob || precedingJob.status !== "COMPLETE") {
            return reply.code(409).send({
              error: "Conflict",
              message: `The "${precedingPhase}" phase must complete before "${phase}" can start`
            });
          }
        }

        const enqueue =
          phase === "ingest"
            ? enqueueCategorizerIngestJob
            : phase === "status-check"
              ? enqueueCategorizerStatusCheckJob
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

  // Live preview of the categorize phase's output, grouped by category —
  // available as soon as categorize has written rows, even mid-run, and
  // independent of chunking (which only happens at generate time).
  app.get<{ Params: SessionParams }>(
    "/api/sitemap-categorizer/sessions/:id/categories",
    async (request) => {
      const result = await pool.query<{ category: string; url_count: string }>(
        `
          SELECT category, COUNT(*)::text AS url_count
          FROM categorizer_urls
          WHERE session_id = $1 AND category_state = 'categorized'
          GROUP BY category
          ORDER BY category
        `,
        [request.params.id]
      );

      return result.rows.map((row) => ({
        category: row.category,
        urlCount: Number(row.url_count)
      }));
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
        return reply.code(404).send(notFound("No generated files yet for this session"));
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
        return reply.code(404).send(notFound("No 404 URLs recorded for this session"));
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
}
