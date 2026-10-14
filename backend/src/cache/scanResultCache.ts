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

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) && value > 0 ? value : fallback;
}

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

// --- Heartbeat: lets a LOSER tell "winner still alive and working" from "winner
// is gone", without touching redisLock.ts (shared with the publish lock and the
// host-strategy negotiation — see SCAN_LOCK_TTL_SECONDS's own comment below for
// why that primitive is deliberately left alone). A heartbeat lives under its
// OWN key, `${key}:progress`, never under `key` itself — `key` is ALSO the
// result-cache key (writeCached writes it) and the lock token (tryAcquireRedisLock
// writes it), so a heartbeat sharing it would stomp whichever of those two
// happens to land on top.
//
// Doubles as the DATA for the SSE progress route (routes/sessions.ts): the same
// write that tells a loser "still alive" is also what a progress stream reads to
// show "Scanning N of M files" to the user.
function heartbeatKey(key: string): string {
  return `${key}:progress`;
}

type ScanProgress = { current: number; total: number };

// Defaults are read once from env, exactly like every other tunable threshold in
// this codebase (SOURCE_FILE_SCAN_FILE_COUNT_THRESHOLD, etc.) — but these three
// ALSO need a second, in-process override path: an integration test that wants
// to prove "a loser waits past the old budget while heartbeats keep arriving"
// cannot wait out a value sized in minutes, and an env var is only read once at
// import time, before a test gets a chance to shrink it. Hence the mutable `let`
// below plus setSingleFlightTimingForTests, mirroring the existing
// resetComputeCountForTests seam this module already has.
const HEARTBEAT_TTL_SECONDS_DEFAULT = readPositiveInt(
  "SOURCE_FILE_SCAN_HEARTBEAT_TTL_SECONDS",
  10
);
// Throttle for WRITES, not for the in-process onProgress relay (which forwards
// every call immediately — see makeReporter). Time-based, not every-N-files:
// file size varies by orders of magnitude (a few hundred locs vs the 40,000+
// seen in production), so a fixed file-count interval either spams Redis on a
// run of small files or goes dark for minutes on a run of huge ones. Matches
// PUBLISH_SSE_POLL_MS (routes/pullProgress.ts) so an SSE watcher is never more
// than one write-cycle behind.
const PROGRESS_WRITE_MIN_INTERVAL_MS = 1_000;

// Exported for tests only, so a test can simulate "a winner reported once,
// then crashed" without driving a real compute() — readScanProgress is
// already exported for the SSE route to poll the same signal.
export async function writeHeartbeat(
  key: string,
  progress: ScanProgress
): Promise<void> {
  try {
    const connection = await cacheReady();

    await connection?.set(
      heartbeatKey(key),
      JSON.stringify(progress),
      "EX",
      heartbeatTtlSeconds
    );
  } catch {
    // A heartbeat write that fails just means a loser waits as if no signal
    // exists yet — degrades to pre-heartbeat behaviour, never blocks the scan.
  }
}

// Exported so routes/sessions.ts's SSE progress route can poll the SAME signal
// independent of whether it is itself the winner or a loser here.
export async function readScanProgress(key: string): Promise<ScanProgress | null> {
  try {
    const connection = await cacheReady();
    const raw = connection ? await connection.get(heartbeatKey(key)) : null;

    return raw ? (JSON.parse(raw) as ScanProgress) : null;
  } catch {
    return null;
  }
}

// Builds the `report` callback handed into `compute`: forwards synchronously to
// the caller's own onProgress (so the WINNER's caller gets live numbers with no
// Redis round-trip) and throttle-writes the heartbeat (so a DIFFERENT watcher —
// another tab, the loser loop below, an SSE stream — can see it too).
function makeReporter(
  key: string,
  onProgress?: (current: number, total: number) => void
): (current: number, total: number) => void {
  let lastWrite = 0;

  return (current: number, total: number) => {
    onProgress?.(current, total);

    const now = Date.now();

    if (now - lastWrite >= PROGRESS_WRITE_MIN_INTERVAL_MS) {
      lastWrite = now;
      void writeHeartbeat(key, { current, total });
    }
  };
}

// Comfortably above the worst realistic scan, because redisLock has NO renewal —
// tryAcquireRedisLock is a single SET NX EX, so a scan outliving its lock lets a
// second caller start one too. Kept in step with LOSER_ABSOLUTE_CEILING_MS below
// (converted to seconds): a heartbeat-healthy winner should not lose its LOCK
// before a loser would ever stop waiting on its HEARTBEAT, or the two mechanisms
// fight each other for no benefit.
//
// Sized from measurement, not habit — bench/sourceFileScanRate.ts's filtered,
// large-file scenario (300 files x 20,000 locs/file, a REAL structure filter
// active) measured 267k locs/s pooled, which extrapolates to ~400s (~6.7 min)
// at the production shape this was reported against (~2,700 files x ~40,000
// locs/file). 20 min leaves roughly 3x headroom over that, the same margin
// the original 600s TTL left over its own ~100s estimate.
//
// A heartbeat renewal loop was considered for THIS value too and rejected for the
// same reason as before: it would mean changing redisLock.ts, a primitive shared
// with publishLock and the host-strategy negotiation. The heartbeat above already
// stops the costly failure mode (a healthy winner's work being duplicated); this
// TTL is now just a crash backstop, so leaving it un-renewed is no longer the
// load-bearing piece of the design it once was.
const SCAN_LOCK_TTL_SECONDS_DEFAULT = readPositiveInt(
  "SOURCE_FILE_SCAN_LOCK_TTL_SECONDS",
  20 * 60
);

// How long a loser waits WITHOUT SIGHTING A HEARTBEAT before trying to take over
// the lock. Not "how long a loser waits, period" any more — see
// LOSER_ABSOLUTE_CEILING_MS. 170s sits just under the client's 180s timeout
// (EXPORT_API_TIMEOUT_MS) for the SAME reason it always did: a loser that has
// NEVER seen the winner prove it's alive still hands the caller a prompt answer
// (take over, or the final unconditional recompute) rather than an ambiguous
// hang.
const LOSER_WAIT_BUDGET_MS_DEFAULT = readPositiveInt(
  "SOURCE_FILE_SCAN_LOSER_WAIT_BUDGET_MS",
  170_000
);

// The REAL ceiling on how long a loser waits, now that a fresh heartbeat resets
// the budget above instead of ending the wait. Bounds the case a heartbeat alone
// cannot distinguish from a genuine success: a winner that is alive, reporting
// progress, and simply never finishing (a stuck-but-not-crashed bug). Without
// this, that bug would make every loser wait forever instead of degrading to the
// accepted "duplicated read-only CPU" fallback.
//
// Same measured basis as SCAN_LOCK_TTL_SECONDS_DEFAULT above (~6.7 min
// extrapolated worst case, ~3x headroom at 20 min) — kept in step with it
// deliberately, so the two mechanisms expire around the same time rather than
// one outliving the other for no benefit.
const LOSER_ABSOLUTE_CEILING_MS_DEFAULT = readPositiveInt(
  "SOURCE_FILE_SCAN_LOSER_ABSOLUTE_CEILING_MS",
  20 * 60 * 1000
);

const LOSER_POLL_MIN_MS = 250;
const LOSER_POLL_MAX_MS = 2_000;

let scanLockTtlSeconds = SCAN_LOCK_TTL_SECONDS_DEFAULT;
let heartbeatTtlSeconds = HEARTBEAT_TTL_SECONDS_DEFAULT;
let loserWaitBudgetMs = LOSER_WAIT_BUDGET_MS_DEFAULT;
let loserAbsoluteCeilingMs = LOSER_ABSOLUTE_CEILING_MS_DEFAULT;

// Test-only: shrink the heartbeat/wait timings so a test can prove "a loser
// outwaits the OLD budget while heartbeats keep arriving" in seconds rather than
// minutes. Mirrors resetComputeCountForTests below. Omitted fields are left as
// they are, so a test can override just the one constant its scenario needs.
export function setSingleFlightTimingForTests(overrides: {
  heartbeatTtlSeconds?: number;
  loserWaitBudgetMs?: number;
  loserAbsoluteCeilingMs?: number;
}): void {
  if (overrides.heartbeatTtlSeconds !== undefined) {
    heartbeatTtlSeconds = overrides.heartbeatTtlSeconds;
  }

  if (overrides.loserWaitBudgetMs !== undefined) {
    loserWaitBudgetMs = overrides.loserWaitBudgetMs;
  }

  if (overrides.loserAbsoluteCeilingMs !== undefined) {
    loserAbsoluteCeilingMs = overrides.loserAbsoluteCeilingMs;
  }
}

export function resetSingleFlightTimingForTests(): void {
  scanLockTtlSeconds = SCAN_LOCK_TTL_SECONDS_DEFAULT;
  heartbeatTtlSeconds = HEARTBEAT_TTL_SECONDS_DEFAULT;
  loserWaitBudgetMs = LOSER_WAIT_BUDGET_MS_DEFAULT;
  loserAbsoluteCeilingMs = LOSER_ABSOLUTE_CEILING_MS_DEFAULT;
}

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
      ? await tryAcquireRedisLock(key, scanLockTtlSeconds, connection)
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
//
// `compute` takes a `report(current, total)` callback so the caller can surface
// progress as it goes — forwarded live to `onProgress` for whichever caller
// ACTUALLY ends up running compute() (the winner, or a loser that takes over or
// falls through to the final recompute), and also written to the heartbeat key
// so any caller that is WAITING (a loser mid-loop, an SSE watcher) can see it
// too, which is what lets the loser loop below tell "still alive" from "gone".
export async function cachedWithSingleFlight<T>(
  key: string,
  compute: (report: (current: number, total: number) => void) => Promise<T>,
  onProgress?: (current: number, total: number) => void
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
      lock = await tryAcquireRedisLock(key, scanLockTtlSeconds, connection);
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

    return { value: await compute(makeReporter(key, onProgress)), cached: false };
  }

  if (lock) {
    try {
      computeCount += 1;

      const value = await compute(makeReporter(key, onProgress));

      await writeCached(key, value);

      return { value, cached: false };
    } finally {
      await lock.release();
    }
  }

  // Someone else is already computing this exact answer. Wait for it rather than
  // duplicating ~100s of disk reads.
  //
  // Each pass asks THREE questions, not two: has the winner published; is a
  // heartbeat still ticking; and only if neither, is the lock still held. A
  // ticking heartbeat means the winner is alive and working, so this pass
  // relays its progress and resets the "have I seen ANY sign of life lately"
  // window (loserWaitBudgetMs) rather than racing it to takeOverLock — taking
  // over next to a healthy winner is exactly the duplicate-scan bug this
  // mechanism exists to stop. Only once NO heartbeat has been sighted for a
  // full loserWaitBudgetMs does this fall back to the pre-heartbeat behaviour:
  // try to take over, or (once loserAbsoluteCeilingMs is reached) recompute
  // unconditionally. The absolute ceiling is what still bounds a winner that is
  // alive, heartbeating, and genuinely stuck rather than merely slow.
  const absoluteDeadline = Date.now() + loserAbsoluteCeilingMs;
  let innerDeadline = Date.now() + loserWaitBudgetMs;
  let delay = LOSER_POLL_MIN_MS;

  while (Date.now() < absoluteDeadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));

    const winner = await readCached<T>(key);

    if (winner) {
      return { value: winner, cached: true };
    }

    const progress = await readScanProgress(key);

    if (progress) {
      onProgress?.(progress.current, progress.total);
      innerDeadline = Date.now() + loserWaitBudgetMs;
      delay = LOSER_POLL_MIN_MS;
      continue;
    }

    const takenOver = await takeOverLock(key);

    if (takenOver) {
      try {
        computeCount += 1;

        const value = await compute(makeReporter(key, onProgress));

        await writeCached(key, value);

        return { value, cached: false };
      } finally {
        await takenOver.release();
      }
    }

    if (Date.now() >= innerDeadline) {
      break;
    }

    delay = Math.min(delay * 2, LOSER_POLL_MAX_MS);
  }

  // Either no heartbeat was ever sighted and the inner wait ran out, or
  // heartbeats kept arriving but the scan never actually finished within the
  // absolute ceiling (alive-but-stuck, not crashed). Recompute without a lock
  // either way: a duplicated scan is the pre-v1.83 cost, and a wrong answer is
  // not on the table.
  computeCount += 1;

  const value = await compute(makeReporter(key, onProgress));

  await writeCached(key, value);

  return { value, cached: false };
}
