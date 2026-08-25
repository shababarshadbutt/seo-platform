import assert from "node:assert/strict";
import { test } from "node:test";

// Redis unreachable: the cache must COMPUTE, promptly, not hang and not fail.
//
// ITS OWN FILE ON PURPOSE. scanResultCache holds a module-level connection built
// from REDIS_URL on first use, so the pointing-at-nothing case needs a fresh
// module registry and its own env — setting REDIS_URL partway through another
// file's tests would either be ignored (client already built) or corrupt the
// tests that ran before it.
process.env.REDIS_URL = "redis://127.0.0.1:1";

test("with Redis unreachable it computes instead of hanging", async (t) => {
  // THE REGRESSION THIS GUARDS. The obvious implementation shares redisLock's
  // BullMQ connection, which sets maxRetriesPerRequest: null — so a GET issued
  // while Redis is down is retried forever and NEVER settles: the modal hangs
  // instead of falling back to scanning. A try/catch cannot rescue a promise
  // that never resolves, which is why this cache keeps a fail-fast connection.
  //
  // It also guards the second half of that bug: a lock acquisition that REJECTS
  // (Redis gone) must not be mistaken for one that RETURNS NULL (someone else
  // holds it), or every request would sit out the full 170s loser budget waiting
  // for a winner that cannot exist.
  const { cachedWithSingleFlight, closeScanResultCache } = await import(
    "./scanResultCache.js"
  );

  t.after(async () => {
    closeScanResultCache();
  });

  const payload = {
    files: [],
    skipped: { remote: 0, no_file_row: 0, unreadable: 0, no_matches: 0 }
  };

  const started = Date.now();
  const result = await cachedWithSingleFlight(
    "sourcefiles:test:down",
    async () => payload
  );
  const elapsed = Date.now() - started;

  assert.equal(result.cached, false);
  assert.deepEqual(result.value, payload);
  // Generous, but far below the 170s loser budget: the point is that it degrades
  // promptly rather than waiting, or worse, never returning at all.
  assert.ok(
    elapsed < 15_000,
    `degraded in ${elapsed}ms, expected well under 15s`
  );
});
