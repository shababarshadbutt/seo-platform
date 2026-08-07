// Outbound request pacing, per target host.
//
// WHY THIS EXISTS. Every other bounded-concurrency limit in this codebase caps
// load on OUR OWN infrastructure: SFTP_MAX_CONCURRENT_CONNECTIONS (4) protects
// our AWS Transfer Family endpoint and the shared VM's connection pool; the
// worker concurrencies protect our CPU and disk. Verification is different in
// kind — it points hundreds of thousands of HTTP probes at the CLIENT's
// production web server, the same origin serving their real customers. A
// concurrency cap alone does not bound that: 8 workers against a fast origin is
// a sustained ~80 requests/second, and nothing in the system was slowing it
// down. The observed whole-session run was averaging ~35 URL checks/second for
// 80 minutes straight.
//
// So concurrency and RATE are limited separately, because they bound different
// failure modes:
//   * concurrency bounds SIMULTANEOUS SOCKETS — what exhausts a target's
//     connection pool / worker slots;
//   * rate bounds REQUESTS OVER TIME — what shows up on their monitoring as a
//     traffic spike and trips WAF rate rules (this project has already been
//     WAF-blocked once; see DEFAULT_HTTP_USER_AGENT in config.ts).
//
// PER HOST, not per job, and process-global. The unit being protected is one
// origin server. Two sessions verifying the same domain, or a triage sample
// running alongside a full verification, must share one budget — otherwise
// "25 requests/second" quietly becomes 50. Keying on host also means verifying
// two different clients in parallel is not needlessly serialised.
//
// Scheduling is VIRTUAL, not a sleeping token bucket: each caller atomically
// claims the next free time slot and then waits for it. The claim (read
// nextSlotAt, write nextSlotAt) has no await between the read and the write, so
// concurrent callers can never claim the same slot — the same trick
// runWithBoundedConcurrency uses to hand out indexes. This makes the spacing
// exact rather than approximate, and means N waiting callers each wake once
// instead of all re-checking a shared bucket.

import { config } from "../config.js";

export type RateLimiterOptions = {
  requestsPerSecond: number;
  // How many requests may go out back-to-back after an idle period. Without
  // this, a 30-URL triage sample against an idle host would be paced out over
  // its full duration even though the host is provably not under load. Burst
  // credit is capped, so it cannot accumulate into a flood.
  burst: number;
};

// Width of the hard-ceiling window. "Requests per second" is measured over a
// second — but the limiter controls when a request is RELEASED, while the thing
// being protected experiences when it ARRIVES, and under load those differ by
// connection setup and event-loop scheduling.
//
// So the backstop window is a second plus a jitter allowance. If releases are
// capped at N per 1250ms and every arrival lands within 250ms of its release,
// then arrivals inside any 1000ms window come from releases inside a 1250ms
// window, so the arrival-side bound is N as well. Measuring against exactly
// 1000ms of releases does NOT give that guarantee, which is why the integration
// test still saw 36 arrivals against a 35 ceiling with the naive window.
//
// This costs nothing in normal operation: at the 25/s schedule rate a 1250ms
// window holds ~31 releases, below the 35 ceiling, so the backstop only ever
// binds after a stall.
const WINDOW_MS = 1000;
const ARRIVAL_JITTER_ALLOWANCE_MS = 250;
const BACKSTOP_WINDOW_MS = WINDOW_MS + ARRIVAL_JITTER_ALLOWANCE_MS;

type HostState = {
  // Earliest wall-clock time (ms) at which the next request to this host may be
  // issued. Requests claim slots from here and push it forward.
  nextSlotAt: number;
  // Timestamps of requests actually ISSUED inside the trailing window, oldest
  // first. Trimmed on every acquire, so it never holds more than the ceiling.
  issuedAt: number[];
};

const hostStates = new Map<string, HostState>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// Exported for tests: lets a case start from a known-idle limiter.
export function resetHostRateLimiter() {
  hostStates.clear();
}

// Exported for tests: the injectable clock/sleep keeps the unit tests fast and
// deterministic instead of actually waiting seconds of wall time.
export type RateLimiterClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const systemClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep
};

// Claim this host's next request slot and wait until it is due. Resolves when
// the caller may issue its request.
export async function acquireHostSlot(
  host: string,
  options: RateLimiterOptions,
  clock: RateLimiterClock = systemClock
): Promise<void> {
  const requestsPerSecond = Math.max(0.001, options.requestsPerSecond);
  const spacingMs = 1000 / requestsPerSecond;
  const burst = Math.max(1, options.burst);
  const now = clock.now();

  let state = hostStates.get(host);

  if (!state) {
    state = { nextSlotAt: now, issuedAt: [] };
    hostStates.set(host, state);
  }

  // A schedule that has fallen behind real time is caught up to now, not
  // banked. Otherwise an hour of idleness would license an hour's worth of
  // requests all at once — precisely the flood this module prevents.
  const slot = Math.max(state.nextSlotAt, now);

  // Claimed synchronously — no await between reading and writing nextSlotAt, so
  // two concurrent callers can never be handed the same slot.
  state.nextSlotAt = slot + spacingMs;

  // Burst credit: a caller may run up to (burst - 1) slots AHEAD of its
  // scheduled position without waiting, so an idle host absorbs a short run
  // immediately. It does not change the long-run rate — nextSlotAt still
  // advances by exactly one interval per request, so the credit is a fixed
  // head start that is repaid, not a faster clock.
  const burstCreditMs = (burst - 1) * spacingMs;
  const waitMs = slot - now - burstCreditMs;

  if (waitMs > 0) {
    await clock.sleep(waitMs);
  }

  // HARD CEILING, enforced on requests actually issued rather than on the
  // virtual schedule.
  //
  // The schedule above bounds the LONG-RUN rate exactly — nextSlotAt advances
  // by one interval per request, always — but it does not bound a short
  // catch-up burst. If the event loop stalls (GC, a big synchronous parse, a
  // busy worker), every slot that came due during the stall is already in the
  // past when the loop resumes, so all of those requests go out together. Found
  // by the integration test, which was clean in isolation and put 37 requests
  // into a one-second window under full-suite load, against a 35 ceiling.
  //
  // A sustained-rate limiter that spikes is the wrong shape for the thing being
  // protected: a WAF rate rule and an origin's connection pool both react to
  // the spike, not to the average. So the trailing window is checked too, and a
  // request that would exceed rate + burst inside one second waits for the
  // oldest one to age out. Normal operation never reaches this branch; it only
  // binds after a stall.
  const maxPerWindow = Math.ceil(requestsPerSecond) + burst;

  for (;;) {
    const at = clock.now();
    const cutoff = at - BACKSTOP_WINDOW_MS;

    while (state.issuedAt.length > 0 && state.issuedAt[0] <= cutoff) {
      state.issuedAt.shift();
    }

    if (state.issuedAt.length < maxPerWindow) {
      break;
    }

    await clock.sleep(state.issuedAt[0] + BACKSTOP_WINDOW_MS - at);
  }

  // Recorded synchronously after the check — no await between them, so
  // concurrent callers cannot both pass a full window.
  state.issuedAt.push(clock.now());
}

// Host key for a URL. An unparseable URL still gets a stable bucket rather than
// escaping the limiter entirely — being paced under the wrong key is strictly
// better than not being paced.
export function rateLimitHostKey(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "unparseable";
  }
}

// The options every verification path uses, from config. Callers take this
// rather than inventing their own numbers, so triage and full verification
// provably share one budget per host.
export function verificationRateLimit(): RateLimiterOptions {
  return {
    requestsPerSecond: config.verification.maxRequestsPerSecond,
    burst: config.verification.rateLimitBurst
  };
}
