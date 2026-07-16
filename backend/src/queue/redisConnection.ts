import type { ConnectionOptions } from "bullmq";

import { config } from "../config.js";

export function redisConnectionOptions(): ConnectionOptions {
  const url = new URL(config.redisUrl);
  const db = url.pathname ? Number.parseInt(url.pathname.slice(1), 10) : 0;

  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isFinite(db) ? db : 0,
    maxRetriesPerRequest: null
  };
}

