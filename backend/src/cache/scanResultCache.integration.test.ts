import assert from "node:assert/strict";
import { test } from "node:test";

// Single-flight and degradation for the source-file scan cache, against a REAL
// Redis. The interesting behaviour here is all about a connection that may or
// may not answer, which a mock would simply assert into existence.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const KEY_PREFIX = `sourcefiles:test:${process.pid}`;

async function redisReachable() {
  const { Redis } = await import("ioredis");
  const url = new URL(process.env.REDIS_URL!);
  const probe = new Redis({
    host: url.hostname,
    port: Number.parseInt(url.port || "6379", 10),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    lazyConnect: true
  });

  probe.on("error", () => undefined);

  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.quit().catch(() => undefined);
  }
}

test("scan result cache: hit, single-flight, and degradation", async (t) => {
  if (!(await redisReachable())) {
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const {
    cachedWithSingleFlight,
    closeScanResultCache,
    computeCountForTests,
    resetComputeCountForTests,
    setSingleFlightTimingForTests,
    resetSingleFlightTimingForTests,
    writeHeartbeat
  } = await import("./scanResultCache.js");

  const { closeRedisLockClient } = await import("../queue/redisLock.js");

  t.after(async () => {
    resetSingleFlightTimingForTests();
    closeScanResultCache();
    // The expired-lock case below squats the key using redisLock's OWN
    // connection, which is separate from the cache's. Both have to go or the
    // test process never exits.
    await closeRedisLockClient();
  });

  // A payload shaped like the real one: the v1.80 drop counters must survive a
  // round trip, or a cached empty list loses the explanation v1.80 added.
  const payload = {
    files: [{ source_file: "current-a.xml", occurrences: 7 }],
    skipped: { remote: 1, no_file_row: 0, unreadable: 2, no_matches: 3 }
  };

  await t.test("computes on miss, then serves from cache", async () => {
    resetComputeCountForTests();

    const key = `${KEY_PREFIX}:hit`;
    const first = await cachedWithSingleFlight(key, async () => payload);

    assert.equal(first.cached, false);
    assert.deepEqual(first.value, payload);

    const second = await cachedWithSingleFlight(key, async () => {
      throw new Error("must not recompute a cached answer");
    });

    assert.equal(second.cached, true);
    // Counters included — this is the assertion that stops a cache hit from
    // silently dropping scope_skipped.
    assert.deepEqual(second.value, payload);
    assert.equal(computeCountForTests(), 1);
  });

  await t.test("ten concurrent callers cost ONE computation", async () => {
    resetComputeCountForTests();

    const key = `${KEY_PREFIX}:singleflight`;
    let running = 0;
    let maxConcurrent = 0;

    const compute = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      // Long enough that the losers must genuinely wait for this one rather
      // than racing past an empty cache.
      await new Promise((resolve) => setTimeout(resolve, 400));
      running -= 1;

      return payload;
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => cachedWithSingleFlight(key, compute))
    );

    assert.equal(computeCountForTests(), 1, "the scan must run exactly once");
    assert.equal(maxConcurrent, 1);
    // EVERY loser must get the winner's answer, counters and all — a loser that
    // returned an empty list would be a silent wrong answer, not a slow one.
    for (const result of results) {
      assert.deepEqual(result.value, payload);
    }
    assert.equal(results.filter((r) => !r.cached).length, 1);
    assert.equal(results.filter((r) => r.cached).length, 9);
  });

  await t.test("an expired lock costs duplicate CPU, never a wrong answer", async () => {
    // The pathological case the 600s TTL exists to avoid, forced rather than
    // assumed: hold the key with a 1s TTL so it lapses mid-flight.
    resetComputeCountForTests();

    const { tryAcquireRedisLock } = await import("../queue/redisLock.js");
    const key = `${KEY_PREFIX}:expiry`;
    const squatter = await tryAcquireRedisLock(key, 1);

    assert.ok(squatter, "test needs to hold the lock first");

    const result = await cachedWithSingleFlight(key, async () => payload);

    assert.deepEqual(result.value, payload);
    await squatter.release();
  });

  await t.test(
    "a loser outwaits the OLD budget while heartbeats keep arriving, and the scan runs once",
    async () => {
      // Proves the amplification bug this module exists to fix (see
      // scanResultCache.ts's own history): shrink loserWaitBudgetMs far below
      // a real compute() duration, so the OLD code (no heartbeat) would have
      // given up and recomputed partway through — and assert it does not.
      resetComputeCountForTests();
      setSingleFlightTimingForTests({ loserWaitBudgetMs: 1_500 });

      const key = `${KEY_PREFIX}:heartbeat-alive`;
      const compute = async (report: (current: number, total: number) => void) => {
        // Long enough to cross several heartbeat-write cycles AND several
        // multiples of the shrunk 1.5s loser budget — if the heartbeat check
        // were not in the loser loop, it would have taken over and
        // recomputed well before this returns.
        for (let step = 1; step <= 4; step += 1) {
          report(step, 4);
          await new Promise((resolve) => setTimeout(resolve, 900));
        }

        return payload;
      };

      const progressSeenByLoser: Array<{ current: number; total: number }> = [];

      const [winner, loser] = await Promise.all([
        cachedWithSingleFlight(key, compute),
        // Started a tick later so it reliably loses the lock race, same as
        // the "ten concurrent callers" case above.
        new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
          cachedWithSingleFlight(key, compute, (current, total) => {
            progressSeenByLoser.push({ current, total });
          })
        )
      ]);

      assert.equal(
        computeCountForTests(),
        1,
        "a healthy, heartbeating winner must not be recomputed by its loser"
      );
      assert.deepEqual(winner.value, payload);
      assert.deepEqual(loser.value, payload);
      assert.ok(
        progressSeenByLoser.length > 0,
        "the loser must have relayed at least one heartbeat sighting"
      );
    }
  );

  await t.test(
    "a winner that stops heartbeating is recovered from well under the old budget",
    async () => {
      // Simulates a winner that reported once, then crashed: write ONE
      // heartbeat directly (no real compute() running), squat the real lock
      // with a short TTL, and shrink the heartbeat TTL so staleness is
      // detectable quickly. The loser must wait while the heartbeat still
      // looks fresh, then recover once it goes stale — all in a few seconds,
      // not the old budget's 170s.
      resetComputeCountForTests();
      setSingleFlightTimingForTests({ heartbeatTtlSeconds: 1 });

      const { tryAcquireRedisLock } = await import("../queue/redisLock.js");
      const key = `${KEY_PREFIX}:heartbeat-stale`;
      const squatter = await tryAcquireRedisLock(key, 2);

      assert.ok(squatter, "test needs to hold the lock first");
      await writeHeartbeat(key, { current: 1, total: 10 });

      const started = Date.now();
      const result = await cachedWithSingleFlight(key, async () => payload);
      const elapsedMs = Date.now() - started;

      assert.deepEqual(result.value, payload);
      assert.equal(computeCountForTests(), 1);
      assert.ok(
        elapsedMs < 10_000,
        `recovery took ${elapsedMs}ms — expected well under the old 170s budget`
      );

      await squatter.release().catch(() => undefined);
    }
  );
});
