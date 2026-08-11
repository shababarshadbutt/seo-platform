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
  async read(host) {
    const cached = await lockRedis()
      .get(`${KEY_PREFIX}${host}`)
      .catch(() => null);

    if (cached) {
      try {
        return JSON.parse(cached) as StoredHostStrategy;
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

    return stored;
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
    const lock = await tryAcquireRedisLock(
      `${LOCK_PREFIX}${host}`,
      LOCK_TTL_SECONDS
    );

    return lock ? { release: lock.release } : null;
  }
};

async function cacheStrategy(value: StoredHostStrategy): Promise<void> {
  await lockRedis()
    .set(
      `${KEY_PREFIX}${value.host}`,
      JSON.stringify(value),
      "EX",
      HOST_STRATEGY_TTL_SECONDS
    )
    .catch(() => undefined);
}

// Drop a host's hot entry, e.g. after an allowlist lands and someone wants the next
// run to re-negotiate rather than waiting out the TTL. The durable row stays, so the
// fleet report keeps its history until a fresh negotiation overwrites it.
export async function invalidateHostStrategyCache(host: string): Promise<void> {
  await lockRedis()
    .del(`${KEY_PREFIX}${host}`)
    .catch(() => undefined);
}
