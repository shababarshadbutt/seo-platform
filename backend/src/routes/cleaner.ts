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
// generated ZIP so the SSE progress stream and the binary download can be two
// separate HTTP requests (SSE can't also carry a binary body).
const ZIP_TTL_MS = 10 * 60 * 1000;

type CachedZip = { zip: Buffer; filename: string };
const zipCache = new Map<string, CachedZip>();

function storeZip(token: string, zip: Buffer, filename: string) {
  zipCache.set(token, { zip, filename });
  const timer = setTimeout(() => zipCache.delete(token), ZIP_TTL_MS);
  timer.unref?.();
}

function isXmlName(name: string) {
  return /\.xml(\.gz)?$/i.test(name);
}

function baseName(name: string) {
  return name.split(/[\\/]/).pop() ?? name;
}

// Pack the cleaned outputs into a ZIP buffer (archiver v8 exports classes).
function archiveToBuffer(files: CleanerOutputFile[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 9 } });
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
  app.post("/api/cleaner/process", async (request, reply) => {
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

      storeZip(token, zip, zipFilename);

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
      res.end();
    }
  });

  // Stream a previously generated ZIP by its one-time token.
  app.get<{ Params: { token: string } }>(
    "/api/cleaner/download/:token",
    async (request, reply) => {
      const entry = zipCache.get(request.params.token);

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
}
