import { config } from "../config.js";
import {
  closeRedisLockClient,
  isRedisLockHeld,
  tryAcquireRedisLock
} from "../queue/redisLock.js";

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
// THE MECHANISM now lives in queue/redisLock.ts (SET NX with a token, released by
// a compare-and-delete so a lock that expired and was re-acquired by someone else
// is never stolen back). Only the POLICY is here. The per-host strategy engine
// needs the same primitive with the OPPOSITE policy — a negotiation collision must
// wait for the winner's answer rather than fail — so the primitive is shared and
// each caller keeps its own decision about what a collision means.
//
// TTL is the crash backstop — the happy path always releases in a finally.

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

// Take the lock for `domain`, or throw PublishLockedError if another publish
// holds it. Never blocks.
export async function acquirePublishLock(domain: string): Promise<PublishLock> {
  const lock = await tryAcquireRedisLock(
    keyFor(domain),
    config.publishLockTtlSeconds
  );

  if (!lock) {
    throw new PublishLockedError(domain);
  }

  return {
    domain,
    token: lock.token,
    // Idempotent in the primitive: a double release (finally plus an explicit
    // call) must not free a lock someone else has since taken.
    release: lock.release
  };
}

// Who holds the lock for a domain, if anyone — for surfacing status in the UI
// without attempting to take it.
export async function isPublishLocked(domain: string): Promise<boolean> {
  return isRedisLockHeld(keyFor(domain));
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

// Closes the SHARED lock connection (see queue/redisLock.ts). Kept under this name
// because it is what the publish tests and shutdown paths already call.
export async function closePublishLockClient(): Promise<void> {
  await closeRedisLockClient();
}
