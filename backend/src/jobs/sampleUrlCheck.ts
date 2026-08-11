import { performance } from "node:perf_hooks";

import type { FastifyBaseLogger } from "fastify";
import { request } from "undici";

import { BROWSER_PROFILE_USER_AGENT } from "../config.js";
import { tlsAwareDispatcher } from "../http/tlsDispatcher.js";
import { SOFT_404_TEXT_SIGNALS } from "../sitemaps/softNotFound.js";
import { hasWafBlockHeader, isMethodRejectedStatus } from "./sampleHttpStatus.js";
import { resolveSampleTarget } from "./sampleTarget.js";

// The per-URL HTTP checker (HEAD, GET fallback on method rejection, soft-404
// sniff, redirect follow), extracted VERBATIM from samplePatternsJob.ts so the
// full-population verifier (verifyUrlsJob.ts) reuses the exact same probe as
// pattern sampling — one classifier, one vocabulary, no drift.
//
// Its own module for the same reason sampleHttpStatus.ts and sampleTarget.ts
// are: samplePatternsJob transitively pulls in sessionCompletion ->
// preGenerateZipQueue, which opens a BullMQ/Redis connection at module load, so
// anything importing the job (a verifier, a unit test) would hang the process.
// This module's imports are side-effect-free apart from the shared TLS
// dispatcher install.

// Short, stable codes describing WHY a sample got no HTTP status, persisted on
// the row so the results drawer can show an actionable message instead of a
// bare "No response". (v1.39 Fix 2)
export type SampleErrorReason = "ssl_cert" | "timeout" | "no_response";

// Classify a thrown request error. SSL-inspection proxies surface as a
// self-signed / untrusted-certificate error (message or the underlying
// error.code, e.g. SELF_SIGNED_CERT_IN_CHAIN); undici timeouts surface as
// UND_ERR_*_TIMEOUT or an AbortError from AbortSignal.timeout.
export function classifyRequestError(error: unknown): SampleErrorReason {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const codes = [
    (error as { code?: unknown })?.code,
    (error as { cause?: { code?: unknown } })?.cause?.code
  ]
    .filter((code): code is string => typeof code === "string")
    .join(" ");
  const haystack = `${message} ${codes}`.toLowerCase();

  if (
    haystack.includes("cert") ||
    haystack.includes("self-signed") ||
    haystack.includes("self signed") ||
    haystack.includes("ssl") ||
    haystack.includes("unable to verify")
  ) {
    return "ssl_cert";
  }

  if (
    haystack.includes("timeout") ||
    haystack.includes("timed out") ||
    haystack.includes("aborted") ||
    haystack.includes("aborterror")
  ) {
    return "timeout";
  }

  return "no_response";
}

const HTTP_TIMEOUT_MS = 5000;
const SOFT_404_BODY_SAMPLE_BYTES = 64 * 1024;
const SOFT_404_SHORT_BODY_BYTES = 1000;
// Only a status line is wanted from the method-rejection re-probe, so read just
// enough of the body to let the connection close cleanly and drop the rest.
const METHOD_FALLBACK_BODY_SAMPLE_BYTES = 8 * 1024;
// SOFT_404_TEXT_SIGNALS lives in sitemaps/softNotFound.js so the Fix Redirect
// URLs modal's destination check reuses the exact same vocabulary.

// "blocked" is NOT a kind of failure — it is the absence of a measurement. A
// blocked row means the site's security answered instead of the page, so its
// status code tells us nothing about whether the URL works. patternScore filters
// these out before scoring rather than averaging them in as zeros.
export type HttpStatusCategory =
  | "success"
  | "redirect"
  | "failure"
  | "soft_404"
  | "blocked";

// How a request identifies itself. A profile rather than a bare UA string because
// the two strategies below differ by HEADERS as well as user-agent, and passing
// them separately through four call sites is how they drift apart.
export type RequestProfile = {
  userAgent: string;
  extraHeaders?: Record<string, string>;
};

// The escalation profile, tried ONLY after the primary one is confirmed blocked.
//
// WHY THERE IS NO SINGLE CORRECT UA. Migration 032 documented the opposite
// finding on a DIFFERENT site in this same family: a browser UA arriving without a
// matching browser fingerprint tripped AWS WAF Bot Control into a CAPTCHA, and the
// honest crawler UA passed. On stackedindustrials.com devops measured the reverse
// — the honest UA is blocked 403/405, and this Chrome UA plus Sec-Fetch-* returns
// clean 200s. Both observations are real. Across 650+ sites there is no winner to
// pick, so the primary strategy is left completely unchanged (nothing that works
// today can regress) and this is only reached on a confirmed block.
//
// NOT DEFAULT_HTTP_USER_AGENT. That constant is the HONEST CRAWLER UA
// ("...compatible; SitemapHealthChecker/1.0"), which is the session default and
// therefore already the PRIMARY profile — using it here would make the retry
// byte-identical to the attempt that just failed, doubling request cost while
// changing nothing. config.ts's BROWSER_PROFILE_USER_AGENT is the Chrome string,
// kept there so both UAs and the reason they differ live in one place.
//
// Sec-Fetch-* only. Deliberately NO sec-ch-ua Client Hints: those are version-tied
// to the UA string and become a maintenance burden to keep consistent, and they
// were not what was proven to matter here.
export const BROWSER_FALLBACK_PROFILE: RequestProfile = {
  userAgent: BROWSER_PROFILE_USER_AGENT,
  extraHeaders: {
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "sec-fetch-dest": "document"
  }
};

// Base headers first, profile extras second. user-agent/accept/accept-language are
// re-applied AFTER the spread so extraHeaders can never override the three the
// checker controls — a profile is additive, not a rewrite.
function profileHeaders(
  profile: RequestProfile,
  extra?: Record<string, string>
): Record<string, string> {
  return {
    ...(profile.extraHeaders ?? {}),
    ...(extra ?? {}),
    "user-agent": profile.userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9"
  };
}

type HeadResult = {
  statusCode: number | null;
  responseMs: number;
  location: string | null;
  timedOut: boolean;
  errorReason: SampleErrorReason | null;
  // True when the response carried a header proving a WAF produced it. Both
  // probes discard headers apart from Location; this one is threaded through the
  // same way because it changes the VERDICT, not just the diagnostics.
  wafBlockHeaderDetected: boolean;
};

export type SampleCheckResult = {
  url: string;
  httpStatus: number | null;
  responseMs: number;
  isHit: boolean;
  isSoft404: boolean;
  finalUrl: string | null;
  redirectCount: number;
  httpStatusCategory: HttpStatusCategory;
  scoreWeight: number;
  timedOut: boolean;
  errorReason: SampleErrorReason | null;
  // True when this verdict came from the browser fallback profile rather than the
  // caller's own UA — the primary attempt was blocked and the retry ran. Persisted
  // so a pattern that NEEDED the fallback is distinguishable in the data from one
  // that never did: across 650+ sites, knowing which consistently require the
  // browser profile is useful, and nobody should re-derive it from logs.
  usedFallbackProfile: boolean;
};

type BodyPrefixResult = {
  text: string;
  bytesRead: number;
  wasTruncated: boolean;
};

type Soft404CheckResult = {
  isSoft404: boolean;
  responseMs: number;
  bodyBytesRead: number;
  matchedSignal: string | null;
  isShortBody: boolean;
  timedOut: boolean;
};

export type SampleLogContext = {
  sessionId: string;
  patternId: string;
  template: string;
  sampleIndex: number;
};

// Called immediately before EVERY outbound HTTP request this module makes.
//
// One "check" is not one request: a 2xx costs a HEAD plus a soft-404 GET, a 3xx
// costs a HEAD plus a follow-up HEAD, and only a hard 404 costs one. Metering a
// rate limit per CHECK therefore lets the real request rate reach ~2x the
// configured number — MEASURED at 49.17 req/s against a 25 req/s ceiling on a
// fast origin (bench/verifyThroughput.ts, 25ms latency, redirect-heavy mix).
// That was invisible at 300ms only because concurrency capped throughput first.
//
// The hook lets the caller charge its budget per REQUEST, which is the unit the
// target server actually experiences. Optional so pattern sampling — 5-20 URLs
// in one burst — keeps its existing unpaced behaviour.
export type BeforeRequestHook = () => Promise<void>;

export type SampleCheckOptions = {
  beforeRequest?: BeforeRequestHook;
  // Skip the follow-up HEAD on a 3xx destination (v1.52).
  //
  // WHAT IT ACTUALLY COSTS: nothing that is read. finalUrl is derived from the
  // FIRST response's Location header (resolveRedirectUrl), not from the
  // follow-up, and the follow-up's own status/location are discarded — its
  // result feeds `responseMs` alone. verified_urls does not persist responseMs,
  // and destination_not_found is a URL heuristic (looksLikeNotFoundUrl) applied
  // to the Location-derived value. So on the verification path this request was
  // pure waste, and dropping it halves the request cost of a redirect-heavy
  // pattern at identical output.
  //
  // Left OFF for pattern sampling, which stores response_ms per sampled URL and
  // whose 5-20 URLs per pattern make the saving irrelevant anyway.
  skipRedirectFollow?: boolean;
};

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

async function headOnce(
  url: string,
  profile: RequestProfile,
  beforeRequest?: BeforeRequestHook
): Promise<HeadResult> {
  const started = performance.now();

  try {
    await beforeRequest?.();

    const response = await request(url, {
      method: "HEAD",
      maxRedirections: 0,
      dispatcher: tlsAwareDispatcher,
      headers: profileHeaders(profile),
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });

    await response.body.text().catch(() => undefined);

    return {
      statusCode: response.statusCode,
      responseMs: Math.round(performance.now() - started),
      location: firstHeaderValue(response.headers.location),
      timedOut: false,
      errorReason: null,
      wafBlockHeaderDetected: hasWafBlockHeader(response.headers)
    };
  } catch (error) {
    return {
      statusCode: null,
      responseMs: Math.round(performance.now() - started),
      location: null,
      timedOut: true,
      errorReason: classifyRequestError(error),
      // No response at all, so no header to read — a transport failure is a
      // genuine failure, not a block.
      wafBlockHeaderDetected: false
    };
  }
}

async function readBodyPrefix(
  body: AsyncIterable<Buffer | Uint8Array | string> & { destroy?: () => void },
  maxBytes: number
): Promise<BodyPrefixResult> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let wasTruncated = false;

  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remainingBytes = maxBytes - bytesRead;

    if (buffer.length > remainingBytes) {
      chunks.push(buffer.subarray(0, remainingBytes));
      bytesRead += remainingBytes;
      wasTruncated = true;
      body.destroy?.();
      break;
    }

    chunks.push(buffer);
    bytesRead += buffer.length;

    if (bytesRead >= maxBytes) {
      wasTruncated = true;
      body.destroy?.();
      break;
    }
  }

  return {
    text: Buffer.concat(chunks, bytesRead).toString("utf8"),
    bytesRead,
    wasTruncated
  };
}

// Same probe as headOnce but with GET, used only when HEAD was method-rejected.
// Returns the identical shape so the caller's classification is unchanged — the
// point is to get a TRUSTWORTHY status for the same URL, not to branch anywhere
// new.
async function getStatusOnce(
  url: string,
  profile: RequestProfile,
  beforeRequest?: BeforeRequestHook
): Promise<HeadResult> {
  const started = performance.now();

  try {
    await beforeRequest?.();

    const response = await request(url, {
      method: "GET",
      maxRedirections: 0,
      dispatcher: tlsAwareDispatcher,
      headers: profileHeaders(profile, { "accept-encoding": "identity" }),
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });

    // No Range header here, unlike the soft-404 probe: a ranged request can
    // legitimately answer 206, which would then have to be un-picked from a real
    // 200 before classifying. readBodyPrefix destroys the stream once it has its
    // prefix, so a large page still isn't downloaded in full.
    await readBodyPrefix(
      response.body,
      METHOD_FALLBACK_BODY_SAMPLE_BYTES
    ).catch(() => undefined);

    return {
      statusCode: response.statusCode,
      responseMs: Math.round(performance.now() - started),
      location: firstHeaderValue(response.headers.location),
      timedOut: false,
      errorReason: null,
      wafBlockHeaderDetected: hasWafBlockHeader(response.headers)
    };
  } catch (error) {
    return {
      statusCode: null,
      responseMs: Math.round(performance.now() - started),
      location: null,
      timedOut: true,
      errorReason: classifyRequestError(error),
      // No response at all, so no header to read — a transport failure is a
      // genuine failure, not a block.
      wafBlockHeaderDetected: false
    };
  }
}

async function checkSoft404Signals(
  url: string,
  profile: RequestProfile,
  beforeRequest?: BeforeRequestHook
): Promise<Soft404CheckResult> {
  const started = performance.now();

  try {
    await beforeRequest?.();

    const response = await request(url, {
      method: "GET",
      maxRedirections: 0,
      dispatcher: tlsAwareDispatcher,
      headers: profileHeaders(profile, {
        "accept-encoding": "identity",
        range: `bytes=0-${SOFT_404_BODY_SAMPLE_BYTES - 1}`
      }),
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    });
    const bodyPrefix = await readBodyPrefix(
      response.body,
      SOFT_404_BODY_SAMPLE_BYTES
    );
    const lowerBody = bodyPrefix.text.toLowerCase();
    const matchedSignal =
      SOFT_404_TEXT_SIGNALS.find((signal) => lowerBody.includes(signal)) ??
      null;
    const isShortBody =
      !bodyPrefix.wasTruncated && bodyPrefix.bytesRead < SOFT_404_SHORT_BODY_BYTES;

    return {
      isSoft404: isShortBody || Boolean(matchedSignal),
      responseMs: Math.round(performance.now() - started),
      bodyBytesRead: bodyPrefix.bytesRead,
      matchedSignal,
      isShortBody,
      timedOut: false
    };
  } catch {
    return {
      isSoft404: false,
      responseMs: Math.round(performance.now() - started),
      bodyBytesRead: 0,
      matchedSignal: null,
      isShortBody: false,
      timedOut: true
    };
  }
}

function isRedirectStatus(statusCode: number | null): statusCode is number {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 307 ||
    statusCode === 308
  );
}

function resolveRedirectUrl(location: string | null, sourceUrl: string) {
  if (!location) {
    return null;
  }

  try {
    return new URL(location, sourceUrl).toString();
  } catch {
    return null;
  }
}

// ONE attempt, with ONE profile: HEAD, the method-rejection GET re-probe, the
// soft-404 sniff and the redirect follow — the whole check.
//
// This function contains NO retry logic, which is what makes the recursion guard
// structural rather than a flag: checkSampleUrl below is the only place that can
// start a second attempt, and it never calls itself. There is no code path from
// here back into a retry.
async function runCheckWithProfile(
  url: string,
  profile: RequestProfile,
  logger: FastifyBaseLogger,
  logContext: Record<string, unknown>,
  options: SampleCheckOptions
): Promise<SampleCheckResult> {
  const { beforeRequest, skipRedirectFollow = false } = options;

  logger.info(logContext, "sample url HEAD request started");

  let firstResult = await headOnce(url, profile, beforeRequest);
  let methodFallbackFrom: number | null = null;

  // HEAD refused for being HEAD: re-probe with GET and classify on THAT, so the
  // page is judged on whether it actually serves, not on which verb we happened
  // to send. If GET is refused too, the failure is genuine and stands.
  if (isMethodRejectedStatus(firstResult.statusCode)) {
    methodFallbackFrom = firstResult.statusCode;
    logger.info(
      { ...logContext, head_status: firstResult.statusCode },
      "sample url HEAD method-rejected, re-probing with GET"
    );

    const getResult = await getStatusOnce(url, profile, beforeRequest);

    firstResult = {
      ...getResult,
      // Keep the total honest: both probes were paid for.
      responseMs: firstResult.responseMs + getResult.responseMs
    };
  }

  let result: SampleCheckResult;

  if (firstResult.statusCode && firstResult.statusCode >= 200 && firstResult.statusCode <= 299) {
    logger.info(logContext, "sample url soft-404 GET check started");

    const soft404Result = await checkSoft404Signals(
      url,
      profile,
      beforeRequest
    );

    logger.info(
      {
        ...logContext,
        is_soft_404: soft404Result.isSoft404,
        soft_404_matched_signal: soft404Result.matchedSignal,
        soft_404_short_body: soft404Result.isShortBody,
        soft_404_body_bytes_read: soft404Result.bodyBytesRead,
        soft_404_response_ms: soft404Result.responseMs,
        soft_404_timed_out: soft404Result.timedOut
      },
      "sample url soft-404 GET check completed"
    );

    result = {
      url,
      httpStatus: firstResult.statusCode,
      responseMs: firstResult.responseMs + soft404Result.responseMs,
      isHit: true,
      isSoft404: soft404Result.isSoft404,
      finalUrl: null,
      redirectCount: 0,
      httpStatusCategory: soft404Result.isSoft404 ? "soft_404" : "success",
      scoreWeight: soft404Result.isSoft404 ? 0.25 : 1,
      timedOut: firstResult.timedOut || soft404Result.timedOut,
      errorReason: null,
      // The runner does not know about escalation; checkSampleUrl overrides this
      // when a verdict came from the fallback attempt.
      usedFallbackProfile: false
    };
  } else if (isRedirectStatus(firstResult.statusCode)) {
    const finalUrl = resolveRedirectUrl(firstResult.location, url);
    let responseMs = firstResult.responseMs;

    if (finalUrl && !skipRedirectFollow) {
      const followResult = await headOnce(finalUrl, profile, beforeRequest);

      responseMs += followResult.responseMs;
    }

    result = {
      url,
      httpStatus: firstResult.statusCode,
      responseMs,
      isHit: true,
      isSoft404: false,
      finalUrl,
      redirectCount: 1,
      httpStatusCategory: "redirect",
      scoreWeight: 0.5,
      timedOut: firstResult.timedOut,
      errorReason: null,
      usedFallbackProfile: false
    };
  } else {
    // BLOCKED vs FAILURE. Two high-confidence signals only — no vendor guessing,
    // and deliberately no "403 with a small body" heuristic, which would hide
    // genuinely forbidden pages behind "blocked".
    //
    // Signal 1: the response carried an explicit WAF header, so a WAF produced it
    // rather than the origin.
    //
    // Signal 2: HEAD was method-rejected AND the GET re-probe came back
    // method-rejected too. The re-probe exists because "WAFs and inspection
    // proxies refuse HEAD while serving GET perfectly well"; that code path then
    // treated a rejected GET as a genuine failure. It is not — a real page
    // refusing GET is essentially unheard of, and this is exactly what was
    // measured across 8/8 patterns on a live, working site.
    const stillRejectedAfterFallback =
      methodFallbackFrom !== null &&
      isMethodRejectedStatus(firstResult.statusCode);
    const blocked =
      firstResult.wafBlockHeaderDetected || stillRejectedAfterFallback;

    result = {
      url,
      httpStatus: firstResult.statusCode,
      responseMs: firstResult.responseMs,
      isHit: false,
      isSoft404: false,
      finalUrl: null,
      redirectCount: 0,
      httpStatusCategory: blocked ? "blocked" : "failure",
      // Irrelevant for a blocked row — patternScore filters those out before any
      // averaging — but 0 keeps it from ever counting if that filter is bypassed.
      scoreWeight: 0,
      timedOut: firstResult.timedOut,
      // httpStatus and errorReason stay exactly as observed: an operator looking
      // at sampled_urls must still see the raw 403/405. Only the pattern-level
      // verdict changes.
      errorReason: firstResult.errorReason,
      usedFallbackProfile: false
    };
  }

  logger.info(
    {
      ...logContext,
      http_status: result.httpStatus,
      http_status_category: result.httpStatusCategory,
      is_hit: result.isHit,
      is_soft_404: result.isSoft404,
      final_url: result.finalUrl,
      redirect_count: result.redirectCount,
      response_ms: result.responseMs,
      timed_out: result.timedOut,
      // Non-null when HEAD was method-rejected and the verdict came from the GET
      // re-probe instead — makes the fallback auditable in the logs rather than
      // silently changing what a status means.
      method_fallback_from: methodFallbackFrom,
      user_agent: profile.userAgent
    },
    "sample url HEAD request completed"
  );

  return {
    ...result
  };
}

// WHICH RESULTS EARN A SECOND ATTEMPT: any outcome that is not a clean answer.
//
// WHEN WE RETRY IS DECOUPLED FROM HOW WE LABEL. The retry used to fire only on a
// result already classified "blocked", which needs one of two narrow signals: an
// explicit WAF header, or a 405/501 that survived the GET re-probe
// (isMethodRejectedStatus is 405/501 only, deliberately). Production then produced
// the case neither signal covers — devops measured this site family answering the
// honest crawler UA with a plain 403, no x-amzn-waf-action header, and 403 is not
// method-rejection so it never even reached the GET re-probe. It classified as
// "failure" (status BAD, "Broken") and the browser-profile escalation was
// UNREACHABLE for the exact status the WAF actually returns. On any origin that
// blocks with 403 rather than 405, the whole feature was dead code.
//
// The fix is NOT to widen what counts as "blocked". A 403 can be a genuinely,
// correctly forbidden page, and relabelling unexplained 403s as "no measurement"
// would hide real access-control failures in the bucket built for WAF noise —
// exactly the overreach avoided when that classification was designed (no
// "403 + small body" heuristic, on purpose). So the classification below is
// untouched: it still keys on the same two signals, and a 403 that is refused
// twice is still reported as a failure.
//
// What widens is only the SAFETY NET: try harder before calling a page broken.
// Anything that is not success / redirect / soft_404 gets one more attempt with a
// different profile, whether the first attempt was "blocked" or "failure".
//
// COST: one extra request per URL that was ALREADY going to be reported as broken,
// paced by the same per-host limiter — a 404 costs one HEAD, so it becomes two.
// That is a real doubling on 404-heavy full verifications, and it is the price of
// not calling a live page broken because a bot filter answered for it.
function isEscalationEligible(result: SampleCheckResult): boolean {
  return (
    result.httpStatusCategory === "failure" ||
    result.httpStatusCategory === "blocked"
  );
}

// Is the second attempt's answer worth BELIEVING over the first one?
//
// Only when it is a clean answer — success, redirect or soft_404. Anything else
// and the PRIMARY observation stands, which is what keeps this a safety net rather
// than a reclassification: a confirmed block stays "blocked", a real 403 stays
// "failure", and a fallback that merely TIMED OUT cannot overwrite either with a
// transport error (the false "Broken" the blocked category exists to prevent).
function isRealMeasurement(result: SampleCheckResult): boolean {
  return !isEscalationEligible(result);
}

// The public checker. Callers still pass a bare session user_agent — nothing about
// how samplePatternsJob or verifyProbe call this changed.
//
// TWO ATTEMPTS, MAXIMUM. The primary profile is the caller's UA with no extra
// headers, i.e. exactly today's behaviour, so a URL that answers cleanly pays
// nothing and cannot regress. Any non-clean outcome escalates to
// BROWSER_FALLBACK_PROFILE once (see isEscalationEligible), and the second attempt
// is the full check again (its own HEAD, GET re-probe and soft-404 sniff) rather
// than a half-check.
//
// COST. Clean URLs: unchanged. A URL that would be reported broken: one extra
// request (or two, if HEAD is method-rejected on the retry as well) — and every one
// still goes through the same beforeRequest hook, so the per-host rate limiter paces
// the retry identically.
export async function checkSampleUrl(
  baseUrl: string,
  samplePath: string,
  sampleSourceUrl: string | null,
  userAgent: string,
  logger: FastifyBaseLogger,
  context: SampleLogContext,
  options: SampleCheckOptions = {}
): Promise<SampleCheckResult> {
  const url = resolveSampleTarget(baseUrl, samplePath, sampleSourceUrl);
  const logContext = {
    session_id: context.sessionId,
    pattern_id: context.patternId,
    template: context.template,
    sample_index: context.sampleIndex,
    url
  };

  const primary: RequestProfile = { userAgent, extraHeaders: {} };
  const primaryResult = await runCheckWithProfile(
    url,
    primary,
    logger,
    logContext,
    options
  );

  if (!isEscalationEligible(primaryResult)) {
    return primaryResult;
  }

  logger.info(
    {
      ...logContext,
      blocked_status: primaryResult.httpStatus,
      blocked_category: primaryResult.httpStatusCategory
    },
    "sample url refused on the primary profile, retrying with the browser profile"
  );

  const fallbackResult = await runCheckWithProfile(
    url,
    BROWSER_FALLBACK_PROFILE,
    logger,
    { ...logContext, profile: "browser-fallback" },
    options
  );

  // The fallback measured the page, so THAT is the truth about this URL.
  if (isRealMeasurement(fallbackResult)) {
    logger.info(
      {
        ...logContext,
        recovered_status: fallbackResult.httpStatus,
        recovered_category: fallbackResult.httpStatusCategory
      },
      "sample url recovered with the browser fallback profile"
    );

    return { ...fallbackResult, usedFallbackProfile: true };
  }

  // Refused on both profiles: the PRIMARY observation stands (a confirmed block
  // stays "blocked"; a real 403 stays "failure"), flagged so the data records that
  // the escalation was attempted. Two attempts is the ceiling — there is no third
  // profile and no loop.
  return { ...primaryResult, usedFallbackProfile: true };
}
