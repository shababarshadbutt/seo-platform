import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";

import { checkSampleUrl } from "./sampleUrlCheck.js";

// Classification of WAF blocks vs genuine failures, against a real local HTTP
// server so the undici path, header reading and the HEAD->GET re-probe are all
// exercised rather than stubbed.
//
// No DB and no Redis: sampleUrlCheck imports only undici, the TLS dispatcher and
// the pure predicate modules, so this is a plain unit test with a socket.

type Handler = (
  method: string,
  url: string,
  res: import("node:http").ServerResponse
) => void;

async function withServer<T>(
  handler: Handler,
  body: (baseUrl: string, counts: { requests: string[] }) => Promise<T>
): Promise<T> {
  const counts = { requests: [] as string[] };
  const server: Server = createServer((req, res) => {
    counts.requests.push(`${req.method} ${req.url}`);
    handler(req.method ?? "GET", req.url ?? "/", res);
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
  // HEAD, then the GET re-probe: the classification is only reached after the
  // fallback also failed.
  assert.deepEqual(result.requests, ["HEAD /thing/one", "GET /thing/one"]);
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
  // 403 is not method-rejection, so no GET re-probe: one request only.
  assert.deepEqual(result.requests, ["HEAD /thing/one"]);
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
