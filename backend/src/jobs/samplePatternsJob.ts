import { performance } from "node:perf_hooks";

import type { FastifyBaseLogger } from "fastify";
import { request } from "undici";

import { pool } from "../db/pool.js";
import { tlsAwareDispatcher } from "../http/tlsDispatcher.js";
import { isSessionCancelled, markSessionComplete } from "./sessionCompletion.js";

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
const SOFT_404_TEXT_SIGNALS = [
  "no entity selected",
  "page not found",
  "404",
  "not found",
  "no results",
  "no data found",
  "does not exist"
];

type SessionRow = {
  id: string;
  base_url: string;
  sample_size: number;
  concurrency: number;
  user_agent: string;
};

type PatternRow = {
  id: string;
  template: string;
  total_urls: string;
  source_file: string | null;
};

type PatternUrlRow = {
  id: string;
  path: string;
};

type HttpStatusCategory = "success" | "redirect" | "failure" | "soft_404";
type PatternStatus = "GOOD" | "WARNING" | "BAD";

type HeadResult = {
  statusCode: number | null;
  responseMs: number;
  location: string | null;
  timedOut: boolean;
  errorReason: SampleErrorReason | null;
};

type SampleCheckResult = {
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

type SampleLogContext = {
  sessionId: string;
  patternId: string;
  template: string;
  sampleIndex: number;
};

function targetUrlForPath(baseUrl: string, path: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

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

async function checkSampleUrl(
  baseUrl: string,
  samplePath: string,
  userAgent: string,
  logger: FastifyBaseLogger,
  context: SampleLogContext
): Promise<SampleCheckResult> {
  const url = targetUrlForPath(baseUrl, samplePath);
  const logContext = {
    session_id: context.sessionId,
    pattern_id: context.patternId,
    template: context.template,
    sample_index: context.sampleIndex,
    url
  };

  logger.info(logContext, "sample url HEAD request started");

  const firstResult = await headOnce(url, userAgent);
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
      timed_out: result.timedOut
    },
    "sample url HEAD request completed"
  );

  return {
    ...result
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;

      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(concurrency, 1), items.length);

  await Promise.all(
    Array.from(
      {
        length: workerCount
      },
      runWorker
    )
  );

  return results;
}

function patternStatusForConfidence(confidencePct: number): PatternStatus {
  if (confidencePct >= 80) {
    return "GOOD";
  }

  if (confidencePct >= 50) {
    return "WARNING";
  }

  return "BAD";
}

function calculatePatternScore(results: SampleCheckResult[]) {
  if (results.length === 0) {
    return {
      confidencePct: 0,
      redirectPct: 0,
      status: "BAD" as const
    };
  }

  const scoreTotal = results.reduce(
    (total, result) => total + result.scoreWeight,
    0
  );
  const redirectTotal = results.filter((result) => result.redirectCount > 0)
    .length;
  const confidencePct = Number(((scoreTotal / results.length) * 100).toFixed(2));
  const redirectPct = Number(((redirectTotal / results.length) * 100).toFixed(2));

  return {
    confidencePct,
    redirectPct,
    status: patternStatusForConfidence(confidencePct)
  };
}

async function loadSamplePool(patternId: string, sampleLimit: number) {
  if (sampleLimit <= 0) {
    return [];
  }

  const result = await pool.query<PatternUrlRow>(
    `
      SELECT id, path
      FROM pattern_urls
      WHERE pattern_id = $1
      ORDER BY random()
      LIMIT $2
    `,
    [patternId, sampleLimit]
  );

  return result.rows;
}

async function persistPatternSamples(
  patternId: string,
  results: SampleCheckResult[],
  sourceFile: string | null
) {
  const score = calculatePatternScore(results);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM sampled_urls WHERE pattern_id = $1", [
      patternId
    ]);

    for (const result of results) {
      await client.query(
        `
          INSERT INTO sampled_urls (
            pattern_id,
            url,
            http_status,
            response_ms,
            is_hit,
            is_soft_404,
            checked_at,
            final_url,
            redirect_count,
            http_status_category,
            source_file,
            error_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11)
        `,
        [
          patternId,
          result.url,
          result.httpStatus,
          result.responseMs,
          result.isHit,
          result.isSoft404,
          result.finalUrl,
          result.redirectCount,
          result.httpStatusCategory,
          sourceFile,
          result.errorReason
        ]
      );
    }

    await client.query(
      `
        UPDATE patterns
        SET
          confidence_pct = $2,
          redirect_pct = $3,
          status = $4
        WHERE id = $1
      `,
      [patternId, score.confidencePct, score.redirectPct, score.status]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return score;
}

async function patternAlreadySampled(patternId: string) {
  const result = await pool.query(
    "SELECT 1 FROM sampled_urls WHERE pattern_id = $1 LIMIT 1",
    [patternId]
  );

  return result.rowCount !== null && result.rowCount > 0;
}

// Mark every parsed, non-index file as sample-complete once sampling finishes.
// Sampling itself is pattern-scoped (sampled_urls key off pattern_id, not a
// file), so this is a coarse per-file checkpoint used by the resume endpoint to
// tell that the sample phase completed for the session. (v1.36 Fix 2)
async function markSampledFilesDone(sessionId: string) {
  await pool.query(
    `
      UPDATE sitemap_files
      SET sample_status = 'done'
      WHERE session_id = $1
        AND parsed_at IS NOT NULL
        AND is_index = FALSE
    `,
    [sessionId]
  );
}

export async function processSamplePatternsJob(
  data: { session_id: string; sitemap_file_id?: string; resume?: boolean },
  logger: FastifyBaseLogger
) {
  if (await isSessionCancelled(data.session_id)) {
    logger.info(
      { session_id: data.session_id },
      "sample patterns job skipped — session cancelled"
    );
    return;
  }

  const sessionResult = await pool.query<SessionRow>(
    `
      SELECT id, base_url, sample_size, concurrency, user_agent
      FROM sessions
      WHERE id = $1
    `,
    [data.session_id]
  );
  const session = sessionResult.rows[0];

  if (!session) {
    throw new Error(`Session not found: ${data.session_id}`);
  }

  logger.info(
    {
      session_id: data.session_id,
      sitemap_file_id: data.sitemap_file_id
    },
    "sample patterns job started"
  );

  await pool.query("UPDATE sessions SET status = 'SAMPLING' WHERE id = $1", [
    data.session_id
  ]);

  try {
    const patternsResult = await pool.query<PatternRow>(
      `
        SELECT id, template, total_urls, source_file
        FROM patterns
        WHERE session_id = $1
          AND source_role = 'current'
        ORDER BY total_urls DESC, template ASC
      `,
      [data.session_id]
    );
    let sampledUrlCount = 0;
    let skippedPatternCount = 0;

    for (const pattern of patternsResult.rows) {
      // On a resumed run, patterns that already have sampled URLs completed on a
      // previous pass — skip their (expensive, network-bound) re-sampling.
      if (data.resume && (await patternAlreadySampled(pattern.id))) {
        skippedPatternCount += 1;
        continue;
      }

      const totalUrls = Number(pattern.total_urls);
      const sampleLimit = Math.min(session.sample_size, totalUrls);
      const samplePool = await loadSamplePool(pattern.id, sampleLimit);
      const results = await mapWithConcurrency(
        samplePool,
        session.concurrency,
        (sample, index) =>
          checkSampleUrl(session.base_url, sample.path, session.user_agent, logger, {
            sessionId: data.session_id,
            patternId: pattern.id,
            template: pattern.template,
            sampleIndex: index
          })
      );
      const score = await persistPatternSamples(
        pattern.id,
        results,
        pattern.source_file
      );

      sampledUrlCount += results.length;

      if (results.length < sampleLimit) {
        logger.warn(
          {
            session_id: data.session_id,
            pattern_id: pattern.id,
            template: pattern.template,
            requested_sample_size: sampleLimit,
            actual_sample_size: results.length
          },
          "pattern sample pool smaller than requested sample size"
        );
      }

      logger.info(
        {
          session_id: data.session_id,
          pattern_id: pattern.id,
          template: pattern.template,
          sample_count: results.length,
          confidence_pct: score.confidencePct,
          redirect_pct: score.redirectPct,
          status: score.status
        },
        "pattern sampling completed"
      );
    }

    await markSampledFilesDone(data.session_id);
    await markSessionComplete(data.session_id);

    logger.info(
      {
        session_id: data.session_id,
        sitemap_file_id: data.sitemap_file_id,
        resume: Boolean(data.resume),
        pattern_count: patternsResult.rowCount,
        skipped_pattern_count: skippedPatternCount,
        sampled_url_count: sampledUrlCount
      },
      "sample patterns job completed"
    );
  } catch (error) {
    // Record the failure so the UI can offer a Resume that re-samples only the
    // patterns that never completed. (v1.36 Fix 2)
    await pool.query(
      "UPDATE sessions SET status = 'FAILED', last_failed_at = now() WHERE id = $1",
      [data.session_id]
    );
    throw error;
  }
}
