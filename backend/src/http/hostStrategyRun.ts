import type { FastifyBaseLogger } from "fastify";

import { runCheckWithProfile } from "../jobs/sampleUrlCheck.js";
import {
  acquireHostSlot,
  rateLimitHostKey,
  verificationRateLimit
} from "./hostRateLimiter.js";
import {
  resolveHostStrategy,
  type ResolvedHostStrategy
} from "./hostStrategy.js";
import { hostStrategyStore } from "./hostStrategyStore.js";

// Per-RUN wrapper around the strategy engine: one resolved strategy per host, held
// for the life of a job.
//
// WHY MEMOISE PER RUN as well as in Redis. A sampling pass resolves the same host
// once per pattern and a verification pass once per URL — 1.3M times on a big
// session. Redis would answer all of them, but a Map answers them for free, and the
// engine's contract ("negotiate once per host") should not depend on how chatty its
// caller is.
//
// It also makes the REFUSED verdict sticky for the run in the strongest possible
// way: the same object is handed to every caller, so sampling and a verification
// started later in the same process cannot disagree about a host.
export type HostStrategyRun = {
  // Resolve for the host of `targetUrl`. `probeUrl` is what negotiation will probe
  // if this host has never been seen — pass a DEEP url, never a bare root.
  forTarget: (targetUrl: string, probeUrl?: string | null) => Promise<ResolvedHostStrategy>;
  // Everything resolved so far, for the end-of-run report.
  resolved: () => ResolvedHostStrategy[];
};

function isBareRoot(url: string): boolean {
  try {
    return new URL(url).pathname === "/";
  } catch {
    return false;
  }
}

export function createHostStrategyRun(
  sessionUserAgent: string,
  logger: FastifyBaseLogger
): HostStrategyRun {
  const byHost = new Map<string, ResolvedHostStrategy>();
  const inFlight = new Map<string, Promise<ResolvedHostStrategy>>();

  async function resolve(
    host: string,
    probeUrl: string | null
  ): Promise<ResolvedHostStrategy> {
    const strategy = await resolveHostStrategy(host, probeUrl, sessionUserAgent, {
      store: hostStrategyStore,
      logger,
      // Negotiation is a real request to the client's origin, so it is paced by the
      // SAME per-host budget as everything else. No separate limiter, no exception:
      // a "quick pre-flight" that bypassed the budget would be the second unmetered
      // path this project has already been burned by twice.
      probe: (url, profile) =>
        runCheckWithProfile(
          url,
          profile,
          logger,
          { host, probe_url: url, negotiation: true },
          {
            beforeRequest: () =>
              acquireHostSlot(rateLimitHostKey(url), verificationRateLimit()),
            // Negotiation asks "did this origin answer us", so the follow-up HEAD on a
            // redirect destination is pure waste here: it contributes only responseMs,
            // which no part of a host verdict reads. On a redirect-heavy host it would
            // double the cost of every negotiation for nothing.
            skipRedirectFollow: true
          }
        )
    });

    byHost.set(host, strategy);

    return strategy;
  }

  return {
    async forTarget(targetUrl, probeUrl) {
      const host = rateLimitHostKey(targetUrl);
      const cached = byHost.get(host);

      if (cached) {
        return cached;
      }

      // NEVER negotiate on a bare root. The caller's pre-flight already picks a deep
      // URL, but this lazy path takes whatever URL it happens to be looking at, and
      // "/" is measurably the worst possible choice: entry-point paths get stricter
      // treatment than deep content paths (on weareelectromechanicals.com "/" was
      // refused while /product/{param} scored GOOD in the same run), so negotiating
      // there would pick a pessimistic recipe — or a false REFUSED — for the whole
      // host. With no usable probe URL the engine reads what is stored and otherwise
      // returns UNKNOWN, which runs today's default ladder.
      const candidate = probeUrl ?? targetUrl;
      const usableProbe = isBareRoot(candidate) ? null : candidate;

      // Two patterns resolving the same never-seen host at once must not both
      // negotiate. The Redis lock guards ACROSS processes; this guards within one,
      // where it is cheaper and certain.
      const pending = inFlight.get(host);

      if (pending) {
        return pending;
      }

      const started = resolve(host, usableProbe).finally(() => {
        inFlight.delete(host);
      });

      inFlight.set(host, started);

      return started;
    },
    resolved() {
      return Array.from(byHost.values());
    }
  };
}
