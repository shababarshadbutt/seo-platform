import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import AdmZip from "adm-zip";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest
} from "fastify";
import { ZipArchive } from "archiver";

import { config, sftpConfigError } from "../config.js";
import {
  assertSafeDomain,
  downloadSftpFiles,
  listSftpSitemapFiles
} from "../sftp/sftpClient.js";
import {
  cleanSitemaps,
  REPORT_FILENAME,
  type CleanerInputFile,
  type CleanerOutputFile
} from "../sitemaps/cleaner.js";
import { CleanerCapacityError } from "../sitemaps/dedupBudget.js";
import { StageTimer } from "../sitemaps/stageTimer.js";
import {
  createRun,
  finishRun,
  getRun,
  publishFrame,
  SERVER_EPOCH,
  subscribeRun,
  touchRun,
  type LiveRun,
  type RunFrame
} from "../sitemaps/cleanerRuns.js";

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

// Throw away a working directory without waiting for it, and WITHOUT betting the
// process on it succeeding.
//
// Every one of these sites used to be a bare `void rm(...)`. An unawaited
// rejection is an unhandledRejection, which Node 15+ escalates to an
// uncaughtException and — with no handler installed — EXITS THE PROCESS. That
// turns a failed temp-directory delete into an API restart, and because live
// Cleaner runs are held in a process-local Map (see sitemaps/cleanerRuns.ts) the
// restart wipes every one of them. The next reconnect then gets a 404 and the
// user is told their run "is no longer available … may have been stopped after
// being left unwatched, or already collected" about a run that was healthy a
// second earlier and had a viewer attached the whole time.
//
// `force: true` swallows ENOENT but NOT the EBUSY/EPERM/ENOTEMPTY that removing
// a tree still being written to can raise, which is why this is reachable at all
// — and most reachable on exactly the big, slow runs where losing progress hurts
// most. The pull loop's per-file `rm` already guarded itself this way; these did
// not.
function discardDir(dir: string, log?: FastifyBaseLogger) {
  void rm(dir, { recursive: true, force: true }).catch((error) => {
    log?.warn(
      { error, dir },
      "cleaner: could not remove working directory (ignored)"
    );
  });
}

function storeRun(token: string, run: CachedRun) {
  runCache.set(token, run);
  const timer = setTimeout(() => {
    runCache.delete(token);
    discardDir(run.dir);
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
  // RunFrame-shaped rather than `unknown`: both callers emit progress frames and
  // the detached path fans them out to run subscribers, which need the `type`.
  send: (frame: RunFrame) => void;
  log: FastifyInstance["log"];
  // Carried in from the caller so the pull/upload stage that ran BEFORE this
  // function is included in the breakdown. A run that spends 24 of 25 minutes
  // pulling would otherwise look instant here.
  timer?: StageTimer;
  // Present for a detached (SFTP) run. Its terminal frame must be RETAINED by the
  // run so a client reconnecting after completion still gets the download token,
  // which a plain send() to a possibly-dead socket would lose. Absent for the
  // upload route, which still owns its request for the whole clean.
  runId?: string;
}): Promise<boolean> {
  const { inputFiles, domain, subfolder, runDir, inDir, outDir, send, log } =
    options;
  const timer = options.timer ?? new StageTimer();

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { result, files } = await cleanSitemaps({
      files: inputFiles,
      domain,
      subfolder: subfolder || "sitemaps",
      today,
      outDir,
      onProgress: (event) => {
        timer.mark(event.stage);
        send({ type: "progress", ...event });
      }
    });

    // Inputs are no longer needed — free the disk they occupy.
    await rm(inDir, { recursive: true, force: true });

    timer.mark("zip");
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

    timer.mark("done");
    const timing = timer.finish();
    const dominant = StageTimer.dominant(timing.stage_ms);

    // The line that makes "which stage was slow?" readable instead of a
    // reproduction exercise. Leads with the dominant stage on purpose.
    log.info(
      {
        domain,
        files: inputFiles.length,
        total_urls_kept_files: result.total_urls_kept_files,
        clean_urls_remaining: result.clean_urls_remaining,
        total_ms: timing.total_ms,
        dominant_stage: dominant?.stage,
        dominant_stage_ms: dominant?.ms,
        stage_ms: timing.stage_ms,
        ms_per_file: Number((timing.total_ms / inputFiles.length).toFixed(1))
      },
      "cleaner run timing"
    );

    const doneFrame = {
      type: "done",
      summary: result,
      download_token: token,
      zip_filename: zipFilename
    };

    if (options.runId) {
      finishRun(options.runId, "done", doneFrame);
    } else {
      send(doneFrame);
    }

    return true;
  } catch (error) {
    // A capacity refusal is not a crash and must not read like one: it is the
    // guard doing its job, with actionable numbers in the message. Logged at
    // warn so it does not sit in the error budget alongside real failures, and
    // tagged with a `code` so the UI can present it as a limit rather than a
    // generic "Cleaning failed".
    if (error instanceof CleanerCapacityError) {
      log.warn(
        {
          domain,
          files: inputFiles.length,
          unique_urls: error.uniqueUrls,
          bytes: error.bytes,
          budget_bytes: error.budgetBytes,
          concurrent_runs: error.concurrentRuns
        },
        "cleaner run refused: dedup memory budget"
      );
    } else {
      log.error({ error }, "cleaner process failed");
    }

    const errorFrame = {
      type: "error",
      message: error instanceof Error ? error.message : "Cleaning failed",
      ...(error instanceof CleanerCapacityError
        ? { code: "dedup_budget_exceeded" }
        : {})
    };

    if (options.runId) {
      finishRun(options.runId, "error", errorFrame);
    } else {
      send(errorFrame);
    }

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

      const cleanupRunDir = () => discardDir(runDir, request.log);

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

  // Stream the duplicates report CSV that the clean already wrote to disk.
  //
  // This route exists so the summary no longer has to CARRY the report. The
  // rows used to be returned in the `done` frame as `duplicate_urls` purely so
  // the browser could rebuild a CSV byte-for-byte identical to the one sitting
  // in the run's working directory — a second complete copy of the same data,
  // held on the API heap and then serialized through JSON, for no gain. A run
  // with tens of millions of duplicates could exhaust the heap on that copy
  // alone, regardless of how the dedup index itself was bounded.
  app.get<{ Params: { token: string } }>(
    "/api/cleaner/report/:token",
    async (request, reply) => {
      const entry = runCache.get(request.params.token);
      const file = entry?.files.find(
        (candidate) => candidate.filename === REPORT_FILENAME
      );

      if (!entry || !file) {
        return reply.code(404).send({
          error: "Not Found",
          message: "duplicates report expired or not found — run the cleaner again"
        });
      }

      let size: number;

      try {
        size = (await stat(file.path)).size;
      } catch {
        return reply.code(404).send({
          error: "Not Found",
          message: "duplicates report expired or not found — run the cleaner again"
        });
      }

      // Named after this run rather than the bare REPORT_FILENAME, so downloading
      // reports for several domains doesn't produce duplicates-report(1).csv etc.
      const downloadName = entry.filename
        .replace(/\.zip$/i, "")
        .replace(/^cleaned-sitemaps/, "duplicates-report");

      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-length", size);
      reply.header(
        "content-disposition",
        `attachment; filename="${downloadName}.csv"`
      );

      return reply.send(createReadStream(file.path));
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

      // The run is created FIRST and the work below is detached from this
      // request, which merely subscribes to it. That inversion is the fix: the
      // clean used to run inside the hijacked request, so a client going away
      // left the download loop running with nobody able to reach it — holding an
      // SFTP connection slot for the rest of the run, and reading to the user as
      // the misleading "Processing stream closed before finishing".
      const run = createRun(runId, sftpDomain);

      attachRunStream({ request, reply, run });

      // Frames go to the RUN, not to a socket. Every subscriber gets them, and
      // the last one is retained so a reconnect sees current state immediately.
      const send = (frame: RunFrame) => publishFrame(run.runId, frame);

      let handedOff = false;

      // Deliberately NOT awaited: the request has already been answered with a
      // stream. Errors become terminal frames below, so there is nothing for an
      // unhandled rejection to carry.
      void (async () => {
        try {
          // Total is known before the download loop, so every frame carries
          // current/total — same contract as the Migration pull progress.
          // Started BEFORE the listing so the pull stage covers the SSH round
          // trips too, not just the transfers.
          const timer = new StageTimer();

          timer.mark("pull");
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

          // Downloaded with bounded parallelism (SFTP_MAX_CONCURRENT_CONNECTIONS)
          // rather than one at a time. Each download is its own SSH connect +
          // fastGet + end, so a sequential loop paid a full round trip per file and
          // left most of the connection pool idle — measured as the overwhelming
          // majority of a 2,264-file run.
          const inputFiles: CleanerInputFile[] = [];
          const outcomes = await downloadSftpFiles(
            sftpDomain,
            remoteFiles.map((remote) => ({
              name: remote.name,
              localPath: path.join(inDir, path.basename(remote.name))
            })),
            {
              // Abandonment stops the batch between files, so the connection
              // slot is released instead of being held for the rest of a run
              // nobody is waiting for. Without this the watchdog marks the run
              // abandoned while the downloads carry on regardless — which is
              // exactly what a live test caught.
              signal: run.controller.signal,
              onSettled: (outcome, completed) => {
                timer.mark("pull");
                send({
                  type: "progress",
                  stage: "pull",
                  current: completed,
                  total,
                  message: outcome.ok
                    ? `Pulled ${outcome.name} (${completed} of ${total})`
                    : `Failed ${outcome.name} (${completed} of ${total})`
                });
              }
            }
          );

          for (const outcome of outcomes) {
            if (outcome.ok) {
              // Order follows the remote listing, not completion order: the
              // outcomes array is index-aligned with the input, so the cleaner
              // still sees files in a stable order regardless of which download
              // finished first.
              inputFiles.push({ filename: outcome.name, path: outcome.localPath });
              continue;
            }

            // Don't leave a truncated download to be parsed as a real sitemap.
            await rm(outcome.localPath, { force: true }).catch(() => undefined);
            request.log.error(
              { domain: sftpDomain, file: outcome.name, error: outcome.error },
              "cleaner sftp pull: file failed"
            );
          }

          if (run.controller.signal.aborted) {
            // Reaped mid-pull. Don't spend CPU cleaning a partial set nobody is
            // waiting for; the working directory is removed in the finally.
            request.log.warn(
              { run_id: run.runId, domain: sftpDomain, pulled: inputFiles.length },
              "cleaner sftp run abandoned: aborted mid-pull, connection slots released"
            );
            finishRun(run.runId, "abandoned", {
              type: "error",
              message:
                "This cleaning run was stopped because nothing was watching it. Start it again when you are ready."
            });

            return;
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
            log: request.log,
            timer,
            runId: run.runId
          });
        } catch (error) {
          request.log.error(
            { error, run_id: run.runId },
            "cleaner sftp process failed"
          );
          send({
            type: "error",
            message: error instanceof Error ? error.message : "SFTP clean failed"
          });
          finishRun(run.runId, "error", {
            type: "error",
            message: error instanceof Error ? error.message : "SFTP clean failed"
          });
        } finally {
          // The working directory goes only when the run did NOT hand its files
          // off to the download cache. Note what is absent: nothing here touches
          // the client's socket, because the run does not own one.
          if (!handedOff) {
            discardDir(runDir, request.log);
          }
        }
      })();
    }
  );

  // Reconnect to an in-progress (or just-finished) run.
  //
  // This is what makes a dropped connection a blip rather than a failure. The
  // client keeps the run_id from the `started` frame and comes back here; the
  // stream replays the last known progress immediately (a reconnect during a slow
  // stage would otherwise sit blank for minutes), then streams live. A run that
  // finished while the client was away still gets its terminal frame.
  app.get<{ Params: { runId: string } }>(
    "/api/cleaner/runs/:runId/progress",
    {
      onRequest: (request, reply, done) => {
        request.raw.setTimeout(CLEANER_TIMEOUT_MS);
        reply.raw.setTimeout(CLEANER_TIMEOUT_MS);
        done();
      }
    },
    async (request, reply) => {
      const run = getRun(request.params.runId);

      // Gate BEFORE hijacking — once hijacked a JSON reply is impossible. A 404
      // is the honest answer and the client's signal to stop retrying: the run is
      // genuinely gone.
      //
      // WHICH KIND of gone is the part worth getting right. An epoch that does
      // not match ours means this process is not the one that started the run, so
      // the run did not go anywhere — the API did, taking its whole in-memory
      // registry with it. Saying "left unwatched or already collected" there
      // blames the user's browser for a server restart and sends them hunting the
      // wrong thing; it is also the message a real report came in about.
      if (!run) {
        const clientEpoch =
          typeof (request.query as { epoch?: unknown })?.epoch === "string"
            ? ((request.query as { epoch?: string }).epoch as string)
            : null;
        const restarted = clientEpoch !== null && clientEpoch !== SERVER_EPOCH;

        if (restarted) {
          request.log.warn(
            {
              run_id: request.params.runId,
              client_epoch: clientEpoch,
              server_epoch: SERVER_EPOCH
            },
            "cleaner reconnect after an API restart: the run's process is gone"
          );
        }

        return reply.code(404).send({
          error: "Not Found",
          code: restarted ? "server_restarted" : "run_gone",
          message: restarted
            ? "The server restarted while this run was in progress, so the run could not be resumed. Nothing was wrong with your connection. Start the clean again — and if this keeps happening, the API is being restarted mid-run (check its logs for a crash or an out-of-memory kill)."
            : "That cleaning run is no longer available. It may have been stopped after being left unwatched, or already collected."
        });
      }

      attachRunStream({ request, reply, run });
    }
  );

  // Cheap non-streaming status, so a client can ask whether a run is still alive
  // without opening a stream.
  app.get<{ Params: { runId: string } }>(
    "/api/cleaner/runs/:runId",
    async (request, reply) => {
      const run = getRun(request.params.runId);

      if (!run) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "no such cleaning run" });
      }

      // Enough to watch the abandon timer rather than infer it. Diagnosing the
      // reap required knowing how stale the heartbeat was and how much of the
      // grace period was left, and both had to be reconstructed from log
      // timestamps; `watchers` alone cannot show it, because abandonment is
      // decided by the heartbeat and NOT by the subscriber count.
      const now = Date.now();
      const staleMs = now - run.lastWatchedAt;

      return {
        run_id: run.runId,
        domain: run.domain,
        status: run.status,
        started_at: new Date(run.startedAt).toISOString(),
        elapsed_seconds: Math.round((now - run.startedAt) / 1000),
        watchers: run.subscribers.size,
        last: run.lastFrame,
        server_epoch: SERVER_EPOCH,
        abandon_grace_seconds: Math.round(config.cleanerAbandonGraceMs / 1000),
        heartbeat_stale_seconds: Math.round(staleMs / 1000),
        // Negative means the next watchdog sweep will reap it.
        abandon_in_seconds:
          run.status === "running"
            ? Math.round((config.cleanerAbandonGraceMs - staleMs) / 1000)
            : null
      };
    }
  );
}

// Stream one run to one client. Shared by the start endpoint and the reconnect
// endpoint so the two cannot drift in what they emit.
function attachRunStream(options: {
  request: FastifyRequest;
  reply: FastifyReply;
  run: LiveRun;
}) {
  const { request, reply, run } = options;

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

  let cleanedUp = false;
  let keepalive: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }

    subscription?.unsubscribe();
  };

  // The run id goes out FIRST, before any work frame, so a client that loses the
  // connection a second later already knows what to reconnect to.
  // The epoch rides along with the run id so a reconnect can be told whether the
  // process it is coming back to is the one that started its run.
  send({
    type: "started",
    run_id: run.runId,
    domain: run.domain,
    server_epoch: SERVER_EPOCH
  });

  const subscription = subscribeRun(run.runId, (frame) => {
    send(frame);

    if (frame.type === "done" || frame.type === "error") {
      cleanup();

      if (!stream.writableEnded) {
        stream.end();
      }
    }
  });

  if (!subscription) {
    send({ type: "error", message: "no such cleaning run" });
    stream.end();

    return;
  }

  keepalive = setInterval(() => {
    // `destroyed` as well as `writableEnded`: an aborted client leaves a socket
    // that is destroyed but NOT ended, and writing to it fails asynchronously —
    // so checking writableEnded alone would go on heartbeating a dead connection
    // forever and the run would never look abandoned.
    if (stream.destroyed || stream.writableEnded) {
      cleanup();

      return;
    }

    stream.write(": keepalive\n\n");
    // Doubles as the heartbeat: a still-writable stream means somebody is still
    // watching, which is exactly what the abandonment check asks.
    touchRun(run.runId);
  }, SSE_KEEPALIVE_MS);
  keepalive.unref?.();

  // A client going away unsubscribes and does NOTHING ELSE. The run continues;
  // the watchdog decides later whether it has been unwatched long enough to stop.
  //
  // Bound on BOTH objects and on error: with a hijacked reply an aborted fetch was
  // observed to fire `close` on neither reliably — verified, the subscriber
  // lingered and the run reported watchers=1 after the client had gone. The
  // keepalive check above is the backstop that stops correctness depending on any
  // one of these firing.
  request.raw.on("close", cleanup);
  request.raw.on("aborted", cleanup);
  request.raw.on("error", cleanup);
  stream.on("close", cleanup);
  stream.on("error", cleanup);

  for (const frame of subscription.replay) {
    send(frame);
  }

  // Already finished before this client arrived: the replay covered it, so close.
  if (run.terminalFrame) {
    cleanup();
    stream.end();
  }
}
