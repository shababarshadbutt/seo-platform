// Measure the ACTUAL throughput of a full-population verification against the
// 25 req/s design ceiling, and say which limit is really binding.
//
// The question this exists to answer: a 63,637-URL pattern reporting "Verifying
// 2,550 of 63,637" is slow — is that the rate limiter doing its job, or is
// something serialising?
//
// The arithmetic that makes this non-obvious:
//
//   throughput = min( rateLimit , concurrency / secondsPerCheck )
//
// One CHECK is not one request. checkSampleUrl sends a HEAD, then a SECOND
// request for most outcomes: a soft-404 GET when the answer is 2xx, or a
// follow-up HEAD when it is 3xx. Only a hard 404 costs one request. So on a
// pattern that is mostly 200s and 301s — which is exactly what a redirect-fix
// pattern looks like — a check costs two sequential round trips.
//
// With concurrency 8 and a 300ms origin, a two-request check takes ~600ms and
// the pool can only retire 8/0.6 = 13.3 checks/s. The 25/s rate limiter never
// even engages: CONCURRENCY is the binding constraint and the run goes at half
// the ceiling. That is a real, measurable difference from "the rate limit is
// what makes this slow", and the fix for each case is different.
//
// Usage:
//   npx tsx bench/verifyThroughput.ts [urls] [latencyMs] [mix]
//     mix: "redirect" (default, 70% 301 + 25% 200 + 5% 404 — a redirect-fix
//          pattern), "notfound" (90% 404, the cheap single-request case),
//          "healthy" (90% 200 — a large working catalogue, and the only mix that
//          can measure the soft-404 GET, since the other two are dominated by
//          single-request outcomes)
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { resetHostRateLimiter } from "../src/http/hostRateLimiter.js";
import { processVerifyUrlsJob } from "../src/jobs/verifyUrlsJob.js";

const urlCount = Number(process.argv[2] ?? 1500);
const latencyMs = Number(process.argv[3] ?? 300);
const mix = process.argv[4] ?? "redirect";

const OK_BODY = "healthy fixture product page content. ".repeat(60);

const silentLogger: any = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  }
};

function statusFor(index: number): number {
  if (mix === "notfound") {
    return index % 10 === 0 ? 200 : 404;
  }

  // 90% 200 — the shape of a large, mostly-working catalogue, and the ONLY mix
  // that shows what the soft-404 GET costs. Both other mixes are dominated by
  // single-request outcomes (a hard 404 always was one; a 3xx became one when
  // skipRedirectFollow landed in v1.52), so neither can measure it.
  if (mix === "healthy") {
    const bucket = index % 20;

    return bucket < 18 ? 200 : bucket < 19 ? 301 : 404;
  }

  const bucket = index % 20;

  // 70% 301, 25% 200, 5% 404 — two HTTP requests for 95% of checks.
  return bucket < 14 ? 301 : bucket < 19 ? 200 : 404;
}

async function main() {
  await mkdir(config.uploadDir, { recursive: true });

  let inFlight = 0;
  let maxInFlight = 0;
  let requestCount = 0;
  let firstAt = 0;
  let lastAt = 0;

  const server = createServer((req, res) => {
    inFlight += 1;
    requestCount += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    lastAt = Date.now();

    if (firstAt === 0) {
      firstAt = lastAt;
    }

    res.on("close", () => {
      inFlight -= 1;
    });

    const url = (req.url ?? "").split("?")[0];

    setTimeout(() => {
      if (url.startsWith("/moved/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(req.method === "HEAD" ? undefined : OK_BODY);
        return;
      }

      const match = url.match(/-(\d+)$/);
      const index = match ? Number(match[1]) : 0;
      const status = statusFor(index);

      if (status === 301) {
        res.writeHead(301, { location: `/moved/${index}` });
        res.end();
        return;
      }

      if (status === 200) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(req.method === "HEAD" ? undefined : OK_BODY);
        return;
      }

      res.writeHead(404);
      res.end();
    }, latencyMs);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('bench verify throughput', $1, 5, 10)
      RETURNING id
    `,
    [baseUrl]
  );
  const sessionId = sessionRow.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls)
      VALUES ($1, '/manufacturer/{param}/{param}', $2)
      RETURNING id
    `,
    [sessionId, urlCount]
  );
  const patternId = patternRow.rows[0].id;

  const locs = Array.from(
    { length: urlCount },
    (_, index) => `${baseUrl}/manufacturer/brand${index}-parts-catalog/item-${index}`
  );
  const stored = `${sessionId}-current.xml`;

  await writeFile(
    path.join(config.uploadDir, stored),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n") +
      "\n</urlset>\n",
    "utf8"
  );
  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, urlCount]
  );

  const jobRow = await pool.query<{ id: string }>(
    `
      INSERT INTO maintenance_jobs (session_id, kind, pattern_ids)
      VALUES ($1, 'verify-urls', $2::uuid[])
      RETURNING id
    `,
    [sessionId, [patternId]]
  );

  resetHostRateLimiter();

  const started = performance.now();

  await processVerifyUrlsJob(
    {
      session_id: sessionId,
      job_row_id: jobRow.rows[0].id,
      pattern_ids: [patternId],
      target_statuses: null
    },
    silentLogger
  );

  const elapsedMs = Math.round(performance.now() - started);
  const seconds = elapsedMs / 1000;
  const checksPerSecond = urlCount / seconds;
  const requestsPerSecond = requestCount / ((lastAt - firstAt) / 1000 || 1);
  const requestsPerCheck = requestCount / urlCount;

  const rateCeiling = config.verification.maxRequestsPerSecond;
  const concurrencyCap = config.verification.maxConcurrency;
  // What concurrency alone allows, given how long a check actually took.
  const secondsPerCheck = requestsPerCheck * (latencyMs / 1000);
  const concurrencyCeiling = concurrencyCap / secondsPerCheck;

  console.log(
    JSON.stringify(
      {
        urls: urlCount,
        origin_latency_ms: latencyMs,
        mix,
        elapsed_ms: elapsedMs,
        // The headline: what the run actually achieved.
        checks_per_second: Math.round(checksPerSecond * 100) / 100,
        http_requests: requestCount,
        requests_per_check: Math.round(requestsPerCheck * 100) / 100,
        requests_per_second: Math.round(requestsPerSecond * 100) / 100,
        max_in_flight: maxInFlight,
        configured_rate_ceiling: rateCeiling,
        configured_concurrency: concurrencyCap,
        // min(rate, concurrency/secondsPerCheck) — whichever is smaller is the
        // constraint actually in force.
        concurrency_ceiling_checks_per_second:
          Math.round(concurrencyCeiling * 100) / 100,
        binding_constraint:
          concurrencyCeiling < rateCeiling ? "CONCURRENCY" : "RATE_LIMIT",
        projected_minutes_for_63637:
          Math.round((63637 / checksPerSecond / 60) * 10) / 10
      },
      null,
      2
    )
  );

  server.close();
  await rm(path.join(config.uploadDir, stored), { force: true }).catch(() => {});
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
  await pool.end();
  process.exit(0);
}

void main();
