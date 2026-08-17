import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ServerResponse } from "node:http";

import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { ZipArchive } from "archiver";

import type { FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config.js";
import {
  CLEANER_MAX_WORKERS,
  CLEANER_PARALLEL_THRESHOLD,
  cleanerPoolConfig,
  cleanerPoolStats,
  runCleanerClassify
} from "../jobs/cleanerPool.js";
import {
  classifyCleanerFile,
  cleanSitemaps,
  type CleanerClassification,
  type CleanerInputFile,
  type CleanerOutputFile,
  type CleanerResult,
  REPORT_FILENAME
} from "../sitemaps/cleaner.js";
import { createCleanerMetrics, type CleanerMetrics } from "../sitemaps/cleanerMetrics.js";
import {
  createRun,
  finishRun,
  getRun,
  publishFrame,
  SERVER_EPOCH,
  subscribeRun,
  touchRun,
  touchRunUpload,
  type LiveRun
} from "../sitemaps/cleanerRuns.js";
import {
  createRunFilesState,
  expectedCountForBatch,
  missingBatches,
  orderedFiles,
  receivedFileCount,
  registerBatch,
  renamedFiles,
  type RunFilesState
} from "../sitemaps/cleanerRunFiles.js";
import { StageTimer } from "../sitemaps/stageTimer.js";

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

// Pack the cleaned outputs into a ZIP written straight to disk (never buffered
// in memory). archiver streams each entry from its source file, so only small
// per-file chunks are ever resident. Level 0 = STORE (no compression) — speed
// over size, matching the session download ZIPs (v1.34).
function archiveToFile(
  files: CleanerOutputFile[],
  zipPath: string,
  onEntry?: (done: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = new ZipArchive({ zlib: { level: 0 } });
    const output = createWriteStream(zipPath);
    let done = 0;

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    // Packaging used to be a single "Packaging ZIP…" message followed by
    // silence for the rest of the run. archiver emits `entry` per file, so the
    // denominator is just files.length — deliberately NOT the `progress`
    // event's entries.total, which counts entries APPENDED so far and therefore
    // grows as the archive is built.
    if (onEntry) {
      archive.on("entry", () => {
        done += 1;
        onEntry(done, files.length);
      });
    }

    archive.pipe(output);

    for (const file of files) {
      archive.file(file.path, { name: file.filename });
    }

    void archive.finalize();
  });
}


// ===========================================================================
// Batched upload (v1.51)
// ===========================================================================
//
// Why this exists: a browser cannot assemble a 1,681-part multipart body in
// reasonable time. A real run sat at 0% for over ten minutes without sending a
// single byte — `xhr.upload.onprogress` never fired, because there was nothing
// to report yet. v1.50's XHR switch made upload progress reportable; it could
// not make the browser faster at building the body.
//
// So the upload becomes N small requests against one server-side run. That in
// turn requires a run to outlive a single request, which is what LiveRun is for.
//
// The hazard this design is shaped around: cleaner output is ORDER-DEFINED
// (first-occurrence-across-files wins), and batches upload CONCURRENTLY, so
// arrival order is not selection order. Files are therefore identified by the
// (batchIndex, position) tuple and sorted into canonical order exactly once, at
// completion — see cleanerRunFiles.ts.

type BatchedRun = {
  run: LiveRun;
  files: RunFilesState;
  metrics: CleanerMetrics;
  stageTimer: StageTimer;
  // Classification results by "batchIndex:position". Kept beside the slot list
  // rather than inside it so a retry replacing a batch cannot orphan them.
  classifications: Map<string, CleanerClassification>;
  classifyErrors: Map<string, Error>;
  classifyQueue: { batchIndex: number; position: number; attempt: number; path: string; filename: string }[];
  classifyActive: number;
  classified: number;
  drained: (() => void)[];
  domainHost: string;
  createdAt: number;
  // Accumulated wall clock across every batch request. The upload was never
  // separable from the clean before, so no run has ever recorded this.
  uploadWallMs: number;
};

// Set when the routes register, so the DETACHED terminal phase still has a
// logger long after its originating request is gone.
let routeLogger: FastifyInstance["log"] | null = null;

const batched = new Map<string, BatchedRun>();

const slotKey = (batchIndex: number, position: number) => `${batchIndex}:${position}`;

function publishProgress(
  entry: BatchedRun,
  frame: { stage: string; message: string; current?: number; total?: number }
) {
  entry.stageTimer.mark(frame.stage);
  publishFrame(entry.run.runId, { type: "progress", ...frame });
}

// Bounded, run-scoped Pass-1 drainer.
//
// The batch handler returns 202 WITHOUT awaiting this: awaiting would serialise
// the three concurrent uploads behind a 4-thread pool and reinvent the very
// stall this feature removes. Bounding it at CLEANER_MAX_WORKERS means overlap
// adds no thread pressure beyond what a single-request run already applies — it
// just applies it earlier.
function pumpClassify(entry: BatchedRun) {
  while (
    entry.classifyActive < CLEANER_MAX_WORKERS &&
    entry.classifyQueue.length > 0
  ) {
    entry.classifyActive += 1;
    void drainClassify(entry);
  }
}

async function drainClassify(entry: BatchedRun) {
  for (;;) {
    const task = entry.classifyQueue.shift();

    if (!task || entry.run.controller.signal.aborted) {
      entry.classifyActive -= 1;

      if (entry.classifyActive === 0 && entry.classifyQueue.length === 0) {
        for (const resolve of entry.drained.splice(0)) {
          resolve();
        }
      }

      return;
    }

    const key = slotKey(task.batchIndex, task.position);

    try {
      const result = entry.run.parallel
        ? await runCleanerClassify({
            filename: task.filename,
            path: task.path,
            domainHost: entry.domainHost
          })
        : await classifyCleanerFile(
            { filename: task.filename, path: task.path },
            entry.domainHost
          );

      // The attempt guard. A batch that was retried has a NEW attempt number,
      // and a result issued for the superseded attempt must not land — it was
      // computed from a file that has since been replaced on disk.
      if (entry.files.batches.get(task.batchIndex)?.attempt !== task.attempt) {
        continue;
      }

      entry.classifications.set(key, result as CleanerClassification);
      entry.classified += 1;
      publishProgress(entry, {
        stage: "parse",
        current: entry.classified,
        total: entry.run.expectedTotal,
        message: `Read ${entry.classified} of ${entry.run.expectedTotal} files`
      });
    } catch (error) {
      // A malformed sitemap resolves {isValid:false} rather than rejecting, so a
      // rejection here is a real I/O fault. Record it and let the terminal phase
      // fail loudly — silently demoting it to "unparsable" would turn a disk
      // error into a quietly smaller ZIP.
      entry.classifyErrors.set(
        key,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

function awaitClassifyDrain(entry: BatchedRun): Promise<void> {
  if (entry.classifyActive === 0 && entry.classifyQueue.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => entry.drained.push(resolve));
}

function discardBatchedRun(entry: BatchedRun) {
  batched.delete(entry.run.runId);
  void rm(entry.run.runDir, { recursive: true, force: true }).catch(() => undefined);
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

      // ---- Run instrumentation (v1.50) --------------------------------------
      // Before this, the ONLY log statement anywhere in the cleaner was the
      // error handler below. A real 1,681-file run could take 25 minutes and
      // leave nothing behind saying where the time went: the stage names existed
      // but were written only to the browser, so closing the tab destroyed the
      // evidence and answering "which stage was slow?" meant reproducing the run.
      const metrics = createCleanerMetrics();
      const stageTimer = new StageTimer();
      const runStartedAt = Date.now();

      // StageTimer attributes elapsed time to the last-marked stage, so marking
      // EVERY frame would be wrong here: Pass 2 interleaves throttled `dedup`
      // frames with per-file `output` frames, and marking both would split one
      // contiguous phase across two buckets by interleave order — a number that
      // means nothing. Pass 2 is therefore marked wholly as `output`, and the
      // authoritative split comes from the explicit spans instead.
      const TIMED_STAGES = new Set([
        "upload",
        "unzip",
        "start",
        "parse",
        "select",
        "output",
        "index",
        "report",
        "cleanup",
        "zip"
      ]);
      const markStage = (stage: string) => {
        if (TIMED_STAGES.has(stage)) {
          stageTimer.mark(stage);
        }
      };

      stageTimer.mark("upload");
      let lastFrame: { stage: string; current?: number; total?: number } = {
        stage: "upload"
      };
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const stopHeartbeat = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      };

      // Makes a hung run visible in `docker logs` WHILE it is hung, rather than
      // only in the post-mortem. Bounded (one line per interval regardless of
      // file count) and disable-able with CLEANER_HEARTBEAT_SECONDS=0.
      if (config.cleanerHeartbeatMs > 0) {
        heartbeat = setInterval(() => {
          request.log.info(
            {
              run_id: runId,
              stage: lastFrame.stage,
              current: lastFrame.current,
              total: lastFrame.total,
              elapsed_ms: Date.now() - runStartedAt
            },
            "cleaner run progress"
          );
        }, config.cleanerHeartbeatMs);
        heartbeat.unref?.();
      }

      const send = (payload: unknown) => {
        const frame = payload as {
          type?: string;
          stage?: string;
          current?: number;
          total?: number;
        };

        if (frame.type === "progress" && frame.stage) {
          lastFrame = {
            stage: frame.stage,
            current: frame.current,
            total: frame.total
          };
        }

        if (res && !res.writableEnded) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      // One line, at the end, leading with the answer. Explicit spans are
      // authoritative; StageTimer's stage_ms is the coarse cross-check, and a
      // material disagreement between them is itself a finding (it means work
      // is happening under a stage that never announced itself).
      const logRunTiming = (
        req: typeof request,
        outcome: "ok" | "error",
        result: CleanerResult | null
      ) => {
        const snapshot = metrics.snapshot();
        const { total_ms, stage_ms } = stageTimer.finish();
        const dominant = StageTimer.dominant(stage_ms);
        const files = snapshot.counters.files ?? 0;

        req.log.info(
          {
            run_id: runId,
            outcome,
            domain,
            source: "upload",
            files,
            candidates: snapshot.counters.candidates ?? 0,
            files_kept: result?.output_files.length ?? 0,
            files_dropped: result?.dropped_files.length ?? 0,
            duplicates_removed: snapshot.counters.duplicates_removed ?? 0,
            urls_kept: snapshot.counters.urls_kept ?? 0,

            total_ms,
            ms_per_file: files > 0 ? Math.round(total_ms / files) : null,
            dominant_stage: dominant?.stage ?? null,
            dominant_stage_ms: dominant?.ms ?? null,
            stage_ms,

            // Authoritative spans + counters.
            spans: snapshot.totals,
            counts: snapshot.counters,
            per_file: snapshot.observations,

            pools: cleanerPoolStats(),
            pool_config: cleanerPoolConfig(),
            // Makes a starved container visible in the data: 4 worker threads
            // on a 2-vCPU WSL2 VM is a different run from 4 on a 16-core host,
            // and nothing previously recorded which one produced a timing.
            host: {
              cpus: availableParallelism(),
              mem_mb: Math.round(totalmem() / 1024 / 1024),
              platform: process.platform,
              node: process.version
            },
            mem: {
              rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
              heap_used_mb: Math.round(
                process.memoryUsage().heapUsed / 1024 / 1024
              )
            }
          },
          "cleaner run timing"
        );
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
            await metrics.timeAsync("upload.pipeline_ms", () =>
              pipeline(part.file, createWriteStream(zipPath))
            );

            const zip = new AdmZip(zipPath);
            const entries = zip
              .getEntries()
              .filter(
                (entry) =>
                  !entry.isDirectory &&
                  isXmlName(baseName(entry.entryName)) &&
                  !baseName(entry.entryName).startsWith(".")
              );

            markStage("unzip");
            metrics.inc("unzip.archives");

            // The whole extraction used to be silent: a 2,000-file ZIP counted
            // as exactly ONE upload tick, so the UI sat frozen for its entire
            // duration. Now every entry reports.
            let extracted = 0;

            for (const entry of entries) {
              const entryName = baseName(entry.entryName);
              const dest = path.join(inDir, `${fileIndex}__${entryName}`);
              fileIndex += 1;

              // NOTE: extractEntryTo is SYNCHRONOUS — it blocks the event loop
              // for the duration of each entry's inflate. The yield below lets
              // the queued SSE frame actually flush; it does NOT make the
              // extraction non-blocking. Whether that is worth replacing AdmZip
              // is a question for the next pass, and unzip.extract_ms is the
              // number that answers it.
              metrics.timeSync("unzip.extract_ms", () => {
                zip.extractEntryTo(entry, inDir, false, true, false, baseName(dest));
              });
              inputFiles.push({ filename: entryName, path: dest });
              extracted += 1;

              send({
                type: "progress",
                stage: "unzip",
                current: extracted,
                total: entries.length,
                message: `Extracting ${extracted} of ${entries.length} files from ZIP`
              });
              await yieldToEventLoop();
            }

            metrics.inc("unzip.entries", extracted);
            await rm(zipPath, { force: true });
            markStage("upload");
          } else {
            // Stream the uploaded file straight to disk — never buffered.
            // 1,681 files means 1,681 sequential create+write+close cycles, and
            // the open is timed separately because on some filesystems the
            // metadata op, not the bytes, is what costs.
            const dest = path.join(inDir, `${fileIndex}__${name}`);
            fileIndex += 1;

            const endOpen = metrics.start("upload.open_ms");
            const stream = createWriteStream(dest);
            endOpen();

            await metrics.timeAsync("upload.pipeline_ms", () =>
              pipeline(part.file, stream)
            );
            metrics.inc("upload.files");
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
        const today = new Date().toISOString().slice(0, 10);
        const { result, files } = await cleanSitemaps({
          files: inputFiles,
          domain,
          subfolder: subfolder || "sitemaps",
          today,
          outDir,
          metrics,
          onProgress: (event) => {
            markStage(event.stage);
            send({ type: "progress", ...event });
          }
        });

        // Inputs are no longer needed — free the disk they occupy. On a
        // 1,681-file run this is 1,681 unlinks and was previously both silent
        // in the UI and invisible in any log — it could be minutes and nobody
        // would know.
        markStage("cleanup");
        send({
          type: "progress",
          stage: "cleanup",
          message: "Removing uploaded inputs…"
        });
        await metrics.timeAsync("stage.cleanup_ms", () =>
          rm(inDir, { recursive: true, force: true })
        );

        markStage("zip");
        send({
          type: "progress",
          stage: "zip",
          current: 0,
          total: files.length,
          message: `Packaging ${files.length} files into a ZIP…`
        });

        const zipFilename = `cleaned-sitemaps-${today}.zip`;
        const zipPath = path.join(runDir, zipFilename);
        await metrics.timeAsync("stage.zip_ms", () =>
          archiveToFile(files, zipPath, (zipped, total) => {
            send({
              type: "progress",
              stage: "zip",
              current: zipped,
              total,
              message: `Packaging ZIP — ${zipped} of ${total}`
            });
          })
        );
        metrics.inc("zip.entries", files.length);

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
        handedOff = true;

        send({
          type: "done",
          summary: result,
          download_token: token,
          zip_filename: zipFilename
        });

        logRunTiming(request, "ok", result);
      } catch (error) {
        request.log.error({ error }, "cleaner process failed");
        logRunTiming(request, "error", null);
        send({
          type: "error",
          message: error instanceof Error ? error.message : "Cleaning failed"
        });
      } finally {
        stopHeartbeat();
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

  // Stream the duplicates report CSV that the clean already wrote to disk.
  //
  // This route exists so the summary no longer has to CARRY the report. The rows
  // used to ride along in the `done` frame as `duplicate_urls`, purely so the
  // browser could rebuild a CSV already sitting in the run's working directory —
  // a second complete copy of the same data, held on the API heap and then
  // serialized through JSON. On a large corpus that copy was the single biggest
  // consumer of the heap, and JSON.stringify of it hit V8's ~512 MB string cap
  // and threw a RangeError that was silently swallowed, hanging the stream.
  app.get<{ Params: { token: string } }>(
    "/api/cleaner/report/:token",
    async (request, reply) => {
      const entry = runCache.get(request.params.token);
      const file = entry?.files.find(
        (candidate) => candidate.filename === REPORT_FILENAME
      );
      const missing = () =>
        reply.code(404).send({
          error: "Not Found",
          message:
            "duplicates report expired or not found — run the cleaner again"
        });

      if (!entry || !file) {
        return missing();
      }

      let size: number;

      try {
        size = (await stat(file.path)).size;
      } catch {
        return missing();
      }

      // Named after this run rather than the bare REPORT_FILENAME, so reports
      // for several domains don't pile up as duplicates-report(1).csv.
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
}

// SSE for a batched run. Ported from feature/aws-s3-sftp-deploy.
//
// This is a GET with NO request body, which is the whole point: the upload is
// now N separate POSTs, so progress cannot ride on any one of them. It also
// means the browser's inability to read a response while a request body is
// still uploading — the v1.50 diagnosis — stops being relevant at all.
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
  // connection a second later already knows what to reconnect to. The epoch
  // rides along so a reconnect can be told whether the process it is coming back
  // to is the one that started its run.
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
    touchRun(run.runId);
  }, SSE_KEEPALIVE_MS);
  keepalive.unref?.();

  // Bound on BOTH objects and on error: with a hijacked reply an aborted fetch
  // was observed to fire `close` on neither reliably. The keepalive check above
  // is the backstop that stops correctness depending on any one of these firing.
  request.raw.on("close", cleanup);
  request.raw.on("aborted", cleanup);
  request.raw.on("error", cleanup);
  stream.on("close", cleanup);
  stream.on("error", cleanup);

  for (const frame of subscription.replay) {
    send(frame);
  }
}

// Everything after the last batch: sort into canonical order, clean, zip, store.
// Runs DETACHED — the complete request has already returned 202 — so its only
// output channel is the run stream.
async function runTerminalPhase(entry: BatchedRun) {
  const { run, metrics } = entry;
  const startedAt = Date.now();
  let handedOff = false;

  try {
    await awaitClassifyDrain(entry);

    if (entry.classifyErrors.size > 0) {
      const [key, error] = [...entry.classifyErrors.entries()][0];

      throw new Error(`could not read uploaded file ${key}: ${error.message}`);
    }

    // THE point at which arrival order stops mattering.
    const ordered = orderedFiles(entry.files);
    const files: CleanerInputFile[] = ordered.map((file) => ({
      filename: file.filename,
      path: file.path,
      outputName: file.outputName
    }));
    const classifications = ordered.map((file) => {
      const found = entry.classifications.get(slotKey(file.batchIndex, file.position));

      if (!found) {
        throw new Error(`missing classification for ${file.filename}`);
      }

      return found;
    });

    // `total` narrows exactly once here, at the phase boundary, if the server
    // rejected any non-XML parts. It must never GROW — that is what would break
    // the progress contract.
    publishProgress(entry, {
      stage: "start",
      current: 0,
      total: files.length,
      message: `Received ${files.length} file(s)`
    });

    const today = new Date().toISOString().slice(0, 10);
    const { result, files: outputs } = await cleanSitemaps({
      files,
      classifications,
      // Decided from the run's DECLARED total, not from whatever subset reached
      // this call — see the note on the option itself.
      parallel: run.parallel,
      domain: run.domain,
      subfolder: run.subfolder || "sitemaps",
      today,
      outDir: run.outDir,
      metrics,
      signal: run.controller.signal,
      onProgress: (event) => publishProgress(entry, event)
    });

    publishProgress(entry, {
      stage: "cleanup",
      message: "Removing uploaded inputs…"
    });
    await metrics.timeAsync("stage.cleanup_ms", () =>
      rm(run.inDir, { recursive: true, force: true })
    );

    publishProgress(entry, {
      stage: "zip",
      current: 0,
      total: outputs.length,
      message: `Packaging ${outputs.length} files into a ZIP…`
    });

    const zipFilename = `cleaned-sitemaps-${today}.zip`;
    const zipPath = path.join(run.runDir, zipFilename);

    await metrics.timeAsync("stage.zip_ms", () =>
      archiveToFile(outputs, zipPath, (zipped, total) =>
        publishProgress(entry, {
          stage: "zip",
          current: zipped,
          total,
          message: `Packaging ZIP — ${zipped} of ${total}`
        })
      )
    );

    const token = randomUUID();

    storeRun(token, {
      dir: run.runDir,
      zipPath,
      filename: zipFilename,
      domain: run.domain,
      files: outputs
    });
    handedOff = true;

    const renamed = renamedFiles(ordered);

    finishRun(run.runId, "done", {
      type: "done",
      summary: { ...result, renamed_files: renamed },
      download_token: token,
      zip_filename: zipFilename
    });
    logBatchedRunTiming(entry, "ok", result, startedAt, renamed.length);
  } catch (error) {
    logBatchedRunTiming(entry, "error", null, startedAt, 0);
    finishRun(run.runId, "error", {
      type: "error",
      message: error instanceof Error ? error.message : "Cleaning failed"
    });
  } finally {
    batched.delete(run.runId);

    if (!handedOff) {
      void rm(run.runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function logBatchedRunTiming(
  entry: BatchedRun,
  outcome: "ok" | "error",
  result: CleanerResult | null,
  startedAt: number,
  renamedCount: number
) {
  const snapshot = entry.metrics.snapshot();
  const { total_ms, stage_ms } = entry.stageTimer.finish();
  const dominant = StageTimer.dominant(stage_ms);

  routeLogger?.info(
    {
      run_id: entry.run.runId,
      outcome,
      domain: entry.run.domain,
      source: "upload-batched",
      files: snapshot.counters.files ?? 0,
      declared_total: entry.run.expectedTotal,
      batches: entry.files.batches.size,
      batch_size: entry.run.batchSize,
      parallel: entry.run.parallel,
      renamed_files: renamedCount,
      files_kept: result?.output_files.length ?? 0,
      files_dropped: result?.dropped_files.length ?? 0,
      duplicates_removed: snapshot.counters.duplicates_removed ?? 0,
      // Upload wall clock — the number v1.50's next-steps asked for and which no
      // run has ever recorded, because the upload was never separable before.
      upload_wall_ms: entry.uploadWallMs,
      clean_wall_ms: Date.now() - startedAt,
      total_ms,
      dominant_stage: dominant?.stage ?? null,
      dominant_stage_ms: dominant?.ms ?? null,
      stage_ms,
      spans: snapshot.totals,
      counts: snapshot.counters,
      per_file: snapshot.observations,
      pools: cleanerPoolStats(),
      pool_config: cleanerPoolConfig(),
      host: {
        cpus: availableParallelism(),
        mem_mb: Math.round(totalmem() / 1024 / 1024),
        platform: process.platform,
        node: process.version
      }
    },
    "cleaner run timing"
  );
}

export async function cleanerBatchRoutes(app: FastifyInstance) {
  routeLogger = app.log;

  // ---- 1. Reserve a run -----------------------------------------------------
  // Domain validation moves HERE, out of the streaming path. Previously an
  // invalid domain discovered after the socket was hijacked could only be an SSE
  // error frame; now every validation failure is an ordinary JSON 400, before a
  // single file byte moves.
  app.post<{ Body: { domain?: string; subfolder?: string; total_files?: number } }>(
    "/api/cleaner/runs",
    async (request, reply) => {
      const domain = String(request.body?.domain ?? "").trim();
      const subfolder = String(request.body?.subfolder ?? "sitemaps").trim();
      const totalFiles = Number(request.body?.total_files ?? 0);

      if (!domain) {
        return reply.code(400).send({ error: "Bad Request", message: "domain is required" });
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

      if (!Number.isFinite(totalFiles) || totalFiles < 1) {
        return reply
          .code(400)
          .send({ error: "Bad Request", message: "total_files must be at least 1" });
      }

      if (totalFiles > config.cleanerMaxFilesPerRun) {
        return reply.code(400).send({
          error: "Bad Request",
          message: `total_files exceeds the ${config.cleanerMaxFilesPerRun} limit for one run`
        });
      }

      const runId = randomUUID();
      const runDir = path.join(CLEANER_WORK_ROOT, runId);
      const inDir = path.join(runDir, "in");
      const outDir = path.join(runDir, "out");

      await mkdir(inDir, { recursive: true });
      await mkdir(outDir, { recursive: true });

      const batchSize = config.cleanerUploadBatchSize;
      const files = createRunFilesState({ batchSize, expectedTotal: totalFiles });
      const run = createRun(runId, domain, {
        subfolder,
        runDir,
        inDir,
        outDir,
        expectedTotal: totalFiles,
        batchSize,
        batchCount: files.batchCount,
        // Decided ONCE from the declared total. Per-batch it would be 50 >= 200
        // for every batch — false — silently forcing a large run sequential.
        parallel: totalFiles >= CLEANER_PARALLEL_THRESHOLD,
        phase: "uploading"
      });

      const stageTimer = new StageTimer();
      stageTimer.mark("upload");

      batched.set(runId, {
        run,
        files,
        metrics: createCleanerMetrics(),
        stageTimer,
        classifications: new Map(),
        classifyErrors: new Map(),
        classifyQueue: [],
        classifyActive: 0,
        classified: 0,
        drained: [],
        domainHost: new URL(domain).host,
        createdAt: Date.now(),
        uploadWallMs: 0
      });

      return reply.code(201).send({
        run_id: runId,
        server_epoch: SERVER_EPOCH,
        batch_size: batchSize,
        batch_count: files.batchCount
      });
    }
  );

  // ---- 2. Progress stream ---------------------------------------------------
  app.get<{ Params: { runId: string }; Querystring: { epoch?: string } }>(
    "/api/cleaner/runs/:runId/progress",
    {
      onRequest: (request, reply, done) => {
        // A batched run can outlive any single request by a long way, and the
        // stream must not be the thing that kills it.
        request.raw.setTimeout(0);
        reply.raw.setTimeout(0);
        done();
      }
    },
    async (request, reply) => {
      const run = getRun(request.params.runId);

      if (!run) {
        const restarted =
          typeof request.query.epoch === "string" &&
          request.query.epoch !== SERVER_EPOCH;

        return reply.code(404).send({
          error: "Not Found",
          code: restarted ? "server_restarted" : "run_gone",
          message: restarted
            ? "The server restarted, so this run no longer exists. Please upload again."
            : "This cleaning run is no longer available."
        });
      }

      attachRunStream({ request, reply, run });

      return reply;
    }
  );

  // ---- 3. Upload one batch --------------------------------------------------
  app.post<{ Params: { runId: string; batchIndex: string } }>(
    "/api/cleaner/runs/:runId/batches/:batchIndex",
    {
      onRequest: (request, reply, done) => {
        request.raw.setTimeout(config.cleanerRequestTimeoutMs);
        reply.raw.setTimeout(config.cleanerRequestTimeoutMs);
        done();
      }
    },
    async (request, reply) => {
      const entry = batched.get(request.params.runId);

      if (!entry) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "no such cleaning run" });
      }

      if (entry.run.phase !== "uploading") {
        return reply.code(409).send({
          error: "Conflict",
          code: "run_not_accepting_uploads",
          phase: entry.run.phase,
          message: "This run has already started cleaning."
        });
      }

      const batchIndex = Number.parseInt(request.params.batchIndex, 10);

      if (
        !Number.isFinite(batchIndex) ||
        batchIndex < 0 ||
        batchIndex >= entry.files.batchCount
      ) {
        return reply.code(400).send({
          error: "Bad Request",
          message: `batchIndex must be between 0 and ${entry.files.batchCount - 1}`
        });
      }

      // A retry gets a NEW attempt number, and its files land on attempt-qualified
      // paths, so a stalled predecessor still streaming to disk cannot corrupt
      // them. Computed before spooling because the paths depend on it.
      const attempt = (entry.files.batches.get(batchIndex)?.attempt ?? 0) + 1;
      const expectedCount = expectedCountForBatch(entry.files, batchIndex);
      const accepted: { position: number; filename: string; path: string }[] = [];
      const rejected: { filename: string; reason: string }[] = [];
      const startedAt = Date.now();

      try {
        let position = 0;

        for await (const part of request.files()) {
          const name = baseName(part.filename ?? "upload");

          if (!isXmlName(name)) {
            // Drain so iteration can advance; the position is consumed either
            // way, which is why gaps in the position space must stay harmless.
            await part.toBuffer();
            rejected.push({ filename: name, reason: "not an XML sitemap" });
            position += 1;
            continue;
          }

          if (position >= expectedCount) {
            await part.toBuffer();
            rejected.push({ filename: name, reason: "batch is larger than declared" });
            position += 1;
            continue;
          }

          const dest = path.join(
            entry.run.inDir,
            `b${batchIndex}-p${position}-a${attempt}__${name}`
          );

          await entry.metrics.timeAsync("upload.pipeline_ms", () =>
            pipeline(part.file, createWriteStream(dest))
          );
          accepted.push({ position, filename: name, path: dest });
          position += 1;
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

      registerBatch(entry.files, batchIndex, accepted);
      entry.run.receivedFiles = receivedFileCount(entry.files);
      entry.uploadWallMs += Date.now() - startedAt;
      entry.metrics.inc("upload.files", accepted.length);
      entry.metrics.inc("upload.batches");
      touchRunUpload(entry.run.runId);

      publishProgress(entry, {
        stage: "upload",
        current: entry.run.receivedFiles,
        total: entry.run.expectedTotal,
        message: `Uploaded ${entry.run.receivedFiles} of ${entry.run.expectedTotal} files`
      });

      // Kick off Pass 1 for these files and return IMMEDIATELY. Awaiting here
      // would serialise the three concurrent uploads behind a 4-thread pool and
      // reinvent the stall this whole feature removes.
      for (const file of accepted) {
        entry.classifyQueue.push({ batchIndex, attempt, ...file });
      }
      pumpClassify(entry);

      return reply.code(202).send({
        run_id: entry.run.runId,
        batch_index: batchIndex,
        attempt,
        accepted: accepted.length,
        rejected,
        received_files: entry.run.receivedFiles,
        expected_files: entry.run.expectedTotal
      });
    }
  );

  // ---- 4. Complete ----------------------------------------------------------
  app.post<{ Params: { runId: string } }>(
    "/api/cleaner/runs/:runId/complete",
    async (request, reply) => {
      const entry = batched.get(request.params.runId);

      if (!entry) {
        return reply
          .code(404)
          .send({ error: "Not Found", message: "no such cleaning run" });
      }

      if (entry.run.phase !== "uploading") {
        return reply.code(409).send({
          error: "Conflict",
          code: "run_not_accepting_uploads",
          phase: entry.run.phase
        });
      }

      // Deliberately stricter than the Migration side's upload-complete. Cleaner
      // output is a whole-corpus artifact: a missing batch does not mean a
      // smaller ZIP, it means wrong kept_in attributions and a wrong
      // sitemap-index.xml. Naming the exact batches lets the client re-send only
      // those instead of redoing the whole upload.
      const { missing, partial } = missingBatches(entry.files);

      if (missing.length > 0 || partial.length > 0) {
        return reply.code(409).send({
          error: "Conflict",
          code: "incomplete_upload",
          missing_batches: missing,
          partial_batches: partial,
          message: `${missing.length} batch(es) missing, ${partial.length} incomplete`
        });
      }

      entry.run.phase = "cleaning";

      // Detached: the clean no longer holds a request open at all.
      void runTerminalPhase(entry);

      return reply.code(202).send({
        run_id: entry.run.runId,
        received_files: entry.run.receivedFiles,
        phase: "cleaning"
      });
    }
  );

  // ---- 5. Status (server-authoritative resume) ------------------------------
  app.get<{ Params: { runId: string } }>(
    "/api/cleaner/runs/:runId",
    async (request, reply) => {
      const run = getRun(request.params.runId);

      if (!run) {
        return reply
          .code(404)
          .send({ error: "Not Found", code: "run_gone", message: "no such cleaning run" });
      }

      const entry = batched.get(request.params.runId);
      const ledger = entry ? missingBatches(entry.files) : { missing: [], partial: [] };

      return reply.send({
        run_id: run.runId,
        server_epoch: SERVER_EPOCH,
        status: run.status,
        phase: run.phase,
        expected_files: run.expectedTotal,
        received_files: run.receivedFiles,
        classified_files: entry?.classified ?? 0,
        batch_size: run.batchSize,
        batch_count: run.batchCount,
        missing_batches: ledger.missing,
        partial_batches: ledger.partial,
        terminal_frame: run.terminalFrame
      });
    }
  );

  // ---- 6. Cancel ------------------------------------------------------------
  // Aborting the client's in-flight XHR is no longer enough: that would stop one
  // batch and leave a live run holding a working directory.
  app.delete<{ Params: { runId: string } }>(
    "/api/cleaner/runs/:runId",
    async (request, reply) => {
      const run = getRun(request.params.runId);

      if (!run) {
        return reply.code(404).send({ error: "Not Found", message: "no such cleaning run" });
      }

      run.controller.abort();
      finishRun(run.runId, "error", {
        type: "error",
        code: "cancelled",
        message: "Cleaning cancelled."
      });

      const entry = batched.get(run.runId);

      if (entry) {
        discardBatchedRun(entry);
      }

      return reply.code(202).send({ run_id: run.runId, cancelled: true });
    }
  );
}
