import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import pg from "pg";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";

const MIGRATION_LOCK_KEY_1 = 482001;
const MIGRATION_LOCK_KEY_2 = 20260629;

type MigrationFile = {
  version: string;
  name: string;
  filePath: string;
};

async function listMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(config.migrationsDir);

  return entries
    .filter((entry) => entry.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => {
      const version = entry.split("_", 1)[0];

      return {
        version,
        name: entry,
        filePath: path.join(config.migrationsDir, entry)
      };
    });
}

export async function runMigrations(logger: FastifyBaseLogger) {
  const client = new pg.Client({
    connectionString: config.databaseUrl
  });

  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query("SELECT pg_advisory_lock($1, $2)", [
      MIGRATION_LOCK_KEY_1,
      MIGRATION_LOCK_KEY_2
    ]);

    const migrations = await listMigrationFiles();

    for (const migration of migrations) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [migration.version]
      );

      if (applied.rowCount && applied.rowCount > 0) {
        continue;
      }

      const sql = await readFile(migration.filePath, "utf8");

      logger.info({ migration: migration.name }, "applying database migration");
      await client.query("BEGIN");

      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
          [migration.version, migration.name]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }

      logger.info({ migration: migration.name }, "database migration applied");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [
      MIGRATION_LOCK_KEY_1,
      MIGRATION_LOCK_KEY_2
    ]);
    await client.end();
  }
}

