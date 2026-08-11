import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";

import { redisConnectionOptions } from "./redisConnection.js";

// A single-holder Redis lock: SET NX with a token, released by a compare-and-delete
// so an expired-and-retaken lock can never be stolen back by its previous holder.
//
// Extracted from publish/publishLock.ts, which has run this exact mechanism in
// production since Phase 1. What is NOT extracted is its POLICY: a publish
// collision must fail fast (a queued publish would silently overwrite production
// minutes later), whereas a strategy negotiation collision must WAIT for the
// winner's answer — negotiating the same host twice in parallel is the cost this
// engine exists to remove. Same primitive, opposite policies, so the primitive
// lives here and each caller keeps its own.
//
// TTL is the crash backstop only; the happy path always releases in a finally.

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(redisConnectionOptions() as never);
  }

  return client;
}

// Exported so callers can share the one connection rather than opening their own.
export function lockRedis(): Redis {
  return redis();
}

export type RedisLock = {
  key: string;
  token: string;
  release: () => Promise<void>;
};

// Only delete the key while we still own it. A plain DEL could drop a lock that had
// expired and been legitimately taken by someone else.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

// Take `key`, or return null immediately if someone else holds it. Never blocks —
// the caller decides whether to fail, wait, or carry on without the lock.
export async function tryAcquireRedisLock(
  key: string,
  ttlSeconds: number
): Promise<RedisLock | null> {
  const token = randomUUID();
  const result = await redis().set(key, token, "EX", Math.max(1, ttlSeconds), "NX");

  if (result !== "OK") {
    return null;
  }

  let released = false;

  return {
    key,
    token,
    release: async () => {
      // Idempotent: a double release (finally plus an explicit call) must not free
      // a lock someone else has since taken.
      if (released) {
        return;
      }

      released = true;
      await redis().eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
    }
  };
}

export async function isRedisLockHeld(key: string): Promise<boolean> {
  return (await redis().exists(key)) === 1;
}

export async function closeRedisLockClient(): Promise<void> {
  const existing = client;

  client = null;
  await existing?.quit().catch(() => undefined);
}
