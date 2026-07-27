import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";

import { config } from "../config.js";
import { redisConnectionOptions } from "../queue/redisConnection.js";

// Per-DOMAIN publish lock (Phase 1). Scope matters: two users publishing
// DIFFERENT domains write to disjoint S3 prefixes (sites/<domain>/sitemaps/)
// and must proceed fully in parallel — a global lock would needlessly serialise
// 10+ users. Only two publishes of the SAME domain can interleave writes to the
// same keys, and that is what this prevents.
//
// On collision the second attempt is REJECTED, not queued: a queued publish
// would silently overwrite production minutes later, after the user had moved
// on, with no versioning to undo it. Failing fast with "someone is already
// publishing this domain" keeps a human in the loop.
//
// Ownership is token-based: release only deletes the key if it still holds THIS
// publish's token, so a lock that expired mid-run and was re-acquired by
// someone else is never stolen back. TTL is the crash backstop — the happy path
// always releases in a finally.

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(redisConnectionOptions() as never);
  }

  return client;
}

function keyFor(domain: string) {
  return `publish-lock:${domain}`;
}

export type PublishLock = {
  domain: string;
  token: string;
  release: () => Promise<void>;
};

export class PublishLockedError extends Error {
  constructor(readonly domain: string) {
    super(
      `Someone is already publishing ${domain}. Wait for that publish to finish, then try again.`
    );
    this.name = "PublishLockedError";
  }
}

// Only delete the key when we still own it — a plain DEL could drop a lock that
// had expired and been legitimately taken by another publish.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

// Take the lock for `domain`, or throw PublishLockedError if another publish
// holds it. Never blocks.
export async function acquirePublishLock(domain: string): Promise<PublishLock> {
  const token = randomUUID();
  const key = keyFor(domain);
  const result = await redis().set(
    key,
    token,
    "EX",
    config.publishLockTtlSeconds,
    "NX"
  );

  if (result !== "OK") {
    throw new PublishLockedError(domain);
  }

  let released = false;

  return {
    domain,
    token,
    release: async () => {
      // Idempotent: a double release (finally + explicit) must not free a lock
      // someone else has since taken.
      if (released) {
        return;
      }

      released = true;
      await redis().eval(RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
    }
  };
}

// Who holds the lock for a domain, if anyone — for surfacing status in the UI
// without attempting to take it.
export async function isPublishLocked(domain: string): Promise<boolean> {
  return (await redis().exists(keyFor(domain))) === 1;
}

// Run `work` under the domain's lock, releasing it immediately on ANY exit
// path. On a shared VM a lock held past the work it guards blocks a real user,
// so release is a finally, never batched or deferred to a later tick.
export async function withPublishLock<T>(
  domain: string,
  work: (lock: PublishLock) => Promise<T>
): Promise<T> {
  const lock = await acquirePublishLock(domain);

  try {
    return await work(lock);
  } finally {
    await lock.release();
  }
}

export async function closePublishLockClient(): Promise<void> {
  const existing = client;
  client = null;
  await existing?.quit().catch(() => undefined);
}
