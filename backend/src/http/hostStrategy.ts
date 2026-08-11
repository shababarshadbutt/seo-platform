import type { FastifyBaseLogger } from "fastify";

import { DEFAULT_HTTP_USER_AGENT } from "../config.js";
import {
  BROWSER_FALLBACK_PROFILE,
  type RequestProfile,
  type SampleCheckResult
} from "../jobs/sampleUrlCheck.js";

// PER-HOST REQUEST STRATEGY. Negotiate once, remember, reuse.
//
// THE PROBLEM IT SOLVES. v1.60 retries every non-clean result with the browser
// profile. Per URL that is correct — a bot filter can answer with any status, so one
// refusal is not proof a page is dead. Across a FLEET it is ruinous: a host that
// refuses everything makes a 1.3M-URL population pay ~2.6M requests to learn one
// fact 1.3M times, which at the shipped 5 req/s per-host budget is days of wall
// clock for no information. Meanwhile a host that only answers the browser profile
// pays double on every single URL forever, because nothing remembers that.
//
// So the unit of learning is the HOST: at most three probes decide which request
// profile it answers, or that it answers none, and every check afterwards starts
// from that answer.
//
// WHY IT CANNOT BE HARDCODED INSTEAD. There is no single correct recipe. Migration
// 032 documented a site where a browser UA tripped AWS WAF Bot Control into a
// CAPTCHA and the honest crawler UA passed; weareelectromechanicals.com is the exact
// reverse; stackedindustrials.com refuses a bare curl from our egress IP before it
// reads a header at all. Three sites in one family, three different answers. The
// engine measures rather than guessing.
//
// DELIBERATELY DEPENDENCY-INJECTED. Everything here is pure apart from the probe and
// the store, both passed in. That keeps the ladder, the circuit breaker and the race
// guard unit-testable with an in-memory store and a fake probe — no Redis, no
// Postgres, no sockets — which is the same discipline sampleHttpStatus.ts and
// patternScore.ts follow and the reason those modules have real test coverage.

// The rungs, cheapest and most honest first.
//
// R0 is FIRST on purpose. Most sites answer the crawler UA, and disguising the
// checker against an origin that answers it honestly is both unnecessary and — per
// migration 032 — capable of causing the very block it is meant to avoid.
//
// R3 (Client Hints + Chrome's exact accept string) and R4 (GET instead of HEAD) are
// designed but NOT built: sec-ch-ua is version-coupled to the UA string, and nothing
// in the fleet has yet proven it needs them. Adding rungs speculatively would be
// maintenance debt with no measured benefit.
export type Rung = "R0" | "R1" | "R2";

export const RUNG_ORDER: readonly Rung[] = ["R0", "R1", "R2"];

// How many consecutive non-clean per-URL results on a previously-OK host before its
// recipe is treated as stale and re-negotiated ONCE.
//
// Not 1. Re-negotiating on every refusal would reintroduce exactly the per-URL cost
// this engine removes — and a single refusal is ordinary: one 404 in a sitemap is a
// finding, not evidence that the recipe stopped working.
export const REFUSAL_STREAK_BEFORE_RENEGOTIATION = 3;

// A learned recipe is good for a week. Long enough that negotiation is negligible
// (650 hosts x <=3 probes per week), short enough that an allowlist landing on the
// target's side is picked up without anyone remembering to clear a cache.
export const HOST_STRATEGY_TTL_SECONDS = 7 * 24 * 60 * 60;

export type HostVerdict = "OK" | "REFUSED";

export type StoredHostStrategy = {
  host: string;
  verdict: HostVerdict;
  // Null exactly when verdict is REFUSED.
  rung: Rung | null;
  edgeServer: string | null;
  lastStatus: number | null;
  decidedAt: string;
};

// What the caller gets back. `ladder` is what goes into
// checkSampleUrl's options.profileLadder; `skip` is the circuit breaker.
export type ResolvedHostStrategy = {
  host: string;
  verdict: HostVerdict | "UNKNOWN";
  rung: Rung | null;
  // TRUE only for a REFUSED host: issue no requests for it at all.
  skip: boolean;
  ladder: RequestProfile[];
  edgeServer: string | null;
  lastStatus: number | null;
};

export type HostStrategyStore = {
  read: (host: string) => Promise<StoredHostStrategy | null>;
  write: (value: StoredHostStrategy) => Promise<void>;
  // Returns null when another process holds the negotiation lock for this host.
  lock: (host: string) => Promise<{ release: () => Promise<void> } | null>;
};

export type RungProbe = (
  url: string,
  profile: RequestProfile
) => Promise<SampleCheckResult>;

export type HostStrategyDeps = {
  store: HostStrategyStore;
  probe: RungProbe;
  logger: FastifyBaseLogger;
  // Injected for tests; production leaves them alone.
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

// How long a loser of the negotiation race waits for the winner's answer before
// giving up and running on the default ladder. Bounded because a wait that outlives
// the negotiation it is waiting for would stall a whole session on one host.
const NEGOTIATION_WAIT_MS = 5000;
const NEGOTIATION_POLL_MS = 250;

export function profileForRung(
  rung: Rung,
  sessionUserAgent: string
): RequestProfile {
  if (rung === "R0") {
    return { userAgent: sessionUserAgent, extraHeaders: {} };
  }

  if (rung === "R1") {
    return BROWSER_FALLBACK_PROFILE;
  }

  return { ...BROWSER_FALLBACK_PROFILE, allowH2: true };
}

function nextRung(rung: Rung): Rung | null {
  const index = RUNG_ORDER.indexOf(rung);

  return RUNG_ORDER[index + 1] ?? null;
}

// The ladder for a host whose rung is known: the learned rung FIRST, the next rung
// up as the per-URL safety net.
//
// The safety net stays deliberately. "One recipe per host" is about where the
// COMMON case starts, not about removing the per-URL fallback: a negotiated-OK host
// can still refuse one atypical path (a stricter homepage, an admin route), and
// silently mis-scoring that path would be a worse bug than the cost it saves. The
// win is that the common case now succeeds on attempt #1 instead of climbing from
// R0 every time.
//
// A host on the top rung gets a ONE-entry ladder — checkSampleUrl then makes a
// single attempt, which is a request saved rather than a check weakened.
export function ladderForRung(
  rung: Rung,
  sessionUserAgent: string
): RequestProfile[] {
  const next = nextRung(rung);
  const profiles = [profileForRung(rung, sessionUserAgent)];

  if (next) {
    profiles.push(profileForRung(next, sessionUserAgent));
  }

  return profiles;
}

// Today's behaviour, used when nothing is known (or must not be learned): honest UA
// first, browser profile as the safety net.
function defaultLadder(sessionUserAgent: string): RequestProfile[] {
  return [{ userAgent: sessionUserAgent, extraHeaders: {} }, BROWSER_FALLBACK_PROFILE];
}

// A session carrying a NON-DEFAULT user_agent is a deliberate instruction from
// whoever created it. The engine must not go and learn, on their behalf, that this
// host prefers a Chrome UA and then silently send that instead — so negotiation is
// skipped entirely for such sessions.
//
// The per-URL safety net is NOT removed for them: a refused URL still gets one
// browser-profile attempt exactly as it does today, so this respects the override
// without regressing v1.60's recovery.
export function sessionPinsItsOwnProfile(sessionUserAgent: string): boolean {
  return sessionUserAgent !== DEFAULT_HTTP_USER_AGENT;
}

function isTransportFailure(result: SampleCheckResult): boolean {
  return result.httpStatus === null;
}

// DID THE ORIGIN ANSWER US? — the rung-success predicate, and deliberately NOT the
// checker's isRealMeasurement.
//
// isRealMeasurement asks "is this page healthy" (success / redirect / soft_404), which
// is the right question for the PER-URL escalation: a 404 might be a bot filter, so
// try harder before calling the page broken. It is the WRONG question here, and
// dangerously so. A negotiation probe is one randomly-chosen URL out of a sitemap, and
// sitemaps are full of genuinely dead URLs — that is what this tool exists to find. If
// a 404 failed a rung, an unlucky probe URL would fail all three and condemn the whole
// host to REFUSED, skipping a site that answers perfectly well.
//
// So a rung WINS when the origin gave us a real answer of any kind. Only two outcomes
// count as being refused:
//   * "blocked" — a WAF header, or a 405/501 that survived the GET re-probe;
//   * a bare 403 — the status this site family's load balancer actually returns, and
//     the one the per-URL escalation already treats as "ask again differently".
// A 404, 500, 401, 429 or 503 all mean the host is talking to us; the per-URL safety
// net still escalates those individually, exactly as it does today.
export function hostAnsweredRung(result: SampleCheckResult): boolean {
  if (result.httpStatus === null) {
    return false;
  }

  return result.httpStatusCategory !== "blocked" && result.httpStatus !== 403;
}

function unknownStrategy(
  host: string,
  sessionUserAgent: string
): ResolvedHostStrategy {
  return {
    host,
    verdict: "UNKNOWN",
    rung: null,
    skip: false,
    ladder: defaultLadder(sessionUserAgent),
    edgeServer: null,
    lastStatus: null
  };
}

function resolvedFromStored(
  stored: StoredHostStrategy,
  sessionUserAgent: string
): ResolvedHostStrategy {
  if (stored.verdict === "REFUSED" || !stored.rung) {
    return {
      host: stored.host,
      verdict: "REFUSED",
      rung: null,
      skip: true,
      ladder: [],
      edgeServer: stored.edgeServer,
      lastStatus: stored.lastStatus
    };
  }

  return {
    host: stored.host,
    verdict: "OK",
    rung: stored.rung,
    skip: false,
    ladder: ladderForRung(stored.rung, sessionUserAgent),
    edgeServer: stored.edgeServer,
    lastStatus: stored.lastStatus
  };
}

// Walk the ladder against ONE probe URL and decide the host.
//
// Returns UNKNOWN — and persists NOTHING — when no rung ever got an HTTP status.
// That is not a refusal: a host that times out is unreachable, and an unreachable
// host must keep being checked per URL and reported honestly as failing. Recording
// it as REFUSED would skip a site that was merely having a bad minute and tell
// devops it needs an allowlist it does not need.
export async function negotiateHostStrategy(
  host: string,
  probeUrl: string,
  sessionUserAgent: string,
  deps: HostStrategyDeps
): Promise<ResolvedHostStrategy> {
  const { probe, logger } = deps;
  let sawHttpStatus = false;
  let lastEdgeServer: string | null = null;
  let lastStatus: number | null = null;

  for (const rung of RUNG_ORDER) {
    const profile = profileForRung(rung, sessionUserAgent);
    let result = await probe(probeUrl, profile);

    // A transport failure is INCONCLUSIVE, not a refusal: nothing answered, so this
    // rung was never actually tested. Retried once, then the ladder moves on.
    if (isTransportFailure(result)) {
      result = await probe(probeUrl, profile);
    }

    if (result.edgeServer) {
      lastEdgeServer = result.edgeServer;
    }

    if (result.httpStatus !== null) {
      sawHttpStatus = true;
      lastStatus = result.httpStatus;
    }

    if (hostAnsweredRung(result)) {
      const stored: StoredHostStrategy = {
        host,
        verdict: "OK",
        rung,
        edgeServer: result.edgeServer,
        lastStatus: result.httpStatus,
        decidedAt: new Date(deps.now?.() ?? Date.now()).toISOString()
      };

      await deps.store.write(stored);
      logger.info(
        {
          host,
          rung,
          http_status: result.httpStatus,
          edge_server: result.edgeServer
        },
        "host strategy negotiated"
      );

      return resolvedFromStored(stored, sessionUserAgent);
    }
  }

  if (!sawHttpStatus) {
    logger.warn(
      { host, probe_url: probeUrl },
      "host strategy inconclusive — no rung got an HTTP status, not recording a verdict"
    );

    return unknownStrategy(host, sessionUserAgent);
  }

  const refused: StoredHostStrategy = {
    host,
    verdict: "REFUSED",
    rung: null,
    edgeServer: lastEdgeServer,
    lastStatus,
    decidedAt: new Date(deps.now?.() ?? Date.now()).toISOString()
  };

  await deps.store.write(refused);
  logger.warn(
    {
      host,
      last_status: lastStatus,
      edge_server: lastEdgeServer,
      rungs_tried: RUNG_ORDER.length
    },
    "host strategy REFUSED — every rung was refused, skipping per-URL checks for this host"
  );

  return resolvedFromStored(refused, sessionUserAgent);
}

// Consecutive non-clean results per host, PROCESS-LOCAL on purpose.
//
// It is a heuristic for "has this recipe gone stale", not durable state, and putting
// it in Redis would add a round trip to every one of 1.3M URL checks to maintain a
// counter whose only job is to occasionally trigger three extra requests. Losing it
// on restart is harmless.
const refusalStreaks = new Map<string, number>();
const forceRenegotiate = new Set<string>();

export function noteHostCheckOutcome(host: string, wasClean: boolean): void {
  if (wasClean) {
    refusalStreaks.delete(host);
    return;
  }

  const streak = (refusalStreaks.get(host) ?? 0) + 1;

  refusalStreaks.set(host, streak);

  if (streak >= REFUSAL_STREAK_BEFORE_RENEGOTIATION) {
    // Re-negotiate ONCE on the next resolve. The streak resets so a still-failing
    // host does not re-negotiate every third URL.
    forceRenegotiate.add(host);
    refusalStreaks.delete(host);
  }
}

export function resetHostStrategyMemory(): void {
  refusalStreaks.clear();
  forceRenegotiate.clear();
}

function isStale(stored: StoredHostStrategy, nowMs: number): boolean {
  const decidedMs = Date.parse(stored.decidedAt);

  if (Number.isNaN(decidedMs)) {
    return true;
  }

  return nowMs - decidedMs > HOST_STRATEGY_TTL_SECONDS * 1000;
}

// The entry point. Read what is known, negotiate only when nothing usable is.
export async function resolveHostStrategy(
  host: string,
  probeUrl: string | null,
  sessionUserAgent: string,
  deps: HostStrategyDeps
): Promise<ResolvedHostStrategy> {
  if (sessionPinsItsOwnProfile(sessionUserAgent)) {
    return unknownStrategy(host, sessionUserAgent);
  }

  const nowMs = deps.now?.() ?? Date.now();
  const mustRenegotiate = forceRenegotiate.has(host);
  const stored = await deps.store.read(host);

  if (stored && !mustRenegotiate && !isStale(stored, nowMs)) {
    return resolvedFromStored(stored, sessionUserAgent);
  }

  // Nothing to negotiate WITH. Keep whatever is stored (even if stale — a stale
  // answer beats no answer) and otherwise fall back to today's ladder.
  if (!probeUrl) {
    return stored
      ? resolvedFromStored(stored, sessionUserAgent)
      : unknownStrategy(host, sessionUserAgent);
  }

  const lock = await deps.store.lock(host);

  if (!lock) {
    // Someone else is negotiating this host right now. WAIT for their answer rather
    // than running a second negotiation in parallel — two processes probing one
    // origin to learn the same thing is the duplicated cost this engine removes.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = nowMs + NEGOTIATION_WAIT_MS;

    for (;;) {
      await sleep(NEGOTIATION_POLL_MS);

      const fresh = await deps.store.read(host);

      if (fresh && (!stored || fresh.decidedAt !== stored.decidedAt)) {
        return resolvedFromStored(fresh, sessionUserAgent);
      }

      if ((deps.now?.() ?? Date.now()) >= deadline) {
        deps.logger.warn(
          { host },
          "host strategy negotiation wait timed out — using the default ladder"
        );

        return stored
          ? resolvedFromStored(stored, sessionUserAgent)
          : unknownStrategy(host, sessionUserAgent);
      }
    }
  }

  try {
    const resolved = await negotiateHostStrategy(
      host,
      probeUrl,
      sessionUserAgent,
      deps
    );

    forceRenegotiate.delete(host);

    return resolved;
  } finally {
    await lock.release();
  }
}
