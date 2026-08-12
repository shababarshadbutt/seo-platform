import { pool } from "../db/pool.js";
import { lockRedis, tryAcquireRedisLock } from "../queue/redisLock.js";
import {
  HOST_STRATEGY_TTL_SECONDS,
  type HostStrategyStore,
  type Rung,
  type StoredHostStrategy
} from "./hostStrategy.js";

// The real two-tier store behind the strategy engine.
//
// REDIS IS THE HOT PATH, the table is the durable record and the fleet report.
// Both are needed and neither is redundant:
//   * a sampling run resolves the same host for every pattern, so the read has to be
//     cheap enough to do freely — that is Redis;
//   * "which of the 650+ hosts refuse us, and which edge is refusing" has to survive
//     a Redis flush and be queryable by whoever talks to devops — that is the table.
//
// READ ORDER matters: Redis miss falls through to the table and REPOPULATES Redis.
// Re-negotiating just because a cache was cold would spend real requests at a
// client's origin to rediscover something already written down.

const KEY_PREFIX = "host-strategy:";
const LOCK_PREFIX = "host-strategy-lock:";
// REDIS IS A CACHE HERE, NEVER A DEPENDENCY.
//
// ioredis queues commands while disconnected and retries indefinitely by default, so
// a plain `await redis.get()` against a Redis that is down does not reject — it hangs
// forever, and a .catch() never fires. Wired into sampling, that turns "Redis is
// unavailable" into "the whole job stops with no error", which is exactly how the
// suite hung when this first landed.
//
// So every Redis call is raced against a short timeout and degrades: reads fall
// through to Postgres (the durable tier), writes lose only the cache entry, and the
// negotiation lock degrades to no lock at all — with Redis down the worst case is two
// processes each spending three probes on one host, which is a bounded cost, whereas
// stalling a run is not.
const REDIS_OP_TIMEOUT_MS = 1000;
// The lock only has to outlive one negotiation: at most three rungs, each a full
// check (HEAD plus a possible GET re-probe) with a 5s timeout, paced by the per-host
// limiter. 60s is generous; the happy path releases in a finally.
const LOCK_TTL_SECONDS = 60;

type ProfileRow = {
  host: string;
  verdict: string;
  winning_rung: string | null;
  edge_server: string | null;
  last_status: number | null;
  decided_at: string;
};

// Run a Redis operation, or give up quickly with `fallback`. See REDIS_OP_TIMEOUT_MS.
async function withRedisTimeout<T>(
  operation: () => Promise<T>,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), REDIS_OP_TIMEOUT_MS);
      })
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function rowToStored(row: ProfileRow): StoredHostStrategy {
  return {
    host: row.host,
    verdict: row.verdict === "REFUSED" ? "REFUSED" : "OK",
    rung: (row.winning_rung as Rung | null) ?? null,
    edgeServer: row.edge_server,
    lastStatus: row.last_status,
    decidedAt: new Date(row.decided_at).toISOString()
  };
}

export const hostStrategyStore: HostStrategyStore = {
  // Returns WHICH TIER answered alongside the value. The caller records it on the
  // resolved strategy so a diagnostic line can say whether a verdict was measured just
  // now or read from a cache — the difference between "this site refuses us" and "this
  // site refused us once, up to a week ago".
  async read(host) {
    const cached = await withRedisTimeout(
      () => lockRedis().get(`${KEY_PREFIX}${host}`),
      null
    );

    if (cached) {
      try {
        return {
          value: JSON.parse(cached) as StoredHostStrategy,
          source: "redis" as const
        };
      } catch {
        // A corrupt cache entry is not worth failing a run over — fall through to
        // the durable copy.
      }
    }

    const result = await pool.query<ProfileRow>(
      `
        SELECT host, verdict, winning_rung, edge_server, last_status,
               decided_at::text AS decided_at
        FROM host_probe_profiles
        WHERE host = $1
      `,
      [host]
    );
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    const stored = rowToStored(row);

    await cacheStrategy(stored);

    return { value: stored, source: "table" as const };
  },

  async write(value) {
    await pool.query(
      `
        INSERT INTO host_probe_profiles
          (host, verdict, winning_rung, edge_server, last_status, decided_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
        ON CONFLICT (host) DO UPDATE SET
          verdict = EXCLUDED.verdict,
          winning_rung = EXCLUDED.winning_rung,
          edge_server = EXCLUDED.edge_server,
          last_status = EXCLUDED.last_status,
          decided_at = EXCLUDED.decided_at
      `,
      [
        value.host,
        value.verdict,
        value.rung,
        value.edgeServer,
        value.lastStatus,
        value.decidedAt
      ]
    );
    await cacheStrategy(value);
  },

  async lock(host) {
    // `undefined` means Redis did not answer in time — distinct from `null`, which
    // means someone else genuinely holds the lock and we should wait for their answer.
    // With no Redis there is nobody to wait for, so negotiation proceeds unlocked
    // rather than stalling; the verdict still lands in Postgres.
    const lock = await withRedisTimeout<
      Awaited<ReturnType<typeof tryAcquireRedisLock>> | undefined
    >(() => tryAcquireRedisLock(`${LOCK_PREFIX}${host}`, LOCK_TTL_SECONDS), undefined);

    if (lock === undefined) {
      return { release: async () => undefined };
    }

    return lock ? { release: lock.release } : null;
  }
};

async function cacheStrategy(value: StoredHostStrategy): Promise<void> {
  await withRedisTimeout(
    () =>
      lockRedis().set(
        `${KEY_PREFIX}${value.host}`,
        JSON.stringify(value),
        "EX",
        HOST_STRATEGY_TTL_SECONDS
      ),
    null
  );
}

// Drop a host's hot entry, e.g. after an allowlist lands and someone wants the next
// run to re-negotiate rather than waiting out the TTL. The durable row stays, so the
// fleet report keeps its history until a fresh negotiation overwrites it.
export async function invalidateHostStrategyCache(host: string): Promise<void> {
  await withRedisTimeout(() => lockRedis().del(`${KEY_PREFIX}${host}`), 0);
}
