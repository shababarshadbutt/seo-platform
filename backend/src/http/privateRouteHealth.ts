// Is a private route still working? Per IP, and it never heals itself.
//
// WHY PER IP, NOT PER HOST. Roughly 93 hostnames share each of the 7 private
// addresses, so the thing that can stop answering is a BOX, not a site. A host-
// keyed breaker would need 93 independent failures to notice one dead server,
// and would spend 93 x failureStreak requests learning it.
//
// WHY PROCESS-LOCAL, not Redis or Postgres. Same reasoning as the refusalStreaks
// map in hostStrategy.ts: this is a heuristic about right now, not a durable
// verdict about a host. Losing it on restart is harmless — the next run re-probes
// in one request (see the pre-probe in hostStrategyRun) and learns the same thing
// immediately. Persisting it would mean a dead route stays "dead" in the database
// after devops fixes the box.
//
// WHY IT NEVER AUTO-RE-ENABLES. A half-open breaker that retries on a timer
// sounds kinder and is worse here: a flapping route would alternate verdicts
// mid-sweep, so the same pattern's URLs would be measured against two different
// network paths and the resulting numbers would mean nothing. Recovery is
// deliberately a human action — `docker compose restart worker backend`. Because
// that is surprising, it is stated in three places that a reader will actually
// hit: the recovers field below, the /api/private-routes response, and the
// deploy note.

export type PrivateRouteFailure = {
  ip: string;
  disabledSince: number;
  consecutiveFailures: number;
};

const failureStreaks = new Map<string, number>();
const disabled = new Map<string, PrivateRouteFailure>();

// What a caller must tell the reader when it reports a disabled route. A string
// rather than a boolean so it cannot be rendered as "false" and read as
// "recovers automatically: no, wait, yes?".
export const PRIVATE_ROUTE_RECOVERY = "never — restart backend+worker";

export type PrivateRouteTripped = PrivateRouteFailure & {
  recovers: typeof PRIVATE_ROUTE_RECOVERY;
};

// Record what a privately-routed check produced.
//
// gotHttpStatus is the ONLY signal used, and it is the right one: any HTTP status
// at all — 200, 404, even 403 — proves the private path carried the request to a
// web server. A route is broken only when nothing answers (connection refused,
// timeout, reset), which is exactly `statusCode === null` at the call site.
//
// Returns the trip record on the transition, and null otherwise, so the caller
// logs and emits exactly once instead of on every subsequent failure.
export function notePrivateRouteOutcome(
  ip: string,
  gotHttpStatus: boolean,
  failureStreak: number
): PrivateRouteTripped | null {
  if (gotHttpStatus) {
    failureStreaks.delete(ip);
    return null;
  }

  if (disabled.has(ip)) {
    return null;
  }

  const streak = (failureStreaks.get(ip) ?? 0) + 1;

  failureStreaks.set(ip, streak);

  if (streak < failureStreak) {
    return null;
  }

  const record: PrivateRouteFailure = {
    ip,
    disabledSince: Date.now(),
    consecutiveFailures: streak
  };

  disabled.set(ip, record);
  failureStreaks.delete(ip);

  return { ...record, recovers: PRIVATE_ROUTE_RECOVERY };
}

// Abandon a route outright, without waiting for a streak.
//
// For the per-run PRE-PROBE, which is the difference between "3 URLs get recorded as
// broken before the breaker notices" and "no URL is ever measured over a dead route".
// One request answers it, so there is nothing to accumulate evidence about.
export function disablePrivateRoute(ip: string): PrivateRouteTripped {
  const existing = disabled.get(ip);

  if (existing) {
    return { ...existing, recovers: PRIVATE_ROUTE_RECOVERY };
  }

  const record: PrivateRouteFailure = {
    ip,
    disabledSince: Date.now(),
    consecutiveFailures: 1
  };

  disabled.set(ip, record);
  failureStreaks.delete(ip);

  return { ...record, recovers: PRIVATE_ROUTE_RECOVERY };
}

export function isPrivateRouteDisabled(ip: string): boolean {
  return disabled.has(ip);
}

export function privateRouteHealthSnapshot(): Array<
  PrivateRouteFailure & { recoversOn: typeof PRIVATE_ROUTE_RECOVERY }
> {
  return [...disabled.values()].map((record) => ({
    ...record,
    recoversOn: PRIVATE_ROUTE_RECOVERY
  }));
}

// Test seam, matching resetObservedAlpn() / resetHostRateLimiter().
export function resetPrivateRouteHealth(): void {
  failureStreaks.clear();
  disabled.clear();
}
