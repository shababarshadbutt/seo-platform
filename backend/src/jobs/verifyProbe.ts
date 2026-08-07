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
// The slot is taken BEFORE the request and covers the whole check, including
// checkSampleUrl's internal follow-up requests (the soft-404 GET on a 2xx, the
// redirect follow on a 3xx). That makes the configured rate a limit on CHECKS
// rather than strictly on requests, so the true request rate can reach roughly
// 2x the configured value on a population that is mostly 2xx. That is a
// deliberate simplification, and it is why maxRequestsPerSecond is set to 25
// against a measured ~35/s baseline rather than to something at the edge —
// there is headroom for the multiplier inside the number.
//
// Pacing keys on the RESOLVED target host, not the session's base_url, because
// resolveSampleTarget can send the probe to a different host than base_url
// names (the www-equivalence rule). The host actually receiving the traffic is
// the host whose budget must be charged.

export function verifyConcurrency(sessionConcurrency: number): number {
  return Math.max(
    1,
    Math.min(sessionConcurrency, config.verification.maxConcurrency)
  );
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

  await acquireHostSlot(rateLimitHostKey(target), verificationRateLimit());

  // checkSampleUrl never throws — failures come back classified
  // (timeout/ssl_cert/no_response), which is what we want persisted.
  return checkSampleUrl(baseUrl, path, sourceUrl, userAgent, logger, context);
}
