import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { ZipArchive } from "archiver";

import { config, sftpConfigError } from "../config.js";
import {
  assertSafeDomain,
  downloadSftpFile,
  listSftpSitemapFiles
} from "../sftp/sftpClient.js";
import {
  cleanSitemaps,
  type CleanerInputFile,
  type CleanerOutputFile
} from "../sitemaps/cleaner.js";

// The Sitemap Cleaner is stateless — nothing is written to the DB. Uploads and
// generated files ARE spilled to disk (a per-run working directory under the
// uploads volume) rather than held in memory, so a large file set never blows
// the heap. The only server-side state is a short-lived in-memory cache mapping
// each run's download token to the on-disk paths of its ZIP + cleaned files
// (plus the domain), which the SSE→download split and the "hand off to
// Migration" flow (v1.37 Fix 2) reuse without a re-upload. TTL is 1 hour so the
// handoff token stays valid long enough for the user to start a migration; when
// it expires the whole working directory is deleted.
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

// Base directory for per-run cleaner working dirs, on the same uploads volume
// the parser already reads from.
const CLEANER_WORK_ROOT = path.join(config.uploadDir, "cleaner");

type CachedRun = {
  dir: string; // per-run working directory; removed wholesale on TTL expiry
  zipPath: string;
  filename: string;
  domain: string;
  files: CleanerOutputFile[]; // cleaned outputs, referenced by on-disk path
};
const runCache = new Map<string, CachedRun>();

function storeRun(token: string, run: CachedRun) {
  runCache.set(token, run);
  const timer = setTimeout(() => {
    runCache.delete(token);
    void rm(run.dir, { recursive: true, force: true });
  }, RUN_TTL_MS);
  timer.unref?.();
}

// Look up a completed run by its handoff token. Exported so the Migration side
// can ingest the cleaned files DIRECTLY off disk instead of shipping them to the
// browser and back — see /api/sessions/:id/sources/cleaner.
export function getCleanerRun(token: string) {
  return runCache.get(token);
}

function isXmlName(name: string) {
  return /\.xml(\.gz)?$/i.test(name);
}

// The cleaned outputs the Migration tool can ingest: XML sitemaps only. The run
// also bundles a duplicates-report.csv into the ZIP — that must not be handed
// off as a "sitemap". Both handoff endpoints index into this same filtered list
// so the metadata indices match the file-bytes route. (v1.37 Fix 2)
export function cleanerHandoffFiles(files: CleanerOutputFile[]) {
  return handoffFiles(files);
}

function handoffFiles(files: CleanerOutputFile[]) {
  return files.filter((file) => /\.xml$/i.test(file.filename));
}

function baseName(name: string) {
  return name.split(/[\\/]/).pop() ?? name;
}

// Pack the cleaned outputs into a ZIP written straight to disk (never buffered
// in memory). archiver streams each entry from its source file, so only small
// per-file chunks are ever resident. Level 0 = STORE (no compression) — speed
// over size, matching the session download ZIPs (v1.34).
function archiveToFile(
  files: CleanerOutputFile[],
  zipPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const output = createWriteStream(zipPath);

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);

    for (const file of files) {
      archive.file(file.path, { name: file.filename });
    }

    void archive.finalize();
  });
}

// Everything after the input files are on disk: clean, package, cache the run,
// emit the terminal frame. Shared by the upload route and the SFTP route so the
// two sources cannot drift — in particular so the SFTP source produces the exact
// same `done` frame with a download_token, which is what makes the existing
// Cleaner→Migration handoff (v1.37) work for it with no changes at all.
//
// Returns whether the run was cached (handed off); the caller removes the working
// directory when it wasn't.
async function cleanPackageAndFinish(options: {
  inputFiles: CleanerInputFile[];
  domain: string;
  subfolder: string;
  runDir: string;
  inDir: string;
  outDir: string;
  send: (payload: unknown) => void;
  log: FastifyInstance["log"];
}): Promise<boolean> {
  const { inputFiles, domain, subfolder, runDir, inDir, outDir, send, log } =
    options;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { result, files } = await cleanSitemaps({
      files: inputFiles,
      domain,
      subfolder: subfolder || "sitemaps",
      today,
      outDir,
      onProgress: (event) => send({ type: "progress", ...event })
    });

    // Inputs are no longer needed — free the disk they occupy.
    await rm(inDir, { recursive: true, force: true });

    send({ type: "progress", stage: "zip", message: "Packaging ZIP…" });

    const zipFilename = `cleaned-sitemaps-${today}.zip`;
    const zipPath = path.join(runDir, zipFilename);
    await archiveToFile(files, zipPath);

    const token = randomUUID();

    // Cache the on-disk paths so both the binary download and the Migration
    // handoff can use this one token; the working dir is removed on TTL.
    storeRun(token, {
      dir: runDir,
      zipPath,
      filename: zipFilename,
      domain,
      files
    });

    send({
      type: "done",
      summary: result,
      download_token: token,
      zip_filename: zipFilename
    });

    return true;
  } catch (error) {
    log.error({ error }, "cleaner process failed");
    send({
      type: "error",
      message: error instanceof Error ? error.message : "Cleaning failed"
    });

    return false;
  }
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
      // Per-run working directory: in/ holds the spilled uploads, out/ the
      // cleaned files. Created up front and removed on any failure; on success
      // the inputs are deleted immediately and out/ + the ZIP live until the
      // run's TTL expires.
      const runId = randomUUID();
      const runDir = path.join(CLEANER_WORK_ROOT, runId);
      const inDir = path.join(runDir, "in");
      const outDir = path.join(runDir, "out");

      await mkdir(inDir, { recursive: true });
      await mkdir(outDir, { recursive: true });

      const cleanupRunDir = () =>
        void rm(runDir, { recursive: true, force: true });

      const inputFiles: CleanerInputFile[] = [];
      let domain = "";
      let subfolder = "sitemaps";
      // Client-reported selected-file count, used purely for the upload-stage
      // progress denominator (the client knows files.length; the server only
      // discovers it as parts stream in).
      let uploadTotal = 0;
      let fileIndex = 0;
      let spooled = 0;

      // SSE is started LAZILY, the instant the first real file part arrives, so
      // upload progress streams WHILE the remaining (2000+) files are still
      // spooling to disk — the phase that used to show a frozen spinner with no
      // count. Until the stream starts the response is a normal reply, so
      // pre-stream validation still returns a plain 400 JSON. (v1.43)
      let res: ServerResponse | null = null;
      let keepalive: ReturnType<typeof setInterval> | null = null;

      const send = (payload: unknown) => {
        if (res && !res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      const stopKeepalive = () => {
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
      };

      // Take over the socket and stream Server-Sent Events. The CORS plugin's
      // onSend hook does not run on a hijacked response, so set the origin
      // header manually. Returns the raw response so the caller assigns `res`
      // linearly (keeps TS's narrowing working across the later branches).
      const beginStream = (): ServerResponse => {
        reply.hijack();
        const stream = reply.raw;
        stream.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin":
            (request.headers.origin as string | undefined) ?? "*"
        });

        // Periodic keepalive comment so an idle proxy/browser doesn't drop the
        // connection during the long upload or processing phase. Comment lines
        // (": …") are ignored by the SSE parser. (v1.37 Fix 1)
        keepalive = setInterval(() => {
          if (!stream.writableEnded) {
            stream.write(": keepalive\n\n");
          }
        }, SSE_KEEPALIVE_MS);
        keepalive.unref?.();
        request.raw.on("close", stopKeepalive);

        return stream;
      };

      const badRequest = (message: string) => {
        cleanupRunDir();

        return reply.code(400).send({ error: "Bad Request", message });
      };

      const domainError = (): string | null => {
        if (!domain) {
          return "domain is required";
        }

        try {
          // eslint-disable-next-line no-new
          new URL(domain);
        } catch {
          return "domain must be a valid URL (e.g. https://www.example.com)";
        }

        return null;
      };

      const sendUploadProgress = () => {
        const remaining =
          uploadTotal > 0 ? Math.max(uploadTotal - spooled, 0) : null;

        send({
          type: "progress",
          stage: "upload",
          current: spooled,
          total: uploadTotal || undefined,
          message:
            remaining !== null
              ? `Uploaded ${spooled} of ${uploadTotal} file(s) — ${remaining} remaining`
              : `Uploaded ${spooled} file(s)…`
        });
      };

      try {
        for await (const part of request.parts()) {
          if (part.type === "field") {
            if (part.fieldname === "domain") {
              domain = String(part.value).trim();
            } else if (part.fieldname === "subfolder") {
              subfolder = String(part.value).trim();
            } else if (part.fieldname === "fileCount") {
              const parsedCount = Number.parseInt(String(part.value), 10);

              if (Number.isFinite(parsedCount) && parsedCount > 0) {
                uploadTotal = parsedCount;
              }
            }

            continue;
          }

          const name = baseName(part.filename ?? "upload");
          const isZip = name.toLowerCase().endsWith(".zip");
          const isXml = isXmlName(name);

          if (!isZip && !isXml) {
            // Non-XML / non-ZIP upload: drain the part so iteration can advance.
            await part.toBuffer();
            continue;
          }

          // First accepted file: the client sends domain/subfolder/fileCount
          // BEFORE the files, so domain is known here. Validate it (still a
          // plain 400 if bad — nothing hijacked yet), then take over the socket
          // and start streaming upload progress for every part that follows.
          if (!res) {
            const invalid = domainError();

            if (invalid) {
              return badRequest(invalid);
            }

            res = beginStream();
            send({
              type: "progress",
              stage: "upload",
              current: 0,
              total: uploadTotal || undefined,
              message: uploadTotal
                ? `Uploading 0 of ${uploadTotal} file(s)…`
                : "Uploading files…"
            });
          }

          if (isZip) {
            // Spill the uploaded ZIP to disk, then extract only its XML entries
            // to individual input files. AdmZip decompresses one entry at a
            // time via extractEntryTo, so no full set of decompressed buffers
            // is ever resident.
            const zipPath = path.join(inDir, `upload-${fileIndex}.zip`);
            fileIndex += 1;
            await pipeline(part.file, createWriteStream(zipPath));

            const zip = new AdmZip(zipPath);

            for (const entry of zip.getEntries()) {
              const entryName = baseName(entry.entryName);

              if (
                !entry.isDirectory &&
                isXmlName(entryName) &&
                !entryName.startsWith(".")
              ) {
                const dest = path.join(inDir, `${fileIndex}__${entryName}`);
                fileIndex += 1;
                zip.extractEntryTo(entry, inDir, false, true, false, baseName(dest));
                inputFiles.push({ filename: entryName, path: dest });
              }
            }

            await rm(zipPath, { force: true });
          } else {
            // Stream the uploaded file straight to disk — never buffered.
            const dest = path.join(inDir, `${fileIndex}__${name}`);
            fileIndex += 1;
            await pipeline(part.file, createWriteStream(dest));
            inputFiles.push({ filename: name, path: dest });
          }

          // One part finished spooling — advance the upload progress bar. This
          // is the feedback the old single-post-loop send() never gave. (v1.43)
          spooled += 1;
          sendUploadProgress();
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? `Could not read upload: ${error.message}`
            : "Could not read upload";

        if (res) {
          // Already streaming — report as an SSE error and close; a 400 can't
          // be sent on a hijacked socket.
          send({ type: "error", message });
          stopKeepalive();
          res.end();
          cleanupRunDir();

          return;
        }

        cleanupRunDir();

        return reply.code(400).send({ error: "Bad Request", message });
      }

      // Never started streaming ⇒ no accepted file was uploaded (or only junk
      // parts). Report the reason as a plain 400.
      if (!res) {
        const invalid = domainError();

        if (invalid) {
          return badRequest(invalid);
        }

        return badRequest(
          "no XML sitemap files provided (upload .xml files or a .zip)"
        );
      }

      // A ZIP part can arrive yet expand to zero XML entries.
      if (inputFiles.length === 0) {
        send({
          type: "error",
          message: "no XML sitemap files provided (upload .xml files or a .zip)"
        });
        stopKeepalive();
        res.end();
        cleanupRunDir();

        return;
      }

      send({
        type: "progress",
        stage: "start",
        current: 0,
        total: inputFiles.length,
        message: `Received ${inputFiles.length} file(s)`
      });

      let handedOff = false;

      try {
        handedOff = await cleanPackageAndFinish({
          inputFiles,
          domain,
          subfolder,
          runDir,
          inDir,
          outDir,
          send,
          log: request.log
        });
      } finally {
        stopKeepalive();
        res?.end();

        // If the run never made it into the cache (error or client gone), the
        // working dir would otherwise leak — remove it now.
        if (!handedOff) {
          cleanupRunDir();
        }
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

      let size: number;

      try {
        size = (await stat(entry.zipPath)).size;
      } catch {
        return reply.code(404).send({
          error: "Not Found",
          message: "download expired or not found — run the cleaner again"
        });
      }

      reply.header("content-type", "application/zip");
      reply.header("content-length", size);
      reply.header(
        "content-disposition",
        `attachment; filename="${entry.filename}"`
      );

      return reply.send(createReadStream(entry.zipPath));
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

      const files = await Promise.all(
        handoffFiles(entry.files).map(async (file, index) => ({
          index,
          filename: file.filename,
          size: (await stat(file.path)).size
        }))
      );

      return { domain: entry.domain, files };
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

      return reply.send(createReadStream(file.path));
    }
  );

  // Same clean, different SOURCE: pull a domain's sitemap folder over SFTP
  // instead of receiving an upload. No new SFTP logic and no new cleaning logic —
  // this reuses listSftpSitemapFiles/downloadSftpFile (exactly what Migration's
  // pull job uses) and then hands off to cleanPackageAndFinish, the same tail the
  // upload route runs. Because that tail emits the identical `done` frame with a
  // download_token, the existing Cleaner→Migration handoff (v1.37) works for this
  // source with no changes to it whatsoever.
  //
  // Gated by sftpConfigError(), so AWS_PUBLISH_ENABLED=false refuses it here too.
  app.post<{ Body: { domain?: unknown; site_url?: unknown; subfolder?: unknown } }>(
    "/api/cleaner/process-sftp",
    {
      onRequest: (request, reply, done) => {
        request.raw.setTimeout(CLEANER_TIMEOUT_MS);
        reply.raw.setTimeout(CLEANER_TIMEOUT_MS);
        done();
      }
    },
    async (request, reply) => {
      const configError = sftpConfigError();

      if (configError) {
        return reply
          .code(503)
          .send({ error: "Service Unavailable", message: configError });
      }

      const sftpDomain =
        typeof request.body?.domain === "string" ? request.body.domain.trim() : "";

      try {
        assertSafeDomain(sftpDomain);
      } catch {
        return reply
          .code(400)
          .send({ error: "Bad Request", message: "a valid domain is required" });
      }

      // The cleaner needs a site URL to build <loc> values. Default to the SFTP
      // folder name as a host; the client may override (e.g. to add www.).
      const siteUrl =
        typeof request.body?.site_url === "string" && request.body.site_url.trim()
          ? request.body.site_url.trim()
          : `https://${sftpDomain}`;
      const subfolder =
        typeof request.body?.subfolder === "string" && request.body.subfolder.trim()
          ? request.body.subfolder.trim()
          : "sitemaps";

      try {
        new URL(siteUrl);
      } catch {
        return reply.code(400).send({
          error: "Bad Request",
          message: "site_url must be a valid URL (e.g. https://www.example.com)"
        });
      }

      const runId = randomUUID();
      const runDir = path.join(CLEANER_WORK_ROOT, runId);
      const inDir = path.join(runDir, "in");
      const outDir = path.join(runDir, "out");

      await mkdir(inDir, { recursive: true });
      await mkdir(outDir, { recursive: true });

      let keepalive: NodeJS.Timeout | null = null;
      const stopKeepalive = () => {
        if (keepalive) {
          clearInterval(keepalive);
          keepalive = null;
        }
      };

      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin":
          (request.headers.origin as string | undefined) ?? "*"
      });

      const send = (payload: unknown) => {
        if (!stream.writableEnded) {
          stream.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      keepalive = setInterval(() => {
        if (!stream.writableEnded) {
          stream.write(": keepalive\n\n");
        }
      }, SSE_KEEPALIVE_MS);
      keepalive.unref?.();
      request.raw.on("close", stopKeepalive);

      let handedOff = false;

      try {
        // Total is known before the download loop, so every frame carries
        // current/total — same contract as the Migration pull progress.
        const remoteFiles = await listSftpSitemapFiles(sftpDomain);
        const total = remoteFiles.length;

        send({
          type: "progress",
          stage: "pull",
          current: 0,
          total,
          message: `Pulling ${total} file(s) from ${sftpDomain}`
        });

        if (total === 0) {
          send({
            type: "error",
            message: `No sitemap files found for ${sftpDomain} on the SFTP server.`
          });

          return;
        }

        const inputFiles: CleanerInputFile[] = [];
        let index = 0;

        for (const remote of remoteFiles) {
          index += 1;
          const localPath = path.join(inDir, path.basename(remote.name));

          try {
            await downloadSftpFile(sftpDomain, remote.name, localPath);
            inputFiles.push({ filename: remote.name, path: localPath });
            send({
              type: "progress",
              stage: "pull",
              current: index,
              total,
              message: `Pulled ${remote.name} (${index} of ${total})`
            });
          } catch (error) {
            // Don't leave a truncated download to be parsed as a real sitemap.
            await rm(localPath, { force: true }).catch(() => undefined);
            request.log.error(
              { domain: sftpDomain, file: remote.name, error },
              "cleaner sftp pull: file failed"
            );
            send({
              type: "progress",
              stage: "pull",
              current: index,
              total,
              message: `Failed ${remote.name} (${index} of ${total})`
            });
          }
        }

        if (inputFiles.length === 0) {
          send({
            type: "error",
            message: `Could not download any sitemap files for ${sftpDomain}.`
          });

          return;
        }

        handedOff = await cleanPackageAndFinish({
          inputFiles,
          domain: siteUrl,
          subfolder,
          runDir,
          inDir,
          outDir,
          send,
          log: request.log
        });
      } catch (error) {
        request.log.error({ error }, "cleaner sftp process failed");
        send({
          type: "error",
          message:
            error instanceof Error ? error.message : "SFTP clean failed"
        });
      } finally {
        stopKeepalive();

        if (!stream.writableEnded) {
          stream.end();
        }

        if (!handedOff) {
          void rm(runDir, { recursive: true, force: true });
        }
      }
    }
  );
}
