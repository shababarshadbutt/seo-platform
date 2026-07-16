import cors from "@fastify/cors";
import Fastify from "fastify";
import multipart from "@fastify/multipart";

import { config } from "./config.js";
import { closeSitemapQueue } from "./queue/sitemapQueue.js";
import { closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { sessionRoutes } from "./routes/sessions.js";

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
await app.register(sessionRoutes);

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
  await closePool();
}

process.on("SIGINT", () => {
  void close().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

void start();
