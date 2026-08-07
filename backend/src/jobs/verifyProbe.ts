import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import {
  acquireHostSlot,
  rateLimitHostKey,
  verificationRateLimit
} from "../http/hostRateLimiter.js";
import { checkSampleUrl, type SampleCheckResult } from "./sampleUrlCheck.js";
import { resolveSampleTarget } from "./sampleTarget.js";

// The one probe both verification paths (full sweep and sample triage) call.
//
// It is checkSampleUrl — byte for byte the same HEAD / GET-fallback / soft-404
// classifier that pattern sampling uses, so a URL never gets one verdict from
// the sampler and a different one from the verifier — with the per-host rate
// limiter in front of it.
//
// A slot is charged PER HTTP REQUEST, not per check (fixed v1.52).
//
// It used to be one slot per check, on the reasoning that the multiplier was
// small and the configured number had headroom for it. That was wrong, and
// measurably so: one check is 1-2 requests (HEAD, plus a soft-404 GET on a 2xx
// or a follow-up HEAD on a 3xx), so on a redirect-heavy pattern the origin saw
// nearly double the configured rate. MEASURED at 49.17 requests/second against
// a 25/s ceiling (bench/verifyThroughput.ts, 1,200 URLs, 25ms origin, 70% 301).
//
// It looked fine in earlier testing only by accident: against a 300ms origin,
// concurrency 8 capped throughput at ~13 checks/s before the limiter ever
// engaged, so the request rate landed near 25 by coincidence rather than by
// control. The protection was a function of how slow the target happened to be.
//
// Charging per request makes the configured number mean what it says — the rate
// the target actually experiences — which is the precondition for any informed
// decision about raising it.
//
// Pacing keys on the RESOLVED target host, not the session's base_url, because
// resolveSampleTarget can send the probe to a different host than base_url
// names (the www-equivalence rule). The host actually receiving the traffic is
// the host whose budget must be charged.

// Verification's own concurrency, deliberately NOT derived from
// sessions.concurrency (v1.52).
//
// It used to be min(session, config), which quietly made the sampler's knob the
// governor: sessions.concurrency defaults to 10, so raising the verification cap
// to 16 changed nothing and raising the rate ceiling to 50/s changed nothing
// either — MEASURED at 31.7 req/s with max-in-flight pinned at 10 against a
// 50/s ceiling.
//
// The two settings are about different operations. sessions.concurrency sizes
// the SAMPLER's burst of 5-20 URLs per pattern. Verification is a sustained
// sweep whose load is bounded by the per-request rate limiter, so its socket
// count is a throughput parameter, not a politeness one — the politeness knob
// is maxRequestsPerSecond, and it is enforced regardless of what this returns.
export function verifyConcurrency(): number {
  return Math.max(1, config.verification.maxConcurrency);
}

export async function probeUrl(
  baseUrl: string,
  sourceUrl: string,
  userAgent: string,
  logger: FastifyBaseLogger,
  context: {
    sessionId: string;
    patternId: string;
    template: string;
    sampleIndex: number;
  }
): Promise<SampleCheckResult> {
  let path: string;

  try {
    const url = new URL(sourceUrl);

    path = `${url.pathname}${url.search}`;
  } catch {
    path = sourceUrl;
  }

  const target = resolveSampleTarget(baseUrl, path, sourceUrl);
  const host = rateLimitHostKey(target);

  // checkSampleUrl never throws — failures come back classified
  // (timeout/ssl_cert/no_response), which is what we want persisted.
  //
  // The hook fires before each of the check's requests, including the follow-up
  // ones, so a check that costs two requests spends two slots. Charging on the
  // resolved target's host means a redirect that leaves the origin is billed to
  // wherever it actually went.
  return checkSampleUrl(baseUrl, path, sourceUrl, userAgent, logger, context, {
    beforeRequest: () => acquireHostSlot(host, verificationRateLimit()),
    // Verification exists to establish each URL's OWN status so delete-by-status
    // can act on it. The follow-up HEAD on a redirect destination contributes
    // only responseMs, which verified_urls does not store — finalUrl comes from
    // the first response's Location header either way. Skipping it halves the
    // request cost of a redirect-heavy pattern with byte-identical results.
    skipRedirectFollow: true
  });
}
