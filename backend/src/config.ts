type NumberEnvOptions = {
  fallback: number;
  min?: number;
  max?: number;
};

export const DEFAULT_HTTP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function readNumber(name: string, options: NumberEnvOptions): number {
  const raw = process.env[name];

  if (!raw) {
    return options.fallback;
  }

  const value = Number.parseInt(raw, 10);

  if (!Number.isFinite(value)) {
    return options.fallback;
  }

  if (options.min !== undefined && value < options.min) {
    return options.min;
  }

  if (options.max !== undefined && value > options.max) {
    return options.max;
  }

  return value;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: readNumber("PORT", { fallback: 3001, min: 1, max: 65535 }),
  workerHealthPort: readNumber("WORKER_HEALTH_PORT", {
    fallback: 3002,
    min: 1,
    max: 65535
  }),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://sitemap:sitemap@localhost:5432/sitemap_health",
  migrationsDir: process.env.MIGRATIONS_DIR ?? "migrations",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  uploadDir: process.env.UPLOAD_DIR ?? "/uploads",
  exportDir: process.env.EXPORT_DIR ?? "/exports",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
  pdfBackendUrl: process.env.PDF_BACKEND_URL,
  chromiumPath: process.env.CHROMIUM_PATH,
  patternUrlPoolMultiplier: readNumber("PATTERN_URL_POOL_MULTIPLIER", {
    fallback: 20,
    min: 1
  }),
  patternUrlPoolMinSize: readNumber("PATTERN_URL_POOL_MIN_SIZE", {
    fallback: 1000,
    min: 1
  }),
  defaultHttpUserAgent:
    process.env.DEFAULT_HTTP_USER_AGENT ?? DEFAULT_HTTP_USER_AGENT
};
