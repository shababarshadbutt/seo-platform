import type { FastifyBaseLogger } from "fastify";

import {
  logDiagnosticEvent,
  type DiagnosticEmitter
} from "../diagnostics/eventLog.js";
import { runCheckWithProfile } from "../jobs/sampleUrlCheck.js";
import {
  acquireHostSlot,
  rateLimitBucketFor,
  rateLimitHostKey,
  verificationRateLimit
} from "./hostRateLimiter.js";
import {
  noteHostCheckOutcome,
  profileForRung,
  resolveHostStrategy,
  type ResolvedHostStrategy
} from "./hostStrategy.js";
import { hostStrategyStore } from "./hostStrategyStore.js";
import { privateRouteFor } from "./privateRoute.js";
import { disablePrivateRoute } from "./privateRouteHealth.js";

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
  // Record that this run declined to check something because the host refuses us.
  //
  // ON THE RUN, not free-floating, so it cannot be called without the session and phase
  // that make it meaningful. Callers decide the GRANULARITY, and that is the whole point:
  // sampling calls it once per pattern, verification once per HOST for an entire run of
  // up to 1.3M URLs. See the note on each call site.
  noteSkipped: (
    strategy: ResolvedHostStrategy,
    fields: { pattern?: string | null; url_count_affected: number }
  ) => void;
  // Feed the staleness heuristic, with this run's session and phase attached.
  //
  // Wraps noteHostCheckOutcome rather than exposing the emitter, because this is the one
  // hook called PER URL — up to 1.3M times — and a call site holding a raw emitter here
  // is one refactor away from writing a line per URL. Routing it through the run keeps
  // the "only on a threshold crossing" rule in one place.
  noteOutcome: (host: string, wasClean: boolean) => void;
};

export type HostStrategyRunContext = {
  sessionId: string;
  phase: "sampling" | "recheck" | "verification" | "triage";
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
  logger: FastifyBaseLogger,
  // WHICH SESSION this run belongs to, and which PHASE is asking. Both go on every
  // diagnostic event: the durable files are keyed by session, and "sampling skipped this
  // pattern" and "verification skipped this host" are different findings that used to be
  // indistinguishable in one interleaved log stream.
  //
  // Required — the three callers all have a session row in hand before they get here, so
  // there is no path that legitimately omits it.
  context: HostStrategyRunContext
): HostStrategyRun {
  const byHost = new Map<string, ResolvedHostStrategy>();
  const inFlight = new Map<string, Promise<ResolvedHostStrategy>>();
  const emit: DiagnosticEmitter = (event, fields) => {
    logDiagnosticEvent(event, context.sessionId, {
      phase: context.phase,
      ...fields
    });
  };

  async function resolve(
    host: string,
    probeUrl: string | null
  ): Promise<ResolvedHostStrategy> {
    const strategy = await resolveHostStrategy(host, probeUrl, sessionUserAgent, {
      store: hostStrategyStore,
      logger,
      sessionId: context.sessionId,
      emit,
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

  // A host reached over the private VPC path needs no strategy, and must not obey the
  // one it has.
  //
  // WHY NO NEGOTIATION. Every rung above R0 exists to get past a WAF or a bot filter.
  // A request to the origin's private address never meets either, so climbing the
  // ladder there could only cost requests — R1's browser profile has nothing to
  // recover. The ladder is therefore a SINGLE rung, and checkSampleUrl already treats
  // a one-entry ladder as "a request saved rather than a check weakened".
  //
  // WHY skip IS ALWAYS FALSE. The circuit breaker records that a PUBLIC EDGE refused
  // our egress IP. That is a true statement about a different network path and it
  // stays in host_probe_profiles as evidence for the allowlist conversation with
  // devops — but obeying it here would skip a host that now answers perfectly well.
  // Because this branch never reads the store, a stale REFUSED verdict cannot leak
  // in: no migration deletes rows, and no cache has to be invalidated.
  function privateStrategy(host: string): ResolvedHostStrategy {
    return {
      host,
      verdict: "OK",
      rung: "R0",
      skip: false,
      ladder: [profileForRung("R0", sessionUserAgent)],
      edgeServer: null,
      lastStatus: null,
      source: "private-route",
      decidedAt: null,
      rungsTried: []
    };
  }

  // Which private IPs this run has already proved carry traffic.
  //
  // Per IP, not per host: ~93 hostnames share each box, so what is being tested is
  // whether the BOX answers. Per-host would pay 93 probes to learn one fact.
  const preProbedIps = new Set<string>();

  // ONE request, before any bulk work, that decides whether this private route works.
  //
  // WHY IT EARNS ITS REQUEST. Without it the failure mode of a dead or unroutable
  // private IP is: the first N URLs come back with no status and are recorded as
  // `failure` — real, wrong, user-visible verdicts — and only then does the streak
  // breaker in sampleUrlCheck trip. With it, a dead route costs exactly one request
  // and produces zero measurements, because the run falls back to the public path
  // before measuring anything.
  //
  // Returns true when the route carried the request. ANY http status counts: a 404 or
  // a 403 still proves a web server is at the other end.
  async function privateRouteAnswers(
    host: string,
    ip: string,
    probeUrl: string
  ): Promise<boolean> {
    const result = await runCheckWithProfile(
      probeUrl,
      profileForRung("R0", sessionUserAgent),
      logger,
      { host, probe_url: probeUrl, private_route_preflight: true },
      {
        // Paced by the same budget as every other request to this origin — the
        // private one, since that is where this probe is going.
        beforeRequest: () => {
          const bucket = rateLimitBucketFor(probeUrl, ip);

          return acquireHostSlot(bucket.key, bucket.options);
        },
        skipRedirectFollow: true
      }
    );

    if (result.httpStatus !== null) {
      return true;
    }

    const tripped = disablePrivateRoute(ip);

    logger.error(
      {
        host,
        private_ip: ip,
        probe_url: probeUrl,
        error_reason: result.errorReason,
        recovers: tripped.recovers
      },
      "private route pre-probe got no response — using the public path for this IP"
    );

    emit("private_route_failed", {
      private_ip: ip,
      host,
      consecutive_failures: tripped.consecutiveFailures,
      error_reason: result.errorReason,
      action: "fell back to public https",
      recovers: tripped.recovers
    });

    return false;
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

      // Checked BEFORE the store, the lock and the negotiation race — all three are
      // about a public edge this request will not touch.
      const route = privateRouteFor(targetUrl);

      if (route) {
        // The pre-probe uses the SAME deep-URL rule as negotiation, and for the same
        // reason. With no usable deep URL it is skipped rather than run against "/":
        // the streak breaker in sampleUrlCheck still covers a route that fails later,
        // and a pessimistic verdict from an entry-point path is worse than no verdict.
        const needsPreProbe = usableProbe !== null && !preProbedIps.has(route.ip);

        if (needsPreProbe) {
          preProbedIps.add(route.ip);

          if (!(await privateRouteAnswers(host, route.ip, usableProbe))) {
            // Route abandoned. Fall through to the ordinary public resolution below —
            // privateRouteFor now returns null for this IP, so nothing else in the run
            // will try it either.
            return resolve(host, usableProbe);
          }
        }

        const strategy = privateStrategy(host);

        byHost.set(host, strategy);

        // ONE EVENT PER HOST PER RUN, guaranteed by the memo above. This is where a
        // map typo becomes visible: it names the IP a whole site family was measured
        // against, so a host silently pointed at the wrong box is a grep away rather
        // than an unexplained set of findings.
        emit("private_route_selected", {
          host,
          private_ip: route.ip,
          scheme: route.scheme,
          matched_via: route.matchedVia
        });

        return strategy;
      }

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
    },
    noteSkipped(strategy, fields) {
      // THE EVENT THAT PROVES THE CIRCUIT BREAKER IS BEING CONSULTED. If a session is
      // full of unscored rows and there are almost no skip events, the breaker is not
      // running — which is the most likely bug after a change to this engine, and it is
      // invisible in outcome data because "skipped" and "never measured" look identical
      // in the database.
      //
      // decided_at is what turns it from an observation into something actionable: a
      // skip obeying a verdict from six days ago may be enforcing a block that the
      // target's side already lifted.
      emit("host_strategy_skipped", {
        host: strategy.host,
        reason: "verdict_REFUSED",
        edge_server: strategy.edgeServer,
        last_status: strategy.lastStatus,
        source: strategy.source,
        decided_at: strategy.decidedAt,
        pattern: fields.pattern ?? null,
        url_count_affected: fields.url_count_affected
      });
    },
    noteOutcome(host, wasClean) {
      noteHostCheckOutcome(host, wasClean, emit);
    }
  };
}
