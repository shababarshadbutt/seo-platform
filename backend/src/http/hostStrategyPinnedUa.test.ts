import assert from "node:assert/strict";
import { test } from "node:test";

import type { SampleCheckResult } from "../jobs/sampleUrlCheck.js";

// THE ONE TEST THAT NEEDS ITS OWN PROCESS.
//
// config.ts reads process.env at module load, so DEFAULT_HTTP_USER_AGENT has to be
// set BEFORE the first import of config or hostStrategy — which means this cannot
// live in hostStrategy.test.ts without changing what every other test in that file
// is running against. node:test gives each file its own process, so setting it here
// is contained.
//
// WHAT IT GUARDS. sessionPinsItsOwnProfile compared the session's user_agent against
// the DEFAULT_HTTP_USER_AGENT *constant*, while sessions are created with
// config.defaultHttpUserAgent — `process.env.DEFAULT_HTTP_USER_AGENT ?? that
// constant`. So on any box that set the env var (an ordinary thing to reach for on a
// project that has spent weeks tuning this exact header), EVERY session looked like a
// deliberate profile override, resolveHostStrategy returned UNKNOWN before touching
// the store, and the entire host-strategy engine was inert: no negotiation, no
// verdict recorded, no REFUSED banner, no circuit breaker. Silently, with nothing in
// the logs and every existing test still green — because with the var unset the two
// strings are identical.

const ENV_USER_AGENT = "Mozilla/5.0 (compatible; DevopsApprovedCrawler/2.0)";

process.env.DEFAULT_HTTP_USER_AGENT = ENV_USER_AGENT;

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

function cleanResult(): SampleCheckResult {
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
    edgeServer: "nginx/1.28.3",
    httpStatusCategory: "success"
  };
}

test("an env-provided default user agent does not switch the engine off", async () => {
  const { config } = await import("../config.js");
  const { resolveHostStrategy, sessionPinsItsOwnProfile, resetHostStrategyMemory } =
    await import("./hostStrategy.js");

  // Precondition: the env var really did change the default, so this test is
  // exercising the divergence rather than passing by coincidence.
  assert.equal(config.defaultHttpUserAgent, ENV_USER_AGENT);

  resetHostStrategyMemory();

  assert.equal(sessionPinsItsOwnProfile(ENV_USER_AGENT), false);

  const rows = new Map<string, unknown>();
  let probes = 0;
  const resolved = await resolveHostStrategy(HOST, PROBE_URL, ENV_USER_AGENT, {
    sessionId: "99999999-8888-7777-6666-555555555555",
    emit: () => {},
    store: {
      async read() {
        return null;
      },
      async write(value) {
        rows.set(value.host, value);
      },
      async lock() {
        return { release: async () => undefined };
      }
    },
    probe: async () => {
      probes += 1;
      return cleanResult();
    },
    logger: silentLogger
  });

  // Negotiated, recorded and usable — all of which the old comparison skipped.
  assert.equal(probes, 1);
  assert.equal(resolved.verdict, "OK");
  assert.equal(resolved.rung, "R0");
  assert.equal(rows.has(HOST), true);
  // R0 leads with the session's UA, which here IS the env-provided default.
  assert.equal(resolved.ladder[0].userAgent, ENV_USER_AGENT);
});

test("a UA that is neither the env default nor the constant still pins", async () => {
  const { sessionPinsItsOwnProfile } = await import("./hostStrategy.js");

  // The override behaviour itself must survive the fix: a caller who asked for a
  // specific UA is still not negotiated for.
  assert.equal(sessionPinsItsOwnProfile("AcmeCrawler/9.9"), true);
  // Including the hardcoded constant, once the env var has redefined the default —
  // at that point the constant is no longer what "no instruction given" means.
  const { DEFAULT_HTTP_USER_AGENT } = await import("../config.js");
  assert.equal(sessionPinsItsOwnProfile(DEFAULT_HTTP_USER_AGENT), true);
});
