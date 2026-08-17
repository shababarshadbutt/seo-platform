import cors from "@fastify/cors";
import Fastify from "fastify";
import multipart from "@fastify/multipart";

// Install the TLS policy (corporate SSL-proxy handling) before anything makes
// an outbound request. (v1.39 Fix 1)
import "./http/tlsDispatcher.js";
import { config } from "./config.js";
import { closeSitemapQueue } from "./queue/sitemapQueue.js";
import { destroyCleanerPools } from "./jobs/cleanerPool.js";
import { closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { fsErrorResponse } from "./errors/fsErrors.js";
import { sessionRoutes } from "./routes/sessions.js";
import { cleanerBatchRoutes, cleanerRoutes } from "./routes/cleaner.js";
import {
  startAbandonedRunWatchdog,
  stopAbandonedRunWatchdog
} from "./sitemaps/cleanerRuns.js";

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: true,
  exposedHeaders: ["content-disposition"]
});
await app.register(multipart, {
  limits: {
    files: 5000,
    fileSize: 1024 * 1024 * 1024
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
await app.register(cleanerRoutes);
await app.register(cleanerBatchRoutes);

// Batched cleaner runs outlive the requests that create them, so something has
// to reclaim the ones nobody finishes. Two rules, one interval: a run whose SSE
// viewer stopped heartbeating, and a run whose batches stopped arriving.
//
// NOTE: batched runs live in THIS process (see cleanerRuns.ts). The backend must
// therefore stay a SINGLE REPLICA — with more than one, a batch POST could land
// on a process that has never heard of the run and 404 mid-upload.
startAbandonedRunWatchdog((runIds) => {
  app.log.warn({ run_ids: runIds }, "reaped abandoned cleaner runs");
});

app.get("/health", async () => ({
  ok: true,
  service: "backend",
  mode: config.nodeEnv,
  uploadDir: config.uploadDir,
  exportDir: config.exportDir
}));

app.get("/", async () => ({
  name: "Sitemap Migration Health Checker API",
  status: "ready"
}));

async function start() {
  try {
    await runMigrations(app.log);
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
  stopAbandonedRunWatchdog();
  await destroyCleanerPools();
  await closePool();
}

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

void start();
