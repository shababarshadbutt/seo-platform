import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOST_STRATEGY_TTL_SECONDS,
  ladderForRung,
  noteHostCheckOutcome,
  REFUSAL_STREAK_BEFORE_RENEGOTIATION,
  resetHostStrategyMemory,
  resolveHostStrategy,
  sessionPinsItsOwnProfile,
  type HostStrategyStore,
  type RungProbe,
  type StoredHostStrategy
} from "./hostStrategy.js";
import { config, DEFAULT_HTTP_USER_AGENT } from "../config.js";
import type { SampleCheckResult } from "../jobs/sampleUrlCheck.js";

// The engine's ladder, circuit breaker, memory and race guard — with an in-memory
// store and a fake probe, so no Redis, no Postgres and no sockets are involved.
// Exactly the discipline patternScore.ts and sampleHttpStatus.ts follow: the
// decisions are pure, so they get real coverage.

const silentLogger: any = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  }
};

const HOST = "www.example.com";
const PROBE_URL = "https://www.example.com/product/deep/thing";
const TEST_SESSION = "11111111-2222-3333-4444-555555555555";

// The diagnostic sink is INJECTED, which is what keeps this file honest about the
// module's stated discipline: no Redis, no Postgres, no sockets — and no filesystem
// either. Tests assert on an array instead of reading temp files.
let emitted: Array<{ event: string; fields: Record<string, unknown> }> = [];

function diag() {
  return {
    sessionId: TEST_SESSION,
    emit: (event: string, fields: Record<string, unknown>) => {
      emitted.push({ event, fields });
    }
  };
}

function resetEmitted() {
  emitted = [];
}

function eventsNamed(name: string) {
  return emitted.filter((entry) => entry.event === name);
}

function outcome(
  overrides: Partial<SampleCheckResult> & Pick<SampleCheckResult, "httpStatusCategory">
): SampleCheckResult {
  return {
    url: PROBE_URL,
    httpStatus: 200,
    responseMs: 5,
    isHit: true,
    isSoft404: false,
    finalUrl: null,
    redirectCount: 0,
    scoreWeight: 1,
    timedOut: false,
    errorReason: null,
    usedFallbackProfile: false,
    edgeServer: null,
    viaPrivateRoute: false,
    ...overrides
  };
}

const clean = () => outcome({ httpStatusCategory: "success" });
const redirect = () =>
  outcome({ httpStatusCategory: "redirect", httpStatus: 301, redirectCount: 1 });
const softNotFound = () =>
  outcome({ httpStatusCategory: "soft_404", scoreWeight: 0.25 });
const blocked = (edgeServer: string | null = "awselb/2.0") =>
  outcome({
    httpStatusCategory: "blocked",
    httpStatus: 405,
    isHit: false,
    scoreWeight: 0,
    edgeServer
  });
const notFound = () =>
  outcome({
    httpStatusCategory: "failure",
    httpStatus: 404,
    isHit: false,
    scoreWeight: 0
  });
const forbidden = () =>
  outcome({
    httpStatusCategory: "failure",
    httpStatus: 403,
    isHit: false,
    scoreWeight: 0,
    edgeServer: "awselb/2.0"
  });
const transportFailure = () =>
  outcome({
    httpStatusCategory: "failure",
    httpStatus: null,
    isHit: false,
    scoreWeight: 0,
    timedOut: true,
    errorReason: "timeout"
  });

function memoryStore(seed?: StoredHostStrategy) {
  const rows = new Map<string, StoredHostStrategy>();
  const held = new Set<string>();
  const calls = { reads: 0, writes: 0, locks: 0 };

  if (seed) {
    rows.set(seed.host, seed);
  }

  const store: HostStrategyStore = {
    async read(host) {
      calls.reads += 1;

      const row = rows.get(host);

      // `table` stands in for the durable tier. The real store reports `redis` on a
      // cache hit; hostStrategyStore.integration.test.ts owns that distinction against
      // an actual Redis.
      return row ? { value: row, source: "table" as const } : null;
    },
    async write(value) {
      calls.writes += 1;
      rows.set(value.host, value);
    },
    async lock(host) {
      calls.locks += 1;

      if (held.has(host)) {
        return null;
      }

      held.add(host);

      return {
        release: async () => {
          held.delete(host);
        }
      };
    }
  };

  return { store, rows, held, calls };
}

// A probe that returns a scripted result per rung, counting attempts.
function scriptedProbe(script: Array<() => SampleCheckResult>) {
  const attempts: string[] = [];
  const probe: RungProbe = async (_url, profile) => {
    const label = profile.allowH2
      ? "R2"
      : profile.userAgent.includes("Chrome/")
        ? "R1"
        : "R0";

    attempts.push(label);

    const next = script[Math.min(attempts.length - 1, script.length - 1)];

    return next();
  };

  return { probe, attempts };
}

// --- the ladder --------------------------------------------------------------

test("R0 wins: one probe, and the honest UA is what gets learned", async () => {
  resetHostStrategyMemory();

  const { store, rows } = memoryStore();
  const { probe, attempts } = scriptedProbe([clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0"]);
  assert.equal(resolved.verdict, "OK");
  assert.equal(resolved.rung, "R0");
  assert.equal(resolved.skip, false);
  assert.equal(rows.get(HOST)?.rung, "R0");
  // R0 learned still carries R1 as the per-URL safety net.
  assert.equal(resolved.ladder.length, 2);
  assert.equal(resolved.ladder[0].userAgent, DEFAULT_HTTP_USER_AGENT);
});

test("R0 refused, R1 wins: two probes, and R1 becomes the primary", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const { probe, attempts } = scriptedProbe([blocked, clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0", "R1"]);
  assert.equal(resolved.rung, "R1");
  assert.match(resolved.ladder[0].userAgent, /Chrome\//);
  // R1 learned -> R2 is the safety net above it.
  assert.equal(resolved.ladder.length, 2);
  assert.equal(resolved.ladder[1].allowH2, true);
});

test("only R2 answers: the ladder is a SINGLE rung, so no per-URL escalation", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const { probe, attempts } = scriptedProbe([blocked, blocked, clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0", "R1", "R2"]);
  assert.equal(resolved.rung, "R2");
  // Top rung: nothing above it, so a URL that still refuses costs one request, not
  // two. Asserted because a stray second entry here would silently double the cost
  // of every check on such a host.
  assert.equal(resolved.ladder.length, 1);
});

test("a REDIRECT wins a rung — do not climb past a usable answer", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const { probe, attempts } = scriptedProbe([redirect]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  // A host whose pages redirect is perfectly measurable. Climbing to a browser
  // profile because a page 301s would spend requests to learn nothing.
  assert.deepEqual(attempts, ["R0"]);
  assert.equal(resolved.rung, "R0");
});

test("a SOFT-404 wins a rung — it is an unhealthy measurement, still a measurement", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const { probe, attempts } = scriptedProbe([softNotFound]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0"]);
  assert.equal(resolved.verdict, "OK");
});

test("A 404 PROBE URL WINS R0 — one dead URL must not condemn a whole host", async () => {
  resetHostStrategyMemory();

  // THE BUG THIS GUARDS. The checker's isRealMeasurement calls a 404 "not a
  // measurement", which is right for the per-URL escalation (a bot filter can answer
  // 404, so try harder before declaring a page broken) and catastrophic here: the probe
  // URL is one random entry from a sitemap, and sitemaps are FULL of genuinely dead
  // URLs — finding them is the product. Judging rungs by page health would fail all
  // three on an unlucky pick and skip an entire site that answers fine.
  const { store, rows } = memoryStore();
  const { probe, attempts } = scriptedProbe([notFound]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0"]);
  assert.equal(resolved.verdict, "OK");
  assert.equal(resolved.skip, false);
  assert.equal(rows.get(HOST)?.lastStatus, 404);
  // And the per-URL safety net is still there, so that 404 is still escalated once
  // per URL exactly as v1.60 does.
  assert.equal(resolved.ladder.length, 2);
});

test("500, 401, 429 and 503 also count as the origin ANSWERING", async () => {
  for (const httpStatus of [500, 401, 429, 503]) {
    resetHostStrategyMemory();

    const { store } = memoryStore();
    const { probe, attempts } = scriptedProbe([
      () =>
        outcome({
          httpStatusCategory: "failure",
          httpStatus,
          isHit: false,
          scoreWeight: 0
        })
    ]);
    const resolved = await resolveHostStrategy(
      HOST,
      PROBE_URL,
      DEFAULT_HTTP_USER_AGENT,
      { store, probe, logger: silentLogger,
      ...diag() }
    );

    // A host having a bad day, or a page needing auth, is not a host refusing our
    // client. Skipping it would report "needs an allowlist" about a site that is
    // simply broken — and stop measuring the very breakage we exist to report.
    assert.equal(resolved.verdict, "OK", `status ${httpStatus}`);
    assert.deepEqual(attempts, ["R0"], `status ${httpStatus}`);
  }
});

test("a bare 403 on every rung IS a refusal — the measured awselb signature", async () => {
  resetHostStrategyMemory();

  const { store, rows } = memoryStore();
  const { probe, attempts } = scriptedProbe([forbidden]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  // 403 is the one status that means "ask again differently" rather than "here is
  // your answer" — the same reason the per-URL escalation treats it as eligible.
  assert.deepEqual(attempts, ["R0", "R1", "R2"]);
  assert.equal(resolved.verdict, "REFUSED");
  assert.equal(rows.get(HOST)?.lastStatus, 403);
});

test("a 403 that the browser profile turns into a 404 still learns R1", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const { probe, attempts } = scriptedProbe([forbidden, notFound]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  // The origin started talking to us on R1 — that is what the rung is for. Whether
  // this particular URL is alive is the per-URL checker's business, not the host's.
  assert.deepEqual(attempts, ["R0", "R1"]);
  assert.equal(resolved.verdict, "OK");
  assert.equal(resolved.rung, "R1");
});

// --- the circuit breaker -----------------------------------------------------

test("every rung refused -> REFUSED, skip = true, empty ladder, edge server recorded", async () => {
  resetHostStrategyMemory();

  const { store, rows } = memoryStore();
  const { probe, attempts } = scriptedProbe([blocked, blocked, blocked]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0", "R1", "R2"]);
  assert.equal(resolved.verdict, "REFUSED");
  assert.equal(resolved.skip, true);
  assert.deepEqual(resolved.ladder, []);
  // The one fact that turns this into an actionable devops request rather than a
  // mystery: WHICH edge refused us.
  assert.equal(resolved.edgeServer, "awselb/2.0");
  assert.equal(rows.get(HOST)?.verdict, "REFUSED");
  assert.equal(rows.get(HOST)?.rung, null);
  assert.equal(rows.get(HOST)?.lastStatus, 405);
});

test("a REFUSED host resolves from the store with ZERO probes on the next run", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore({
    host: HOST,
    verdict: "REFUSED",
    rung: null,
    edgeServer: "awselb/2.0",
    lastStatus: 403,
    decidedAt: new Date().toISOString()
  });
  const { probe, attempts } = scriptedProbe([clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  // THE COST ASSERTION. This is the difference between a blocked site's session
  // finishing in seconds and it spending days re-learning the same refusal.
  assert.deepEqual(attempts, []);
  assert.equal(resolved.skip, true);
});

// --- inconclusive is NOT refused --------------------------------------------

test("all rungs time out -> UNKNOWN, nothing persisted, default ladder, still checked", async () => {
  resetHostStrategyMemory();

  const { store, rows, calls } = memoryStore();
  const { probe, attempts } = scriptedProbe([transportFailure]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  // An unreachable host is a normal failure the per-URL checker must report
  // honestly — NOT a refusal to skip and definitely not "needs an allowlist".
  assert.equal(resolved.verdict, "UNKNOWN");
  assert.equal(resolved.skip, false);
  assert.equal(resolved.ladder.length, 2);
  assert.equal(rows.size, 0);
  assert.equal(calls.writes, 0);
  // Each rung is retried once on a transport failure (nothing answered, so the rung
  // was never really tested): 3 rungs x 2 attempts.
  assert.equal(attempts.length, 6, attempts.join(","));
});

test("a rung that times out once then answers still wins that rung", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const { probe, attempts } = scriptedProbe([transportFailure, clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, ["R0", "R0"]);
  assert.equal(resolved.rung, "R0");
});

// --- memory ------------------------------------------------------------------

test("a stored fresh strategy is reused without probing", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore({
    host: HOST,
    verdict: "OK",
    rung: "R1",
    edgeServer: "nginx/1.28.3",
    lastStatus: 200,
    decidedAt: new Date().toISOString()
  });
  const { probe, attempts } = scriptedProbe([clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, []);
  assert.equal(resolved.rung, "R1");
});

test("a strategy older than the TTL is re-negotiated", async () => {
  resetHostStrategyMemory();

  const nowMs = Date.UTC(2026, 7, 11, 12, 0, 0);
  const { store } = memoryStore({
    host: HOST,
    verdict: "OK",
    rung: "R1",
    edgeServer: null,
    lastStatus: 200,
    decidedAt: new Date(nowMs - (HOST_STRATEGY_TTL_SECONDS * 1000 + 1000)).toISOString()
  });
  const { probe, attempts } = scriptedProbe([clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag(),
    now: () => nowMs
  });

  // An allowlist landing on the target's side is picked up without anyone
  // remembering to clear a cache.
  assert.deepEqual(attempts, ["R0"]);
  assert.equal(resolved.rung, "R0");
});

test("re-negotiation fires after a STREAK of refusals, not after one", async () => {
  resetHostStrategyMemory();

  const stored: StoredHostStrategy = {
    host: HOST,
    verdict: "OK",
    rung: "R0",
    edgeServer: null,
    lastStatus: 200,
    decidedAt: new Date().toISOString()
  };
  const { store } = memoryStore(stored);
  const first = scriptedProbe([clean]);

  noteHostCheckOutcome(HOST, false);
  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe: first.probe,
    logger: silentLogger,
      ...diag()
  });

  // ONE refusal is ordinary — a 404 in a sitemap is a finding, not evidence the
  // recipe broke. Re-negotiating here would reintroduce the per-URL cost.
  assert.deepEqual(first.attempts, []);

  for (let i = 0; i < REFUSAL_STREAK_BEFORE_RENEGOTIATION; i += 1) {
    noteHostCheckOutcome(HOST, false);
  }

  const second = scriptedProbe([blocked, clean]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe: second.probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(second.attempts, ["R0", "R1"]);
});

test("a clean result clears the streak", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore({
    host: HOST,
    verdict: "OK",
    rung: "R0",
    edgeServer: null,
    lastStatus: 200,
    decidedAt: new Date().toISOString()
  });

  noteHostCheckOutcome(HOST, false);
  noteHostCheckOutcome(HOST, false);
  noteHostCheckOutcome(HOST, true);
  noteHostCheckOutcome(HOST, false);

  const { probe, attempts } = scriptedProbe([clean]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  assert.deepEqual(attempts, []);
});

// --- the race guard ----------------------------------------------------------

test("a loser of the negotiation race WAITS for the winner instead of probing", async () => {
  resetHostStrategyMemory();

  const { store, rows, held } = memoryStore();

  // Simulate the winner holding the lock, then publishing its answer.
  held.add(HOST);

  const { probe, attempts } = scriptedProbe([clean]);
  const pending = resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag(),
    sleep: async () => {
      // On the loser's first poll the winner's answer lands.
      rows.set(HOST, {
        host: HOST,
        verdict: "OK",
        rung: "R2",
        edgeServer: "nginx/1.28.3",
        lastStatus: 200,
        decidedAt: new Date().toISOString()
      });
    }
  });
  const resolved = await pending;

  // THE ASSERTION THAT MATTERS: the loser issued no probes of its own and adopted
  // the winner's recipe. Two processes probing one origin to learn the same thing is
  // precisely the duplicated cost this engine exists to remove.
  assert.deepEqual(attempts, []);
  assert.equal(resolved.rung, "R2");
});

test("a negotiation wait that never resolves falls back to the default ladder", async () => {
  resetHostStrategyMemory();

  const { store, held } = memoryStore();

  held.add(HOST);

  let clockMs = 1_000_000;
  const { probe, attempts } = scriptedProbe([clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
      ...diag(),
    now: () => clockMs,
    sleep: async () => {
      clockMs += 10_000;
    }
  });

  // Bounded: a wait that outlives the negotiation it waits for would stall a whole
  // session on one host. It gives up and runs today's ladder.
  assert.equal(resolved.verdict, "UNKNOWN");
  assert.equal(resolved.ladder.length, 2);
  assert.deepEqual(attempts, []);
});

// --- an explicit user override -----------------------------------------------

test("a session with a custom user_agent is never negotiated for", async () => {
  resetHostStrategyMemory();

  const { store, calls } = memoryStore();
  const { probe, attempts } = scriptedProbe([clean]);
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, "AcmeCrawler/9.9", {
    store,
    probe,
    logger: silentLogger,
      ...diag()
  });

  // A non-default UA is a deliberate instruction. The engine must not learn, on the
  // operator's behalf, that this host prefers Chrome and then silently send that.
  assert.deepEqual(attempts, []);
  assert.equal(calls.reads, 0);
  assert.equal(resolved.verdict, "UNKNOWN");
  assert.equal(resolved.ladder[0].userAgent, "AcmeCrawler/9.9");
  // The v1.60 per-URL safety net is still there for them.
  assert.equal(resolved.ladder.length, 2);
});

// --- resolve NEVER throws ----------------------------------------------------
//
// THE REGRESSION THESE GUARD. The pre-flight is the first thing samplePatternsJob
// does, and the real store issues a plain pool.query against host_probe_profiles.
// A box missing migration 044 threw there, the job's catch marked the session
// FAILED, and NOT ONE pattern was measured — the whole site came back "Not scored"
// because a performance optimisation could not read its cache. Everything this
// engine does is optional work with a correct fallback (the default ladder), so
// every failure mode has to arrive at that fallback instead of at the caller.

test("a store whose read throws yields UNKNOWN and the default ladder, not an error", async () => {
  resetHostStrategyMemory();

  const { probe, attempts } = scriptedProbe([clean]);
  const brokenStore: HostStrategyStore = {
    async read() {
      throw new Error('relation "host_probe_profiles" does not exist');
    },
    async write() {},
    async lock() {
      return { release: async () => {} };
    }
  };

  const resolved = await resolveHostStrategy(
    HOST,
    PROBE_URL,
    DEFAULT_HTTP_USER_AGENT,
    { store: brokenStore, probe, logger: silentLogger,
      ...diag() }
  );

  assert.equal(resolved.verdict, "UNKNOWN");
  // The critical assertion: skip stays FALSE. A cache we cannot read must never be
  // mistaken for "this host refuses us", which would silently skip a whole site.
  assert.equal(resolved.skip, false);
  assert.equal(resolved.ladder.length, 2);
  assert.equal(resolved.ladder[0].userAgent, DEFAULT_HTTP_USER_AGENT);
  // It failed before it could probe, and did not retry blind either.
  assert.deepEqual(attempts, []);
});

test("a store whose write throws still returns a usable strategy", async () => {
  resetHostStrategyMemory();

  const { probe } = scriptedProbe([clean]);
  const store: HostStrategyStore = {
    async read() {
      return null;
    },
    async write() {
      throw new Error("read-only transaction");
    },
    async lock() {
      return { release: async () => {} };
    }
  };

  const resolved = await resolveHostStrategy(
    HOST,
    PROBE_URL,
    DEFAULT_HTTP_USER_AGENT,
    { store, probe, logger: silentLogger,
      ...diag() }
  );

  // The answer could not be remembered, so it is not claimed as learned — but the
  // run continues on the ladder it would have used anyway.
  assert.equal(resolved.verdict, "UNKNOWN");
  assert.equal(resolved.skip, false);
  assert.equal(resolved.ladder.length, 2);
});

test("a probe that throws does not become the caller's problem", async () => {
  resetHostStrategyMemory();

  const { store } = memoryStore();
  const resolved = await resolveHostStrategy(
    HOST,
    PROBE_URL,
    DEFAULT_HTTP_USER_AGENT,
    {
      store,
      probe: async () => {
        throw new Error("socket hang up");
      },
      logger: silentLogger,
      ...diag()
    }
  );

  assert.equal(resolved.verdict, "UNKNOWN");
  assert.equal(resolved.skip, false);
});

test("a lock that throws does not become the caller's problem", async () => {
  resetHostStrategyMemory();

  const { probe } = scriptedProbe([clean]);
  const store: HostStrategyStore = {
    async read() {
      return null;
    },
    async write() {},
    async lock() {
      throw new Error("Redis connection is closed");
    }
  };

  const resolved = await resolveHostStrategy(
    HOST,
    PROBE_URL,
    DEFAULT_HTTP_USER_AGENT,
    { store, probe, logger: silentLogger,
      ...diag() }
  );

  assert.equal(resolved.verdict, "UNKNOWN");
  assert.equal(resolved.skip, false);
});

// --- what counts as "the session pinned its own profile" ---------------------

test("the session default UA is never treated as an override", () => {
  // The value sessions are actually created with is config.defaultHttpUserAgent,
  // which is `process.env.DEFAULT_HTTP_USER_AGENT ?? the constant`. This predicate
  // used to compare against the CONSTANT, so setting that env var on a box made
  // every session look like a deliberate override and switched the whole engine
  // off — silently, with nothing in the logs. See hostStrategyPinnedUa.test.ts for
  // the env-var case, which needs its own process to set it before config loads.
  assert.equal(sessionPinsItsOwnProfile(config.defaultHttpUserAgent), false);
  assert.equal(sessionPinsItsOwnProfile("AcmeCrawler/9.9"), true);
});

// --- the diagnostic events ---------------------------------------------------
//
// WHAT THESE ARE FOR. A week of "Not scored" screenshots could not answer whether the
// engine had negotiated at all, which rung won, or whether the circuit breaker was even
// consulted — and the container log rolls over in hours. These events are the durable
// answer, so their CONTRACT is worth pinning: one resolve line on every exit path, and
// nothing per-URL.

test("one host_strategy_resolved is emitted, on the NEGOTIATED path", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { store } = memoryStore();
  const { probe } = scriptedProbe([blocked, clean]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
    ...diag()
  });

  const resolved = eventsNamed("host_strategy_resolved");

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].fields.verdict, "OK");
  assert.equal(resolved[0].fields.winning_rung, "R1");
  // Nothing was cached, so this run paid for the answer — and says so.
  assert.equal(resolved[0].fields.source, "negotiated");
  assert.deepEqual(resolved[0].fields.rungs_tried, ["R0", "R1"]);
  assert.equal(resolved[0].fields.user_agent_class, "browser");
});

test("a CACHED resolve says so — source, and an empty rungs_tried", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { store } = memoryStore({
    host: HOST,
    verdict: "REFUSED",
    rung: null,
    edgeServer: "awselb/2.0",
    lastStatus: 403,
    decidedAt: new Date().toISOString()
  });
  const { probe, attempts } = scriptedProbe([clean]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
    ...diag()
  });

  const resolved = eventsNamed("host_strategy_resolved");

  assert.equal(attempts.length, 0, "a cached answer must cost no probes");
  assert.equal(resolved.length, 1);
  // THE DISTINCTION THAT MATTERS. A REFUSED verdict served from a cache is a decision
  // being obeyed, possibly days old — not evidence that the site is refusing us today.
  // source + decided_at + an empty rungs_tried say that together.
  assert.equal(resolved[0].fields.source, "table");
  assert.deepEqual(resolved[0].fields.rungs_tried, []);
  assert.equal(resolved[0].fields.skip, true);
  assert.ok(resolved[0].fields.decided_at, "a cached verdict must carry its age");
});

test("a REFUSED negotiation emits one resolve and one attempt per rung", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { store } = memoryStore();
  const { probe } = scriptedProbe([blocked, blocked, blocked]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
    ...diag()
  });

  // BOUNDED, and asserted as exact counts — the value of these events depends on them
  // staying per-host rather than drifting to per-URL.
  assert.equal(eventsNamed("host_strategy_resolved").length, 1);
  assert.equal(eventsNamed("host_strategy_rung_attempt").length, 3);

  const attempts = eventsNamed("host_strategy_rung_attempt");

  assert.deepEqual(
    attempts.map((entry) => entry.fields.rung),
    ["R0", "R1", "R2"]
  );
  assert.equal(attempts[0].fields.host_answered, false);
  assert.equal(attempts[0].fields.server_header, "awselb/2.0");
  // R0/R1 offer http/1.1 only; R2 is the rung that adds h2 to the ALPN extension.
  assert.equal(attempts[0].fields.alpn_offered, "h1");
  assert.equal(attempts[2].fields.alpn_offered, "h1,h2");
});

test("a 404 probe records host_answered TRUE and is_real_measurement FALSE", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { store } = memoryStore();
  const { probe } = scriptedProbe([notFound]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
    ...diag()
  });

  const attempt = eventsNamed("host_strategy_rung_attempt")[0];

  // BOTH predicates, and they DISAGREE here on purpose. host_answered is what decides
  // the rung; is_real_measurement asks the different question "is this page healthy".
  // Confusing the two is what condemned a reachable host to REFUSED before 949c5a31,
  // so the log records which is which rather than one number that could be either.
  assert.equal(attempt.fields.host_answered, true);
  assert.equal(attempt.fields.is_real_measurement, false);
  assert.equal(eventsNamed("host_strategy_resolved")[0].fields.verdict, "OK");
});

test("a transport retry is its own attempt line, numbered", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { store } = memoryStore();
  const { probe } = scriptedProbe([transportFailure, clean]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store,
    probe,
    logger: silentLogger,
    ...diag()
  });

  const attempts = eventsNamed("host_strategy_rung_attempt");

  // A timeout means the rung was never actually TESTED, so it is retried once. Both
  // tries are recorded — "it timed out then worked" and "it worked first time" are
  // different facts about a host.
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((entry) => entry.fields.attempt),
    [1, 2]
  );
  assert.deepEqual(
    attempts.map((entry) => entry.fields.rung),
    ["R0", "R0"]
  );
});

test("a session that pins its own UA still emits one resolve, labelled", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { store } = memoryStore();
  const { probe } = scriptedProbe([clean]);

  await resolveHostStrategy(HOST, PROBE_URL, "AcmeCrawler/9.9", {
    store,
    probe,
    logger: silentLogger,
    ...diag()
  });

  const resolved = eventsNamed("host_strategy_resolved");

  // The engine turning ITSELF off has to be visible. Silence here is
  // indistinguishable from an engine that ran and learned nothing, which is exactly the
  // ambiguity these events exist to remove.
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].fields.user_agent_class, "session_override");
  assert.equal(resolved[0].fields.source, "none");
  assert.equal(eventsNamed("host_strategy_rung_attempt").length, 0);
});

test("a store that throws still emits exactly one resolve", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { probe } = scriptedProbe([clean]);

  await resolveHostStrategy(HOST, PROBE_URL, DEFAULT_HTTP_USER_AGENT, {
    store: {
      async read() {
        throw new Error('relation "host_probe_profiles" does not exist');
      },
      async write() {},
      async lock() {
        return { release: async () => {} };
      }
    },
    probe,
    logger: silentLogger,
    ...diag()
  });

  // The degraded path is the one a broken box actually takes, so it is the one that most
  // needs a line in the file. UNKNOWN + skip false, i.e. "we know nothing, carry on".
  const resolved = eventsNamed("host_strategy_resolved");

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].fields.verdict, "UNKNOWN");
  assert.equal(resolved[0].fields.skip, false);
});

// --- the streak event, which must NOT be per-URL ------------------------------

test("noteHostCheckOutcome is silent until the threshold, then says once", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { emit } = diag();

  for (let index = 0; index < REFUSAL_STREAK_BEFORE_RENEGOTIATION - 1; index += 1) {
    noteHostCheckOutcome(HOST, false, emit);
  }

  // THE VOLUME RULE. This hook is called once per URL checked — up to 1.3M times in a
  // run. Anything logged unconditionally here would be the disk problem these files
  // exist to help diagnose.
  assert.equal(eventsNamed("host_strategy_refusal_streak").length, 0);

  noteHostCheckOutcome(HOST, false, emit);

  const streak = eventsNamed("host_strategy_refusal_streak");

  assert.equal(streak.length, 1);
  assert.equal(streak[0].fields.action, "renegotiate_next_resolve");
  assert.equal(streak[0].fields.streak, REFUSAL_STREAK_BEFORE_RENEGOTIATION);
});

test("a clean result after a streak reports the recovery once, not per URL", async () => {
  resetHostStrategyMemory();
  resetEmitted();

  const { emit } = diag();

  noteHostCheckOutcome(HOST, false, emit);
  noteHostCheckOutcome(HOST, true, emit);

  assert.equal(eventsNamed("host_strategy_refusal_streak").length, 1);
  assert.equal(
    eventsNamed("host_strategy_refusal_streak")[0].fields.action,
    "recovered"
  );

  // Every subsequent healthy URL is silent: there is no streak left to recover from.
  for (let index = 0; index < 100; index += 1) {
    noteHostCheckOutcome(HOST, true, emit);
  }

  assert.equal(eventsNamed("host_strategy_refusal_streak").length, 1);
});

// --- ladder shape ------------------------------------------------------------

test("ladderForRung never exceeds two entries and always leads with the learned rung", () => {
  for (const rung of ["R0", "R1", "R2"] as const) {
    const ladder = ladderForRung(rung, DEFAULT_HTTP_USER_AGENT);

    assert.ok(ladder.length >= 1 && ladder.length <= 2, `${rung} -> ${ladder.length}`);

    if (rung === "R0") {
      assert.equal(ladder[0].userAgent, DEFAULT_HTTP_USER_AGENT);
    } else {
      assert.match(ladder[0].userAgent, /Chrome\//);
    }
  }
});
