import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { Redis } from "ioredis";

import { redisConnectionOptions } from "../queue/redisConnection.js";
import {
  acquirePublishLock,
  closePublishLockClient,
  isPublishLocked,
  PublishLockedError,
  withPublishLock
} from "./publishLock.js";

// The per-domain publish lock is the single most important multi-user
// guarantee: 10+ SEO users share one VM, and two publishes of the SAME domain
// would interleave writes to the same S3 keys with no bucket versioning to undo
// the mess. These tests run against a REAL Redis (the same one BullMQ uses),
// because the whole point is cross-process behaviour that an in-memory fake
// would not prove.
//
// Skipped, not failed, when Redis is unreachable, so the suite still runs on a
// machine with no stack up.

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis({
    ...(redisConnectionOptions() as Record<string, unknown>),
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 1
  } as never);

  try {
    await probe.connect();
    await probe.ping();

    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();
const domainA = () => `test-a-${randomUUID()}.com`;
const domainB = () => `test-b-${randomUUID()}.com`;

after(async () => {
  await closePublishLockClient();
});

test(
  "same domain: the second concurrent publish is rejected, not queued",
  { skip: available ? false : "redis unavailable" },
  async () => {
    const domain = domainA();

    // Both attempts race for the same domain, as two users clicking Publish
    // within the same second would.
    const [first, second] = await Promise.allSettled([
      acquirePublishLock(domain),
      acquirePublishLock(domain)
    ]);

    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "exactly one publish may hold the lock");
    assert.equal(rejected.length, 1, "the other must be rejected outright");

    const error = (rejected[0] as PromiseRejectedResult).reason;
    assert.ok(
      error instanceof PublishLockedError,
      "rejection must be the typed lock error (drives the 409)"
    );
    assert.match(error.message, /already publishing/i);
    assert.ok(
      error.message.includes(domain),
      "message names the domain so the user knows which one is busy"
    );

    // Releasing frees the domain for the next attempt.
    const held = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquirePublishLock>>>).value;
    assert.equal(await isPublishLocked(domain), true);
    await held.release();
    assert.equal(await isPublishLocked(domain), false);

    const retry = await acquirePublishLock(domain);
    await retry.release();
  }
);

test(
  "different domains publish fully in parallel — no blocking",
  { skip: available ? false : "redis unavailable" },
  async () => {
    const a = domainA();
    const b = domainB();

    const [lockA, lockB] = await Promise.all([
      acquirePublishLock(a),
      acquirePublishLock(b)
    ]);

    assert.equal(await isPublishLocked(a), true);
    assert.equal(await isPublishLocked(b), true);

    await Promise.all([lockA.release(), lockB.release()]);
    assert.equal(await isPublishLocked(a), false);
    assert.equal(await isPublishLocked(b), false);
  }
);

test(
  "the lock is released even when the publish throws",
  { skip: available ? false : "redis unavailable" },
  async () => {
    const domain = domainA();

    await assert.rejects(
      withPublishLock(domain, async () => {
        assert.equal(await isPublishLocked(domain), true);
        throw new Error("publish blew up");
      }),
      /publish blew up/
    );

    // A crashed publish must not wedge the domain until the TTL lapses.
    assert.equal(
      await isPublishLocked(domain),
      false,
      "finally must release the lock on the failure path"
    );
  }
);

test(
  "release is token-scoped: a stale holder cannot free someone else's lock",
  { skip: available ? false : "redis unavailable" },
  async () => {
    const domain = domainA();

    const original = await acquirePublishLock(domain);
    // Simulate the original's TTL lapsing and a second publish taking over.
    const client = new Redis(redisConnectionOptions() as never);

    try {
      await client.del(`publish-lock:${domain}`);
      const takeover = await acquirePublishLock(domain);

      // The stale holder now releases — it must NOT drop the new owner's lock.
      await original.release();
      assert.equal(
        await isPublishLocked(domain),
        true,
        "takeover's lock must survive the stale holder's release"
      );

      await takeover.release();
      assert.equal(await isPublishLocked(domain), false);
    } finally {
      await client.quit().catch(() => undefined);
    }
  }
);
