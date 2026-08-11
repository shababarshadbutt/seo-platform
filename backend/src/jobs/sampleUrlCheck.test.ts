import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";

import { BROWSER_FALLBACK_PROFILE, checkSampleUrl } from "./sampleUrlCheck.js";
import { DEFAULT_HTTP_USER_AGENT } from "../config.js";

// Classification of WAF blocks vs genuine failures, against a real local HTTP
// server so the undici path, header reading and the HEAD->GET re-probe are all
// exercised rather than stubbed.
//
// No DB and no Redis: sampleUrlCheck imports only undici, the TLS dispatcher and
// the pure predicate modules, so this is a plain unit test with a socket.

type Handler = (
  method: string,
  url: string,
  res: import("node:http").ServerResponse,
  headers?: import("node:http").IncomingHttpHeaders
) => void;

async function withServer<T>(
  handler: Handler,
  body: (baseUrl: string, counts: { requests: string[] }) => Promise<T>
): Promise<T> {
  const counts = { requests: [] as string[] };
  const server: Server = createServer((req, res) => {
    counts.requests.push(`${req.method} ${req.url}`);
    handler(req.method ?? "GET", req.url ?? "/", res, req.headers);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  try {
    return await body(`http://127.0.0.1:${port}`, counts);
  } finally {
    server.close();
  }
}

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

const CONTEXT = {
  sessionId: "00000000-0000-0000-0000-000000000000",
  patternId: "00000000-0000-0000-0000-000000000001",
  template: "/thing/{param}",
  sampleIndex: 0
};

const UA = "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)";

function check(baseUrl: string, path = "/thing/one") {
  return checkSampleUrl(baseUrl, path, null, UA, silentLogger, CONTEXT);
}

// --- Signal 2: 405 that survives the GET re-probe ---------------------------
// The exact case measured on stackedindustrials.com across 8/8 patterns.

test("a 405 that survives the GET re-probe is BLOCKED, not a failure", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(405);
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
    );

  assert.equal(result.r.httpStatusCategory, "blocked");
  // The raw status is still persisted — an operator must be able to see the 405.
  assert.equal(result.r.httpStatus, 405);
  assert.equal(result.r.isHit, false);
  // HEAD + GET re-probe classifies as blocked, which then ESCALATES to the browser
  // profile and repeats the whole check: 4 requests. (Before the escalation landed
  // this asserted 2 — the retry legitimately changes it, and the count is asserted
  // precisely so that change had to be acknowledged rather than pass silently.)
  assert.equal(result.requests.length, 4, JSON.stringify(result.requests));
});

test("a 405 on HEAD that GET answers normally is NOT blocked", async () => {
  // This is what the re-probe was built for and must keep working: a host that
  // refuses HEAD but serves GET is a healthy page, not a block.
  const result = await withServer(
    (method, _url, res) => {
      if (method === "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "text/html" });
      res.end("healthy fixture product page content. ".repeat(60));
    },
    (baseUrl) => check(baseUrl)
  );

  assert.notEqual(result.httpStatusCategory, "blocked");
  assert.equal(result.httpStatus, 200);
});

// --- Signal 1: explicit WAF header -----------------------------------------

test("an explicit WAF header on the FIRST response is BLOCKED with no fallback", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403, { "x-amzn-waf-action": "captcha" });
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "blocked");
  assert.equal(result.r.httpStatus, 403);
  // 403 is not method-rejection, so no GET re-probe on either attempt — but the
  // block does escalate, so it is two HEADs rather than one.
  assert.deepEqual(result.requests, ["HEAD /thing/one", "HEAD /thing/one"]);
});

// --- THE NEGATIVE CONTROL --------------------------------------------------
// The one that matters most: this must not become an "anything inconvenient is
// blocked" switch. A genuine 403/404 with NEITHER signal stays a failure.

test("a genuine 403 with no WAF header stays FAILURE", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403);
      res.end();
    },
    (baseUrl) => check(baseUrl)
  );

  assert.equal(result.httpStatusCategory, "failure");
  assert.equal(result.httpStatus, 403);
});

test("a genuine 404 stays FAILURE", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(404);
      res.end();
    },
    (baseUrl) => check(baseUrl)
  );

  assert.equal(result.httpStatusCategory, "failure");
  assert.equal(result.httpStatus, 404);
});

test("a 500 stays FAILURE — server errors are real failures", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(500);
      res.end();
    },
    (baseUrl) => check(baseUrl)
  );

  assert.equal(result.httpStatusCategory, "failure");
});

// --- the other branches are untouched --------------------------------------

test("a 200 is still success and a 301 is still redirect", async () => {
  const ok = await withServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("healthy fixture product page content. ".repeat(60));
    },
    (baseUrl) => check(baseUrl)
  );

  assert.equal(ok.httpStatusCategory, "success");

  const moved = await withServer(
    (_method, url, res) => {
      if (url === "/thing/one") {
        res.writeHead(301, { location: "/thing/two" });
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "text/html" });
      res.end("ok");
    },
    (baseUrl) => check(baseUrl)
  );

  assert.equal(moved.httpStatusCategory, "redirect");
});

// --- the browser-profile retry ---------------------------------------------
// Only reached on a CONFIRMED block. Request COUNTS are asserted, not just
// outcomes — a count assertion is what catches an accidental recursion.

function isBrowserProfile(headers: import("node:http").IncomingHttpHeaders) {
  return headers["sec-fetch-mode"] === "navigate";
}

test("primary blocked + fallback succeeds -> fallback's real status wins", async () => {
  const result = await withServer(
    (_method, _url, res, headers) => {
      if (isBrowserProfile(headers!)) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("healthy fixture product page content. ".repeat(60));
        return;
      }

      // Honest crawler UA: blocked, exactly as measured on stackedindustrials.com.
      res.writeHead(403, { "x-amzn-waf-action": "captcha" });
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "success");
  assert.equal(result.r.httpStatus, 200);
  assert.equal(result.r.usedFallbackProfile, true);
  // HEAD (blocked) then the fallback's full check: HEAD + soft-404 GET.
  assert.deepEqual(result.requests, [
    "HEAD /thing/one",
    "HEAD /thing/one",
    "GET /thing/one"
  ]);
});

test("BOTH profiles blocked -> blocked, exactly two attempts, no recursion", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403, { "x-amzn-waf-action": "block" });
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "blocked");
  assert.equal(result.r.usedFallbackProfile, true);
  // THE RECURSION GUARD. 403 needs no GET re-probe, so a bounded run is exactly
  // two HEADs. An accidental retry-of-the-retry would show up here as 3+ (or hang)
  // rather than as a wrong category.
  assert.deepEqual(result.requests, ["HEAD /thing/one", "HEAD /thing/one"]);
});

test("both blocked via persistent 405 -> 4 requests, still bounded", async () => {
  // The worst case the cost note describes: HEAD + GET re-probe, twice.
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(405);
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "blocked");
  assert.equal(result.requests.length, 4, JSON.stringify(result.requests));
});

test("primary succeeds -> NO fallback attempt is made at all", async () => {
  // Zero extra cost in the common case. If a browser-profile request ever reaches
  // the server here, the escalation is firing when it should not.
  const result = await withServer(
    (_method, _url, res, headers) => {
      assert.equal(
        isBrowserProfile(headers!),
        false,
        "the fallback profile must never be used when the primary succeeds"
      );
      res.writeHead(200, { "content-type": "text/html" });
      res.end("healthy fixture product page content. ".repeat(60));
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "success");
  assert.equal(result.r.usedFallbackProfile, false);
  // HEAD + soft-404 GET only — one attempt.
  assert.deepEqual(result.requests, ["HEAD /thing/one", "GET /thing/one"]);
});

test("a genuine 404 does NOT trigger the fallback", async () => {
  // Escalation is gated on "blocked", not on "not 2xx". A real 404 must stay one
  // attempt, or every broken URL on every site doubles in cost.
  const result = await withServer(
    (_method, _url, res, headers) => {
      assert.equal(isBrowserProfile(headers!), false);
      res.writeHead(404);
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "failure");
  assert.equal(result.r.usedFallbackProfile, false);
  assert.deepEqual(result.requests, ["HEAD /thing/one"]);
});

test("the fallback profile sends all four Sec-Fetch headers and the Chrome UA", async () => {
  const seen: Array<Record<string, unknown>> = [];
  await withServer(
    (_method, _url, res, headers) => {
      seen.push({ ...headers });
      res.writeHead(403, { "x-amzn-waf-action": "captcha" });
      res.end();
    },
    (baseUrl) => check(baseUrl)
  );

  const fallback = seen[1];

  assert.equal(fallback["sec-fetch-mode"], "navigate");
  assert.equal(fallback["sec-fetch-site"], "none");
  assert.equal(fallback["sec-fetch-user"], "?1");
  assert.equal(fallback["sec-fetch-dest"], "document");
  assert.match(String(fallback["user-agent"]), /Chrome\//);
  // No Client Hints: version-tied to the UA and deliberately not added.
  assert.equal(fallback["sec-ch-ua"], undefined);
  // The base headers the checker controls are still present and not overridden.
  assert.match(String(fallback["accept"]), /text\/html/);
  assert.equal(fallback["accept-language"], "en-US,en;q=0.9");
});

test("the fallback UA is genuinely DIFFERENT from the primary one", () => {
  // THE GUARD FOR A REAL MISTAKE. The spec for this change said to reuse
  // config.ts's DEFAULT_HTTP_USER_AGENT as the fallback — but that constant is the
  // HONEST CRAWLER UA and is already the session default, i.e. the primary profile.
  // Reusing it would have made the retry byte-identical to the attempt that just
  // failed: same headers minus the Sec-Fetch set, same UA, guaranteed same result,
  // double the requests. An escalation that cannot escalate is worse than none.
  assert.notEqual(
    BROWSER_FALLBACK_PROFILE.userAgent,
    DEFAULT_HTTP_USER_AGENT,
    "the fallback profile must not reuse the primary/honest crawler UA"
  );
  assert.match(BROWSER_FALLBACK_PROFILE.userAgent, /Chrome\//);
  assert.match(DEFAULT_HTTP_USER_AGENT, /SitemapHealthChecker/);
});
