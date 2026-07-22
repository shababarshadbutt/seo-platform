import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { ZipArchive } from "archiver";

import {
  cleanSitemaps,
  type CleanerInputFile,
  type CleanerOutputFile
} from "../sitemaps/cleaner.js";

// The Sitemap Cleaner is stateless — nothing is written to the DB or disk. The
// only server-side state is a short-lived in-memory cache holding each run's
// generated ZIP (so the SSE progress stream and the binary download can be two
// separate HTTP requests) plus the individual cleaned files + domain, which the
// "hand off to Migration" flow re-fetches without a re-upload (v1.37 Fix 2).
// TTL is 1 hour so the handoff token stays valid long enough for the user to
// start a migration after downloading.
const RUN_TTL_MS = 60 * 60 * 1000;

// Keepalive comment ping cadence for the SSE stream. During a long clean (e.g.
// 196 files) no progress data may flow for a while; without a periodic byte a
// proxy or the browser can drop the idle connection, which the frontend used to
// surface as the misleading "Cannot connect to backend". (v1.37 Fix 1)
const SSE_KEEPALIVE_MS = 15 * 1000;

// A single clean can run for many minutes on large file sets. Disable the
// per-request socket timeout for this route so neither the upload of all files
// nor the long processing phase is killed mid-stream. (v1.37 Fix 1)
const CLEANER_TIMEOUT_MS = 30 * 60 * 1000;

type CachedRun = {
  zip: Buffer;
  filename: string;
  domain: string;
  files: CleanerOutputFile[];
};
const runCache = new Map<string, CachedRun>();

function storeRun(token: string, run: CachedRun) {
  runCache.set(token, run);
  const timer = setTimeout(() => runCache.delete(token), RUN_TTL_MS);
  timer.unref?.();
}

function isXmlName(name: string) {
  return /\.xml(\.gz)?$/i.test(name);
}

// The cleaned outputs the Migration tool can ingest: XML sitemaps only. The run
// also bundles a duplicates-report.csv into the ZIP — that must not be handed
// off as a "sitemap". Both handoff endpoints index into this same filtered list
// so the metadata indices match the file-bytes route. (v1.37 Fix 2)
function handoffFiles(files: CleanerOutputFile[]) {
  return files.filter((file) => /\.xml$/i.test(file.filename));
}

function baseName(name: string) {
  return name.split(/[\\/]/).pop() ?? name;
}

// Pack the cleaned outputs into a ZIP buffer (archiver v8 exports classes).
function archiveToBuffer(files: CleanerOutputFile[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Level 0 = STORE (no compression) — speed over size, matching the session
    // download ZIPs (v1.34).
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("error", reject);
    archive.on("end", () => resolve(Buffer.concat(chunks)));

    for (const file of files) {
      archive.append(file.content, { name: file.filename });
    }

    void archive.finalize();
  });
}

export async function cleanerRoutes(app: FastifyInstance) {
  // Stateless clean: accepts XML files (or a ZIP of them) + domain + subfolder,
  // streams SSE progress, and finishes with a `done` event carrying the summary
  // and a one-time download token for the generated ZIP.
  app.post(
    "/api/cleaner/process",
    {
      // Disable the default per-request socket timeout: a large file set can take
      // many minutes to upload + clean, and the default would abort the request
      // mid-stream. Mirrors the session upload route. (v1.37 Fix 1)
      onRequest: (request, reply, done) => {
        request.raw.setTimeout(CLEANER_TIMEOUT_MS);
        reply.raw.setTimeout(CLEANER_TIMEOUT_MS);
        done();
      }
    },
    async (request, reply) => {
    const inputFiles: CleanerInputFile[] = [];
    let domain = "";
    let subfolder = "sitemaps";

    try {
      for await (const part of request.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "domain") {
            domain = String(part.value).trim();
          } else if (part.fieldname === "subfolder") {
            subfolder = String(part.value).trim();
          }

          continue;
        }

        const buffer = await part.toBuffer();
        const name = baseName(part.filename ?? "upload");

        if (name.toLowerCase().endsWith(".zip")) {
          // Expand a ZIP of sitemaps into individual XML inputs.
          const entries = new AdmZip(buffer).getEntries();

          for (const entry of entries) {
            const entryName = baseName(entry.entryName);

            if (
              !entry.isDirectory &&
              isXmlName(entryName) &&
              !entryName.startsWith(".")
            ) {
              inputFiles.push({
                filename: entryName,
                buffer: entry.getData()
              });
            }
          }
        } else if (isXmlName(name)) {
          inputFiles.push({ filename: name, buffer });
        }
        // Non-XML / non-ZIP uploads are ignored.
      }
    } catch (error) {
      return reply.code(400).send({
        error: "Bad Request",
        message:
          error instanceof Error
            ? `Could not read upload: ${error.message}`
            : "Could not read upload"
      });
    }

    if (!domain) {
      return reply
        .code(400)
        .send({ error: "Bad Request", message: "domain is required" });
    }

    try {
      // eslint-disable-next-line no-new
      new URL(domain);
    } catch {
      return reply.code(400).send({
        error: "Bad Request",
        message: "domain must be a valid URL (e.g. https://www.example.com)"
      });
    }

    if (inputFiles.length === 0) {
      return reply.code(400).send({
        error: "Bad Request",
        message: "no XML sitemap files provided (upload .xml files or a .zip)"
      });
    }

    // Take over the socket and stream Server-Sent Events. The CORS plugin's
    // onSend hook does not run on a hijacked response, so set the origin header
    // manually.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin":
        (request.headers.origin as string | undefined) ?? "*"
    });

    const send = (payload: unknown) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    // Periodic keepalive comment so an idle proxy/browser doesn't drop the
    // connection during the long processing phase. Comment lines (": …") are
    // ignored by the SSE parser. Cleared when the stream ends or the client
    // disconnects. (v1.37 Fix 1)
    const keepalive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(": keepalive\n\n");
      }
    }, SSE_KEEPALIVE_MS);
    keepalive.unref?.();
    request.raw.on("close", () => clearInterval(keepalive));

    send({
      type: "progress",
      stage: "start",
      current: 0,
      total: inputFiles.length,
      message: `Received ${inputFiles.length} file(s)`
    });

    try {
      const today = new Date().toISOString().slice(0, 10);
      const { result, files } = await cleanSitemaps({
        files: inputFiles,
        domain,
        subfolder: subfolder || "sitemaps",
        today,
        onProgress: (event) => send({ type: "progress", ...event })
      });

      send({ type: "progress", stage: "zip", message: "Packaging ZIP…" });

      const zip = await archiveToBuffer(files);
      const token = randomUUID();
      const zipFilename = `cleaned-sitemaps-${today}.zip`;

      // Cache the ZIP plus the individual cleaned files + domain so both the
      // binary download and the Migration handoff can use this one token.
      storeRun(token, { zip, filename: zipFilename, domain, files });

      send({
        type: "done",
        summary: result,
        download_token: token,
        zip_filename: zipFilename
      });
    } catch (error) {
      request.log.error({ error }, "cleaner process failed");
      send({
        type: "error",
        message: error instanceof Error ? error.message : "Cleaning failed"
      });
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  }
  );

  // Stream a previously generated ZIP by its one-time token.
  app.get<{ Params: { token: string } }>(
    "/api/cleaner/download/:token",
    async (request, reply) => {
      const entry = runCache.get(request.params.token);

      if (!entry) {
        return reply.code(404).send({
          error: "Not Found",
          message: "download expired or not found — run the cleaner again"
        });
      }

      reply.header("content-type", "application/zip");
      reply.header(
        "content-disposition",
        `attachment; filename="${entry.filename}"`
      );

      return reply.send(entry.zip);
    }
  );

  // Migration handoff — metadata: the cleaned domain + the list of cleaned files
  // (name + byte size) for a run token, so the Migration "New Analysis" page can
  // pre-fill the base URL and show the file list. (v1.37 Fix 2)
  app.get<{ Params: { token: string } }>(
    "/api/cleaner/handoff/:token",
    async (request, reply) => {
      const entry = runCache.get(request.params.token);

      if (!entry) {
        return reply.code(404).send({
          error: "Not Found",
          message: "cleaner session expired — please re-run the cleaner"
        });
      }

      return {
        domain: entry.domain,
        files: handoffFiles(entry.files).map((file, index) => ({
          index,
          filename: file.filename,
          size: Buffer.byteLength(file.content)
        }))
      };
    }
  );

  // Migration handoff — bytes: stream one cleaned file (by its index in the
  // run's file list) so the New Analysis page can rebuild it as an upload
  // without the user re-selecting anything. (v1.37 Fix 2)
  app.get<{ Params: { token: string; index: string } }>(
    "/api/cleaner/handoff/:token/file/:index",
    async (request, reply) => {
      const entry = runCache.get(request.params.token);

      if (!entry) {
        return reply.code(404).send({
          error: "Not Found",
          message: "cleaner session expired — please re-run the cleaner"
        });
      }

      const index = Number(request.params.index);
      const file = Number.isInteger(index)
        ? handoffFiles(entry.files)[index]
        : undefined;

      if (!file) {
        return reply.code(404).send({
          error: "Not Found",
          message: "cleaned file not found"
        });
      }

      reply.header("content-type", "application/xml; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="${file.filename}"`
      );

      return reply.send(file.content);
    }
  );
}
