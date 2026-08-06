import { performance } from "node:perf_hooks";

import type { FastifyBaseLogger } from "fastify";
import { request } from "undici";

import { tlsAwareDispatcher } from "../http/tlsDispatcher.js";
import { SOFT_404_TEXT_SIGNALS } from "../sitemaps/softNotFound.js";
import { isMethodRejectedStatus } from "./sampleHttpStatus.js";
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

export type HttpStatusCategory = "success" | "redirect" | "failure" | "soft_404";

type HeadResult = {
  statusCode: number | null;
  responseMs: number;
  location: string | null;
  timedOut: boolean;
  errorReason: SampleErrorReason | null;
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

function firstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

async function headOnce(url: string, userAgent: string): Promise<HeadResult> {
  const started = performance.now();

  try {
    const response = await request(url, {
      method: "HEAD",
      maxRedirections: 0,
      dispatcher: tlsAwareDispatcher,
      headers: {
        "user-agent": userAgent,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9"
      },
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
      errorReason: null
    };
  } catch (error) {
    return {
      statusCode: null,
      responseMs: Math.round(performance.now() - started),
      location: null,
      timedOut: true,
      errorReason: classifyRequestError(error)
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
  userAgent: string
): Promise<HeadResult> {
  const started = performance.now();

  try {
    const response = await request(url, {
      method: "GET",
      maxRedirections: 0,
      dispatcher: tlsAwareDispatcher,
      headers: {
        "user-agent": userAgent,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity"
      },
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
      errorReason: null
    };
  } catch (error) {
    return {
      statusCode: null,
      responseMs: Math.round(performance.now() - started),
      location: null,
      timedOut: true,
      errorReason: classifyRequestError(error)
    };
  }
}

async function checkSoft404Signals(
  url: string,
  userAgent: string
): Promise<Soft404CheckResult> {
  const started = performance.now();

  try {
    const response = await request(url, {
      method: "GET",
      maxRedirections: 0,
      dispatcher: tlsAwareDispatcher,
      headers: {
        "user-agent": userAgent,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "identity",
        range: `bytes=0-${SOFT_404_BODY_SAMPLE_BYTES - 1}`
      },
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

export async function checkSampleUrl(
  baseUrl: string,
  samplePath: string,
  sampleSourceUrl: string | null,
  userAgent: string,
  logger: FastifyBaseLogger,
  context: SampleLogContext
): Promise<SampleCheckResult> {
  const url = resolveSampleTarget(baseUrl, samplePath, sampleSourceUrl);
  const logContext = {
    session_id: context.sessionId,
    pattern_id: context.patternId,
    template: context.template,
    sample_index: context.sampleIndex,
    url
  };

  logger.info(logContext, "sample url HEAD request started");

  let firstResult = await headOnce(url, userAgent);
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

    const getResult = await getStatusOnce(url, userAgent);

    firstResult = {
      ...getResult,
      // Keep the total honest: both probes were paid for.
      responseMs: firstResult.responseMs + getResult.responseMs
    };
  }

  let result: SampleCheckResult;

  if (firstResult.statusCode && firstResult.statusCode >= 200 && firstResult.statusCode <= 299) {
    logger.info(logContext, "sample url soft-404 GET check started");

    const soft404Result = await checkSoft404Signals(url, userAgent);

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
      errorReason: null
    };
  } else if (isRedirectStatus(firstResult.statusCode)) {
    const finalUrl = resolveRedirectUrl(firstResult.location, url);
    let responseMs = firstResult.responseMs;

    if (finalUrl) {
      const followResult = await headOnce(finalUrl, userAgent);

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
      errorReason: null
    };
  } else {
    result = {
      url,
      httpStatus: firstResult.statusCode,
      responseMs: firstResult.responseMs,
      isHit: false,
      isSoft404: false,
      finalUrl: null,
      redirectCount: 0,
      httpStatusCategory: "failure",
      scoreWeight: 0,
      timedOut: firstResult.timedOut,
      errorReason: firstResult.errorReason
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
      method_fallback_from: methodFallbackFrom
    },
    "sample url HEAD request completed"
  );

  return {
    ...result
  };
}
