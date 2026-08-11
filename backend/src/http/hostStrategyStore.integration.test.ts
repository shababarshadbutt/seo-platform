import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { test } from "node:test";

import pg from "pg";

// The two-tier store, against a REAL Redis and Postgres. hostStrategy.test.ts covers
// every decision with an in-memory store; what only a real stack can prove is the
// read ORDER — a cold Redis must fall through to the table and repopulate itself,
// because re-negotiating just because a cache was flushed would spend real requests
// at a client's origin to rediscover something already written down.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

async function postgresReachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000
  });

  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

function redisReachable(): Promise<boolean> {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");

  return new Promise((resolve) => {
    const socket = net.connect({
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 6379,
      timeout: 3000
    });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const silentLogger: any = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  }
};

test("the host strategy store round-trips through Redis and the table", async (t) => {
  if (!(await postgresReachable())) {
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { hostStrategyStore, invalidateHostStrategyCache } = await import(
    "./hostStrategyStore.js"
  );
  const { lockRedis, closeRedisLockClient } = await import(
    "../queue/redisLock.js"
  );

  const host = `strategy-itest-${randomUUID()}.example.com`;

  t.after(async () => {
    await pool
      .query("DELETE FROM host_probe_profiles WHERE host = $1", [host])
      .catch(() => {});
    await lockRedis()
      .del(`host-strategy:${host}`)
      .catch(() => undefined);
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
  });

  await runMigrations(silentLogger);

  // Migration 044 must actually be present — the whole engine writes here.
  const column = await pool.query(
    `
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'host_probe_profiles'
      ORDER BY column_name
    `
  );

  assert.deepEqual(
    column.rows.map((row) => row.column_name),
    ["decided_at", "edge_server", "host", "last_status", "verdict", "winning_rung"]
  );

  assert.equal(await hostStrategyStore.read(host), null);

  const decidedAt = new Date().toISOString();

  await hostStrategyStore.write({
    host,
    verdict: "OK",
    rung: "R2",
    edgeServer: "nginx/1.28.3",
    lastStatus: 200,
    decidedAt
  });

  // Written to BOTH tiers.
  const fromCache = await hostStrategyStore.read(host);

  assert.equal(fromCache?.rung, "R2");
  assert.equal(fromCache?.edgeServer, "nginx/1.28.3");
  assert.equal(await lockRedis().exists(`host-strategy:${host}`), 1);

  const row = await pool.query(
    "SELECT verdict, winning_rung, edge_server, last_status FROM host_probe_profiles WHERE host = $1",
    [host]
  );

  assert.equal(row.rows[0].verdict, "OK");
  assert.equal(row.rows[0].winning_rung, "R2");
  assert.equal(row.rows[0].edge_server, "nginx/1.28.3");
  assert.equal(row.rows[0].last_status, 200);

  // COLD CACHE: the durable row answers, and the cache is warmed again rather than
  // the caller being told "unknown" (which would trigger a needless negotiation).
  await invalidateHostStrategyCache(host);
  assert.equal(await lockRedis().exists(`host-strategy:${host}`), 0);

  const fromTable = await hostStrategyStore.read(host);

  assert.equal(fromTable?.rung, "R2");
  assert.equal(await lockRedis().exists(`host-strategy:${host}`), 1);

  // A re-negotiation overwrites in place — one row per host, no history pile-up.
  await hostStrategyStore.write({
    host,
    verdict: "REFUSED",
    rung: null,
    edgeServer: "awselb/2.0",
    lastStatus: 403,
    decidedAt: new Date().toISOString()
  });

  const refused = await hostStrategyStore.read(host);

  assert.equal(refused?.verdict, "REFUSED");
  assert.equal(refused?.rung, null);

  const count = await pool.query(
    "SELECT count(*)::int AS n FROM host_probe_profiles WHERE host = $1",
    [host]
  );

  assert.equal(count.rows[0].n, 1);

  // THE RACE GUARD, at the real Redis: one holder at a time, and a released lock is
  // immediately re-acquirable.
  const first = await hostStrategyStore.lock(host);

  assert.ok(first);
  assert.equal(await hostStrategyStore.lock(host), null);

  await first!.release();

  const second = await hostStrategyStore.lock(host);

  assert.ok(second);
  await second!.release();
});
