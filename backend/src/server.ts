import cors from "@fastify/cors";
import Fastify from "fastify";
import multipart from "@fastify/multipart";

// Install the TLS policy (corporate SSL-proxy handling) before anything makes
// an outbound request. (v1.39 Fix 1)
import "./http/tlsDispatcher.js";
import { awsConfigStatus, config } from "./config.js";
import { initEventLog } from "./diagnostics/eventLog.js";
import { logPrivateHostMapStatus } from "./http/privateHostMap.js";
import { closeSitemapQueue } from "./queue/sitemapQueue.js";
import { destroyCleanerPools } from "./jobs/cleanerPool.js";
import { destroyPatternPopulationPool } from "./jobs/patternPopulationPool.js";
import { closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { fsErrorResponse } from "./errors/fsErrors.js";
import { sessionRoutes } from "./routes/sessions.js";
import { verificationRoutes } from "./routes/verification.js";
import { cleanerRoutes } from "./routes/cleaner.js";
import {
  activeRunCount,
  SERVER_EPOCH,
  startAbandonedRunWatchdog
} from "./sitemaps/cleanerRuns.js";

// Both the API and the worker append to the SAME per-session diagnostic file, so each
// has to stamp which one it was: "who observed this" is the first question when the two
// disagree about a host.
initEventLog({
  service: "backend",
  dir: config.diagnostics.dir,
  enabled: config.diagnostics.enabled,
  maxFileBytes: config.diagnostics.maxFileBytes
});

const app = Fastify({
  logger: true
});

// What the private-host map holds, said once at boot. A hostname claimed by two IPs or
// a file mounted at the wrong path is an ops mistake, and the restart that followed the
// edit is the moment to surface it — not, silently, at the first probe of an affected
// site hours later, where it would read as a site problem.
logPrivateHostMapStatus(app.log, {
  enabled: config.privateRoute.enabled,
  file: config.privateRoute.mapFile,
  reloadSeconds: config.privateRoute.mapReloadSeconds
});

// Which compose file started this container, and which AWS-gated variables it
// actually received. Said once at boot, for the same reason the private-host map
// says its contents once: a container built from the wrong compose file is an ops
// mistake, and the restart is the moment to surface it — not, hours later, as a
// 503 naming one variable that the operator can plainly see set in .env.
//
// Names and booleans only, so this line is safe to paste into a ticket.
app.log.info(awsConfigStatus(), "deployment config");

await app.register(cors, {
  origin: true,
  exposedHeaders: ["content-disposition"]
});
await app.register(multipart, {
  limits: {
    files: 5000,
    fileSize: 1024 * 1024 * 1024,
    // busboy counts every field AND every file as a "part" and defaults to 1000,
    // so raising `files` alone was not enough: a single request carrying more than
    // 1000 files failed with a bare 400 "reach parts limit" regardless. Measured
    // directly — 600 files in one request passed, 1200 did not. Kept in step with
    // `files` (plus headroom for the handful of text fields) so the two limits
    // cannot disagree again.
    parts: 5100
  }
});
// Central error mapping so file-system failures surface as actionable HTTP
// responses instead of an opaque 500 (which the frontend used to render as the
// misleading "Cannot connect to backend"). Set BEFORE registering routes so the
// encapsulated route plugin inherits this handler rather than the framework
// default. Only fires for errors that reach the framework — handlers that send
// their own reply are unaffected.
app.setErrorHandler((error, request, reply) => {
  const fsError = fsErrorResponse(error);

  if (fsError) {
    if (fsError.status >= 500) {
      request.log.error({ err: error }, "request failed: filesystem error");
    } else {
      request.log.warn({ err: error }, "request failed: filesystem error");
    }

    return reply.code(fsError.status).send(fsError.body);
  }

  // Preserve an explicit 4xx (e.g. validation) the framework already set;
  // otherwise treat as a 500 — but always include a message so the client never
  // sees a blank error.
  const statusCode =
    typeof error.statusCode === "number" && error.statusCode >= 400
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    request.log.error({ err: error }, "request failed");
  }

  return reply.code(statusCode).send({
    error: statusCode >= 500 ? "Internal Server Error" : error.name || "Error",
    message: error.message || "Something went wrong — please try again"
  });
});

await app.register(sessionRoutes);
await app.register(verificationRoutes);
await app.register(cleanerRoutes);

// `config` here is names-and-booleans only, never a value, so this stays safe on
// an unauthenticated endpoint. It exists because a 503 naming one variable could
// not distinguish "missing from .env" from "container started from the wrong
// compose file" — the two look identical from outside, and telling them apart
// otherwise needs SSH. Reachable through the frontend proxy at
// /api/backend/health, so one browser request answers it.
app.get("/health", async () => ({
  ok: true,
  service: "backend",
  mode: config.nodeEnv,
  uploadDir: config.uploadDir,
  exportDir: config.exportDir,
  config: awsConfigStatus()
}));

app.get("/", async () => ({
  name: "Sitemap Migration Health Checker API",
  status: "ready"
}));

async function start() {
  try {
    await runMigrations(app.log);
    // Reaps Cleaner runs nobody is watching any more, releasing the SFTP
    // connection slots they hold. A client disconnect no longer stops a run — see
    // sitemaps/cleanerRuns.ts — so this is what keeps "runs on without a viewer"
    // from meaning "forever" on a shared endpoint.
    startAbandonedRunWatchdog((runIds) => {
      app.log.warn(
        { run_ids: runIds, count: runIds.length },
        "stopped cleaner run(s) left unwatched past the abandon grace period; SFTP slots released"
      );
    });
    await app.listen({
      port: config.port,
      host: "0.0.0.0"
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

async function close() {
  await app.close();
  await closeSitemapQueue();
  await destroyCleanerPools();
  // Enumeration runs in the WORKER, so this pool is normally never created here
  // — but the module is loaded by the verification routes, and a pool that is
  // never destroyed is a process that never exits if that ever changes.
  await destroyPatternPopulationPool();
  await closePool();
}

// An API restart is the one thing that destroys live Cleaner runs outright: they
// are held in a process-local Map, so a crash takes every in-progress clean with
// it and the user's next reconnect is a bare 404. That made a crash and an
// abandonment reap look identical from the outside, and with no handler here a
// crash left nothing in the logs tying it to the runs it killed — the process was
// simply gone and back, restarted by Docker's `restart: unless-stopped`.
//
// These handlers do not swallow anything. An unhandled rejection or uncaught
// exception still exits non-zero; what changes is that it says so first, names
// how many runs it is destroying, and flushes before going. Anyone reading logs
// after a "no longer available" report can now see whether the API died under
// the run — which is not something the message on the screen could ever tell
// them.
function logFatal(kind: string, error: unknown) {
  try {
    app.log.fatal(
      {
        err: error,
        kind,
        active_cleaner_runs: activeRunCount(),
        server_epoch: SERVER_EPOCH
      },
      `${kind}: the API is exiting — every in-progress Cleaner run is lost with it`
    );
  } catch {
    // Logging must never be the reason a fatal path fails to reach the exit.
    console.error(`[fatal] ${kind}`, error);
  }
}

process.on("unhandledRejection", (reason) => {
  logFatal("unhandledRejection", reason);
  // Matches Node's own default (`--unhandled-rejections=throw`) rather than
  // quietly continuing in an unknown state.
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logFatal("uncaughtException", error);
  process.exit(1);
});

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

void start();
