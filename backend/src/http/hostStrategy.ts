import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import type { DiagnosticEmitter } from "../diagnostics/eventLog.js";
import {
  BROWSER_FALLBACK_PROFILE,
  isRealMeasurement,
  type RequestProfile,
  type SampleCheckResult
} from "../jobs/sampleUrlCheck.js";
import { observedAlpnFor } from "./tlsDispatcher.js";

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
  // Where this answer came from. See HostStrategySource — carried on the resolved value
  // so a skip logged three call sites away can still say whether the verdict it is
  // obeying was measured just now or read from a cache.
  source: HostStrategySource;
  // When the verdict being obeyed was decided. Null when nothing is known (UNKNOWN).
  // The age of a REFUSED decision is the difference between a live problem and one that
  // may have been fixed at the target's end days ago.
  decidedAt: string | null;
  // Which rungs this run actually walked. EMPTY on every cached path, which is the
  // point: an empty list next to a REFUSED verdict says "we did not re-test, we obeyed
  // a stored decision".
  rungsTried?: Rung[];
};

// WHICH TIER ANSWERED, and therefore whether anything was measured just now.
//
// This is the field that separates "this site refuses us" from "this site refused us
// once, up to a week ago": a REFUSED verdict served from `redis` or `table` is a cached
// decision being obeyed, and the run that produced it may be days old. Without it, a
// resolve log line cannot tell those apart, which is exactly the ambiguity that made a
// screenful of unscored rows take a week to explain.
// "private-route" is the one value this module never produces itself: it means the
// caller reached the host over its private VPC address, where there is no WAF to
// negotiate with, so no rung was tried and nothing was read or written. It is in the
// union so the always-emitted host_strategy_resolved event can still state truthfully
// where the answer came from — a resolved strategy with no source would be worse than
// one labelled honestly.
export type HostStrategySource =
  | "redis"
  | "table"
  | "negotiated"
  | "cached-stale"
  | "none"
  | "private-route";

export type ReadHostStrategy = {
  value: StoredHostStrategy;
  source: "redis" | "table";
};

export type HostStrategyStore = {
  read: (host: string) => Promise<ReadHostStrategy | null>;
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
  // WHICH SESSION this resolve belongs to. Required, not optional: the durable
  // diagnostics are filed per session, and every caller provably has one —
  // resolveHostStrategy is reachable only through createHostStrategyRun, whose three
  // callers (sampling, verification, triage) each loaded a session row to get here. A
  // required field is what stops a fourth caller from quietly logging unattributed
  // events.
  sessionId: string;
  // Structured diagnostic sink, INJECTED so this module keeps its stated discipline:
  // everything here is pure apart from the probe and the store, which is what makes the
  // ladder, the circuit breaker and the race guard testable with no Redis, no Postgres,
  // no sockets — and now no filesystem. Production passes the event-log writer
  // (hostStrategyRun); tests pass a recorder and assert on an array.
  emit: DiagnosticEmitter;
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
//
// COMPARED AGAINST config.defaultHttpUserAgent, NOT the DEFAULT_HTTP_USER_AGENT
// constant. Sessions are created with config.defaultHttpUserAgent
// (routes/sessions.ts), which is `process.env.DEFAULT_HTTP_USER_AGENT ?? the
// constant`. Comparing against the constant meant that setting that env var on a
// box — an ordinary thing to reach for on a project that has spent weeks tuning
// this exact header — made EVERY session look like a deliberate override and
// switched the whole engine off, silently, with no log line and no failing test.
// One string has to be the "no instruction was given" value, and it is whichever
// one the session was actually created with.
export function sessionPinsItsOwnProfile(sessionUserAgent: string): boolean {
  return sessionUserAgent !== config.defaultHttpUserAgent;
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
    lastStatus: null,
    source: "none",
    decidedAt: null
  };
}

function resolvedFromStored(
  stored: StoredHostStrategy,
  sessionUserAgent: string,
  source: HostStrategySource
): ResolvedHostStrategy {
  if (stored.verdict === "REFUSED" || !stored.rung) {
    return {
      host: stored.host,
      verdict: "REFUSED",
      rung: null,
      skip: true,
      ladder: [],
      edgeServer: stored.edgeServer,
      lastStatus: stored.lastStatus,
      source,
      decidedAt: stored.decidedAt
    };
  }

  return {
    host: stored.host,
    verdict: "OK",
    rung: stored.rung,
    skip: false,
    ladder: ladderForRung(stored.rung, sessionUserAgent),
    edgeServer: stored.edgeServer,
    lastStatus: stored.lastStatus,
    source,
    decidedAt: stored.decidedAt
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
  const clock = () => deps.now?.() ?? Date.now();
  let sawHttpStatus = false;
  let lastEdgeServer: string | null = null;
  let lastStatus: number | null = null;
  const rungsTried: Rung[] = [];

  // ONE EVENT PER PROBE, and this is the line that actually diagnoses a refusal: it
  // shows the exact point the ladder stopped and what the edge said when it did.
  // Bounded at six per host per run (three rungs, each with at most one transport
  // retry), so it can be always-on.
  const recordAttempt = (
    rung: Rung,
    profile: RequestProfile,
    attempt: number,
    result: SampleCheckResult,
    startedAt: number
  ) => {
    deps.emit("host_strategy_rung_attempt", {
      host,
      rung,
      probe_url: probeUrl,
      attempt,
      status: result.httpStatus,
      category: result.httpStatusCategory,
      // BOTH predicates, deliberately. host_answered is what actually decides the rung
      // (hostAnsweredRung: only a WAF-produced "blocked" or a bare 403 count as
      // refusal). is_real_measurement asks the different question "is this page
      // healthy", and the two disagree on a 404 — the host answered us, the page is
      // dead. Logging only the second one is the confusion that condemned a reachable
      // host to REFUSED before 949c5a31 fixed it.
      host_answered: hostAnsweredRung(result),
      is_real_measurement: isRealMeasurement(result),
      server_header: result.edgeServer,
      // What we ADVERTISED in the TLS handshake, versus what the edge actually chose.
      // When they disagree the edge declined h2, which is otherwise invisible.
      alpn_offered: profile.allowH2 ? "h1,h2" : "h1",
      alpn_negotiated: observedAlpnFor(host),
      method: result.methodUsed,
      duration_ms: clock() - startedAt
    });
  };

  for (const rung of RUNG_ORDER) {
    const profile = profileForRung(rung, sessionUserAgent);

    rungsTried.push(rung);

    const firstStartedAt = clock();
    let result = await probe(probeUrl, profile);

    recordAttempt(rung, profile, 1, result, firstStartedAt);

    // A transport failure is INCONCLUSIVE, not a refusal: nothing answered, so this
    // rung was never actually tested. Retried once, then the ladder moves on.
    if (isTransportFailure(result)) {
      const retryStartedAt = clock();

      result = await probe(probeUrl, profile);
      recordAttempt(rung, profile, 2, result, retryStartedAt);
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

      return {
        ...resolvedFromStored(stored, sessionUserAgent, "negotiated"),
        rungsTried
      };
    }
  }

  if (!sawHttpStatus) {
    logger.warn(
      { host, probe_url: probeUrl },
      "host strategy inconclusive — no rung got an HTTP status, not recording a verdict"
    );

    return { ...unknownStrategy(host, sessionUserAgent), rungsTried };
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

  return {
    ...resolvedFromStored(refused, sessionUserAgent, "negotiated"),
    rungsTried
  };
}

// Consecutive non-clean results per host, PROCESS-LOCAL on purpose.
//
// It is a heuristic for "has this recipe gone stale", not durable state, and putting
// it in Redis would add a round trip to every one of 1.3M URL checks to maintain a
// counter whose only job is to occasionally trigger three extra requests. Losing it
// on restart is harmless.
const refusalStreaks = new Map<string, number>();
const forceRenegotiate = new Set<string>();

// CALLED ONCE PER URL CHECKED — up to 1.3M times in a run. Nothing in here may log
// unconditionally; the diagnostic event fires ONLY on the threshold crossing, which is
// also the only moment anything actually happens.
//
// `emit` is optional here alone, because the per-URL call sites (samplePatternsJob's
// sample loop, verifyProbe) hand this a host and a boolean and have no run object. When
// absent the behaviour is exactly as before.
export function noteHostCheckOutcome(
  host: string,
  wasClean: boolean,
  emit?: DiagnosticEmitter
): void {
  if (wasClean) {
    // A recovery is worth ONE line, and only when there was actually a streak to
    // recover from — otherwise this would fire on every healthy URL.
    if (refusalStreaks.has(host)) {
      emit?.("host_strategy_refusal_streak", {
        host,
        streak: refusalStreaks.get(host) ?? 0,
        action: "recovered"
      });
    }

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
    emit?.("host_strategy_refusal_streak", {
      host,
      streak,
      action: "renegotiate_next_resolve",
      threshold: REFUSAL_STREAK_BEFORE_RENEGOTIATION
    });
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
//
// IT NEVER THROWS. Everything this function does is OPTIONAL work: it is learning
// how to talk to a host so the checks that follow are cheaper, and the checker
// already has a correct answer for "we know nothing about this host" — the default
// ladder. So a store error, a broken socket or a lock that misbehaves degrades to
// UNKNOWN, exactly as an inconclusive probe already does.
//
// This is not defensive decoration. In samplePatternsJob the pre-flight is the
// FIRST thing the job does, and the store issues a plain pool.query against
// host_probe_profiles: a box missing migration 044 threw there, the job's catch
// marked the session FAILED, and NOT ONE pattern was measured. Under v1.60 the
// same error would have been one URL's problem. A performance optimisation must
// not be able to take a session down.
export async function resolveHostStrategy(
  host: string,
  probeUrl: string | null,
  sessionUserAgent: string,
  deps: HostStrategyDeps
): Promise<ResolvedHostStrategy> {
  const startedAt = deps.now?.() ?? Date.now();
  let resolved: ResolvedHostStrategy;

  try {
    resolved = await resolveHostStrategyOrThrow(
      host,
      probeUrl,
      sessionUserAgent,
      deps
    );
  } catch (error) {
    deps.logger.warn(
      { host, probe_url: probeUrl, error },
      "host strategy could not be resolved — continuing on the default request ladder"
    );

    resolved = unknownStrategy(host, sessionUserAgent);
  }

  // ONE LINE PER HOST PER RUN, ON EVERY PATH — cached, pinned-UA, degraded and
  // negotiated alike. This is the event that answers the question a week of
  // screenshots could not: did we even try, and if we did not, why not. Emitted here
  // rather than at each return inside the inner function precisely so no exit can be
  // added later that silently skips it.
  deps.emit("host_strategy_resolved", {
    host,
    probe_url: probeUrl,
    verdict: resolved.verdict,
    winning_rung: resolved.rung,
    rungs_tried: resolved.rungsTried ?? [],
    last_status: resolved.lastStatus,
    edge_server: resolved.edgeServer,
    // redis/table means NOTHING was measured this run — a stored decision is being
    // obeyed, and decided_at says how old it is.
    source: resolved.source,
    decided_at: resolved.decidedAt,
    user_agent_class: userAgentClass(resolved, sessionUserAgent),
    skip: resolved.skip,
    duration_ms: (deps.now?.() ?? Date.now()) - startedAt,
    lock_waited_ms: lockWaitedMs.get(host) ?? 0
  });
  lockWaitedMs.delete(host);

  return resolved;
}

// Which request profile this host will be approached with, in one word.
//
// `session_override` is its own value rather than being folded into "honest": a session
// that pins its own user agent turns the whole engine off for itself, and that has to be
// visible in the log rather than looking like a host nobody could learn anything about.
function userAgentClass(
  resolved: ResolvedHostStrategy,
  sessionUserAgent: string
): "honest" | "browser" | "session_override" {
  if (sessionPinsItsOwnProfile(sessionUserAgent)) {
    return "session_override";
  }

  return resolved.rung === "R0" || resolved.rung === null ? "honest" : "browser";
}

// How long this host's resolve spent WAITING for another process's negotiation.
//
// Module-level and keyed by host because the wait happens deep inside the inner
// function while the event is emitted by the outer one; threading a mutable box through
// four return paths would be worse. Deleted as soon as it is read, so it cannot leak or
// be reported twice.
const lockWaitedMs = new Map<string, number>();

async function resolveHostStrategyOrThrow(
  host: string,
  probeUrl: string | null,
  sessionUserAgent: string,
  deps: HostStrategyDeps
): Promise<ResolvedHostStrategy> {
  if (sessionPinsItsOwnProfile(sessionUserAgent)) {
    // SAY SO. This turns the entire engine off for the session, and a silent
    // opt-out is indistinguishable from an engine that ran and learned nothing —
    // which is precisely the ambiguity that made a screenful of unscored rows
    // take a week to explain. Once per host per run, via the run-level memo.
    deps.logger.info(
      { host, session_user_agent: sessionUserAgent },
      "host strategy skipped — this session pins its own user agent, so no profile is negotiated on its behalf"
    );

    return unknownStrategy(host, sessionUserAgent);
  }

  const nowMs = deps.now?.() ?? Date.now();
  const mustRenegotiate = forceRenegotiate.has(host);
  const read = await deps.store.read(host);
  const stored = read?.value ?? null;

  if (stored && !mustRenegotiate && !isStale(stored, nowMs)) {
    // read is non-null whenever stored is, so the source is the tier that answered.
    return resolvedFromStored(stored, sessionUserAgent, read!.source);
  }

  // Nothing to negotiate WITH. Keep whatever is stored (even if stale — a stale
  // answer beats no answer) and otherwise fall back to today's ladder.
  //
  // `cached-stale` rather than the tier it came from: this answer is PAST its TTL and
  // is being used only because there is no way to refresh it. That is a materially
  // different claim from a fresh cache hit, and a reader chasing a REFUSED verdict needs
  // to know which one they are looking at.
  if (!probeUrl) {
    return stored
      ? resolvedFromStored(
          stored,
          sessionUserAgent,
          isStale(stored, nowMs) ? "cached-stale" : read!.source
        )
      : unknownStrategy(host, sessionUserAgent);
  }

  const lock = await deps.store.lock(host);

  if (!lock) {
    // Someone else is negotiating this host right now. WAIT for their answer rather
    // than running a second negotiation in parallel — two processes probing one
    // origin to learn the same thing is the duplicated cost this engine removes.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = nowMs + NEGOTIATION_WAIT_MS;
    const waitStartedAt = deps.now?.() ?? Date.now();
    const recordWait = () => {
      lockWaitedMs.set(host, (deps.now?.() ?? Date.now()) - waitStartedAt);
    };

    for (;;) {
      await sleep(NEGOTIATION_POLL_MS);

      const fresh = await deps.store.read(host);

      if (fresh && (!stored || fresh.value.decidedAt !== stored.decidedAt)) {
        recordWait();

        return resolvedFromStored(fresh.value, sessionUserAgent, fresh.source);
      }

      if ((deps.now?.() ?? Date.now()) >= deadline) {
        recordWait();
        deps.logger.warn(
          { host },
          "host strategy negotiation wait timed out — using the default ladder"
        );

        return stored
          ? resolvedFromStored(stored, sessionUserAgent, read!.source)
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
