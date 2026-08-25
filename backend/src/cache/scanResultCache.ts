import { Redis } from "ioredis";

import { config } from "../config.js";
import { tryAcquireRedisLock, type RedisLock } from "../queue/redisLock.js";

// A read-through cache with single-flight, for results that are expensive to
// compute and cheap to store. Built for the structure-scoped source-file scan,
// which opens every sitemap a pattern spans: measured at 137,223 <loc>/s, the
// widest pattern in the dev data is ~100s of work, and before v1.83 the modal
// paid it again on every dropdown change.
//
// AN OPTIMISATION, NEVER A DEPENDENCY. Every Redis call here is wrapped: if Redis
// is down, unreachable, or returns junk, the caller still gets a correct answer
// by computing it, exactly as it did before this module existed. A cache that can
// take the feature down with it is worse than no cache.
//
// STALE ENTRIES ARE UNREACHABLE, NEVER DELETED — see sourceFileScanKey.ts for the
// reasoning. The TTL below is a crash/eviction backstop only, not the
// invalidation mechanism, which is the same posture redisLock.ts takes toward
// its own TTL. Nothing in this module deletes a key.

// ITS OWN CONNECTION, deliberately NOT redisLock's lockRedis().
//
// That one is configured for BullMQ, which REQUIRES maxRetriesPerRequest: null
// (see queue/redisConnection.ts). In ioredis that means a command issued while
// Redis is unreachable is retried indefinitely and never rejects — it sits in
// the offline queue. Correct for a queue, whose job is to not lose work; fatal
// here, because a `get` that never settles would make the modal hang instead of
// falling back to scanning. A try/catch cannot save you from a promise that
// simply never resolves.
//
// So this connection fails fast: one retry, no offline queue, short timeouts.
// The cost of being wrong is one uncached scan — the cost of hanging is the
// feature.
let client: Redis | null = null;

function cacheRedis(): Redis {
  if (!client) {
    const url = new URL(config.redisUrl);

    client = new Redis({
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 6379,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      maxRetriesPerRequest: 1,
      // Reject rather than queue when the socket is down. This is the setting
      // that makes the try/catch below meaningful.
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      lazyConnect: true,
      // Back off, but never give up: a cache that stays dead for the life of the
      // process after one blip would silently return this endpoint to its
      // pre-v1.83 cost with nothing to show why. Capped at 5s so an unreachable
      // Redis is not hammered either.
      retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000)
    });
    // An unreachable Redis must not print a reconnect error per attempt for the
    // life of the process; the reads already degrade silently.
    client.on("error", () => undefined);
  }

  return client;
}

// disconnect(), NOT quit().
//
// quit() sends a QUIT command and waits for the reply, which never arrives if the
// socket was never established — so shutting down while Redis is unreachable
// hangs. disconnect() closes immediately AND stops the reconnect loop above,
// which is what actually lets the process exit.
export function closeScanResultCache(): void {
  const existing = client;

  client = null;
  connectOnce = null;
  existing?.disconnect();
}

// Is the connection actually usable right now?
//
// NEEDED BECAUSE OF THE TWO OPTIONS ABOVE, which interact in a way that is easy
// to get wrong: lazyConnect means the socket is not opened until first use, and
// enableOfflineQueue: false means a command issued before it IS open is rejected
// rather than queued. Without this gate the first read AND the first write of
// the process both fail, so nothing is ever cached and every request looks like
// a miss — which is precisely the bug the tests caught.
//
// connect() is awaited once and its rejection swallowed: a refused connection is
// the degraded path, not an error. Afterwards `status` is the live answer, so a
// Redis that dies and comes back starts working again on its own.
let connectOnce: Promise<void> | null = null;

async function cacheReady(): Promise<Redis | null> {
  const connection = cacheRedis();

  if (!connectOnce) {
    connectOnce = connection.connect().catch(() => undefined);
  }

  await connectOnce;

  return connection.status === "ready" ? connection : null;
}

// Long, because it is not what makes the answer correct — a superseded entry is
// already unreachable under a new key. It only bounds how long an orphan holds
// bytes. The payload is a file list plus four counters (~50KB for the widest
// pattern here), so this is not a memory concern at any realistic session count.
const RESULT_TTL_SECONDS = 6 * 60 * 60;

// Comfortably above the worst realistic scan, because redisLock has NO renewal —
// tryAcquireRedisLock is a single SET NX EX, so a scan outliving its lock lets a
// second caller start one too.
//
// Sized from measurement, not habit: ~100s at the measured 137k locs/s, and up
// to ~260s if the real cold-disk rate is nearer dryRunScanPool's inline 52k. The
// client's 180s cap is NOT an upper bound — migration 037 documents a client
// aborting at 30s while the work committed ~130s later, so the scan can outlive
// the request that asked for it.
//
// A heartbeat would be the textbook answer and is deliberately not used: it would
// mean changing a primitive shared with publishLock and the host-strategy
// negotiation, and the worst case here is duplicated READ-ONLY CPU, not
// corruption. release()'s compare-and-delete already guarantees an
// expired-and-retaken lock is never stolen back by its old holder.
const SCAN_LOCK_TTL_SECONDS = 600;

// How long a loser waits for the winner's answer before computing it itself.
//
// BOUNDED, because a winner that dies without writing must not leave every other
// caller spinning. 170s sits just under the client's 180s timeout
// (EXPORT_API_TIMEOUT_MS), so a loser that gives up still hands the user v1.82's
// "took too long" message rather than an ambiguous hang, and the fallback means a
// crashed winner degrades to pre-v1.83 behaviour instead of a failure.
const LOSER_WAIT_BUDGET_MS = 170_000;
const LOSER_POLL_MIN_MS = 250;
const LOSER_POLL_MAX_MS = 2_000;

// Test-only: how many times the compute function actually ran. The single-flight
// guarantee is "N concurrent callers cost ONE computation", and the only honest
// way to assert that is to count invocations — timing would be flaky on a loaded
// box, and a cache hit and a deduplicated wait are indistinguishable from the
// outside.
let computeCount = 0;

export function computeCountForTests(): number {
  return computeCount;
}

export function resetComputeCountForTests(): void {
  computeCount = 0;
}

async function readCached<T>(key: string): Promise<T | null> {
  try {
    const connection = await cacheReady();
    const raw = connection ? await connection.get(key) : null;

    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    // Redis down, or a value this version cannot parse. Either way: recompute.
    return null;
  }
}

async function writeCached<T>(key: string, value: T): Promise<void> {
  try {
    const connection = await cacheReady();

    await connection?.set(key, JSON.stringify(value), "EX", RESULT_TTL_SECONDS);
  } catch {
    // A result that cannot be cached is still a result. The caller has it.
  }
}

export type CachedResult<T> = {
  value: T;
  // True only when the answer came out of the cache without being computed
  // here — including by waiting for another request's computation. The UI shows
  // this so an instant result reads as a cache hit rather than a suspiciously
  // fast (or suspiciously empty) scan.
  cached: boolean;
};

// Try to become the computer for `key` after losing the first race — the
// previous holder may have finished without publishing, crashed, or let its lock
// lapse. Never throws: a failure here just means "keep waiting".
async function takeOverLock(key: string): Promise<RedisLock | null> {
  try {
    const connection = await cacheReady();

    return connection
      ? await tryAcquireRedisLock(key, SCAN_LOCK_TTL_SECONDS, connection)
      : null;
  } catch {
    return null;
  }
}

// Read `key`, or compute it once across all concurrent callers.
//
// The three outcomes, in the order they are checked:
//   1. HIT           — return it.
//   2. WON the lock  — compute, cache, release.
//   3. LOST the lock — wait for the winner's entry, then fall back to computing.
export async function cachedWithSingleFlight<T>(
  key: string,
  compute: () => Promise<T>
): Promise<CachedResult<T>> {
  const hit = await readCached<T>(key);

  if (hit) {
    return { value: hit, cached: true };
  }

  // Two different nulls, and collapsing them is a bug worth naming:
  // tryAcquireRedisLock RETURNS null when someone else holds the lock (wait for
  // their answer), and THROWS when Redis cannot be reached (there is nobody to
  // wait for). Treating the second as the first would make every request sit
  // through the full loser budget before doing the work it could have started
  // immediately.
  //
  // Passes OUR fail-fast client: the default one would hang rather than reject.
  let lock: RedisLock | null = null;
  let coordinated = true;

  try {
    const connection = await cacheReady();

    if (connection) {
      lock = await tryAcquireRedisLock(key, SCAN_LOCK_TTL_SECONDS, connection);
    } else {
      coordinated = false;
    }
  } catch {
    coordinated = false;
  }

  if (!coordinated) {
    // No cache and no coordination available. Do exactly what this endpoint did
    // before v1.83: compute it.
    computeCount += 1;

    return { value: await compute(), cached: false };
  }

  if (lock) {
    try {
      computeCount += 1;

      const value = await compute();

      await writeCached(key, value);

      return { value, cached: false };
    } finally {
      await lock.release();
    }
  }

  // Someone else is already computing this exact answer. Wait for it rather than
  // duplicating ~100s of disk reads.
  //
  // Each pass asks TWO questions, not one: has the winner published, and is the
  // lock still held? Polling only the cache would mean a winner that died — or
  // whose lock simply lapsed — left everyone else waiting out the entire budget
  // for an answer that is never coming. Re-acquiring turns that into "take over
  // and compute", which is why the wait can be generous without being a trap.
  const deadline = Date.now() + LOSER_WAIT_BUDGET_MS;
  let delay = LOSER_POLL_MIN_MS;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));

    const winner = await readCached<T>(key);

    if (winner) {
      return { value: winner, cached: true };
    }

    const takenOver = await takeOverLock(key);

    if (takenOver) {
      try {
        computeCount += 1;

        const value = await compute();

        await writeCached(key, value);

        return { value, cached: false };
      } finally {
        await takenOver.release();
      }
    }

    delay = Math.min(delay * 2, LOSER_POLL_MAX_MS);
  }

  // The winner never wrote — crashed, evicted, or slower than the budget. Do the
  // work rather than failing: a duplicated scan is the pre-v1.83 cost, and a
  // wrong answer is not on the table.
  computeCount += 1;

  const value = await compute();

  await writeCached(key, value);

  return { value, cached: false };
}
