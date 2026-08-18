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
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  // A 403 is escalation-ELIGIBLE, not reclassified: it earns a second attempt with
  // the browser profile, and when that is refused too the honest verdict is still
  // "failure". Reclassifying it as "blocked" would hide genuinely forbidden pages.
  assert.equal(result.r.httpStatusCategory, "failure");
  assert.equal(result.r.httpStatus, 403);
  assert.equal(result.r.usedFallbackProfile, true);
  assert.deepEqual(result.requests, ["HEAD /thing/one", "HEAD /thing/one"]);
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

test("a 404 DOES get a second attempt, and stays a failure when refused again", async () => {
  // The safety net is deliberately wide: anything not success/redirect/soft_404
  // earns one retry with a different profile, because a bot filter can answer with
  // any status. The label is what stays narrow — a 404 twice is still a failure,
  // never "blocked".
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(404);
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "failure");
  assert.equal(result.r.httpStatus, 404);
  assert.equal(result.r.usedFallbackProfile, true);
  // The documented cost: one extra request for a URL already headed for "broken".
  assert.deepEqual(result.requests, ["HEAD /thing/one", "HEAD /thing/one"]);
});

test("a 404 that the browser profile serves is recovered, not reported broken", async () => {
  // The reason the net is this wide: a bot filter that answers 404 to crawlers is
  // indistinguishable from a dead page on the first attempt.
  const result = await withServer(
    (_method, _url, res, headers) => {
      if (isBrowserProfile(headers!)) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("healthy fixture product page content. ".repeat(60));
        return;
      }

      res.writeHead(404);
      res.end();
    },
    (baseUrl) => check(baseUrl)
  );

  assert.equal(result.httpStatusCategory, "success");
  assert.equal(result.httpStatus, 200);
  assert.equal(result.usedFallbackProfile, true);
});

// --- the 403 escalation ------------------------------------------------------
// The production gap: this site family's WAF answers the honest crawler UA with a
// bare 403 — no x-amzn-waf-action header, and 403 is not method-rejection, so
// NEITHER "blocked" signal fires. Before this, the browser-profile retry could
// never run on the exact status the site actually returns.

test("a bare 403 escalates and the fallback's real status wins", async () => {
  const result = await withServer(
    (_method, _url, res, headers) => {
      if (isBrowserProfile(headers!)) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("healthy fixture product page content. ".repeat(60));
        return;
      }

      // No WAF header, no 405 — the measured signature of this site's block.
      res.writeHead(403);
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "success");
  assert.equal(result.r.httpStatus, 200);
  assert.equal(result.r.usedFallbackProfile, true);
  // HEAD(403) on the primary, then the fallback's full check: HEAD + soft-404 GET.
  assert.deepEqual(result.requests, [
    "HEAD /thing/one",
    "HEAD /thing/one",
    "GET /thing/one"
  ]);
});

test("a 403 that the fallback answers with a redirect adopts the redirect", async () => {
  const result = await withServer(
    (_method, url, res, headers) => {
      if (!isBrowserProfile(headers!)) {
        res.writeHead(403);
        res.end();
        return;
      }

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

  assert.equal(result.httpStatusCategory, "redirect");
  assert.equal(result.httpStatus, 301);
  assert.equal(result.usedFallbackProfile, true);
});

test("a confirmed block is NOT erased by a fallback that fails to connect", async () => {
  // THE GUARD ON isRealMeasurement. If the second attempt gets no answer at all, it
  // measured nothing — adopting its "failure" would turn a confirmed block back
  // into the false "Broken" that the blocked classification exists to prevent.
  const result = await withServer(
    (_method, _url, res, headers) => {
      if (isBrowserProfile(headers!)) {
        // No response at all: undici throws, so the fallback's httpStatus is null.
        res.socket?.destroy();
        return;
      }

      res.writeHead(403, { "x-amzn-waf-action": "captcha" });
      res.end();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "blocked");
  assert.equal(result.r.httpStatus, 403);
  assert.equal(result.r.usedFallbackProfile, true);
  assert.equal(result.requests.length, 2, JSON.stringify(result.requests));
});

test("401, 429 and 503 escalate ONCE and keep their real classification", async () => {
  // THE LABEL-OVERREACH GUARD. Every one of these gets the extra attempt, and not
  // one of them may come back "blocked": authentication, our own pacing and
  // availability are real answers about the URL. Two attempts is still the ceiling.
  for (const status of [401, 429, 503]) {
    const result = await withServer(
      (_method, _url, res) => {
        res.writeHead(status);
        res.end();
      },
      (baseUrl, counts) =>
        check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
    );

    assert.equal(result.r.httpStatusCategory, "failure", `status ${status}`);
    assert.equal(result.r.httpStatus, status, `status ${status}`);
    assert.equal(result.r.usedFallbackProfile, true, `status ${status}`);
    assert.deepEqual(
      result.requests,
      ["HEAD /thing/one", "HEAD /thing/one"],
      `status ${status}`
    );
  }
});

test("a transport failure escalates but cannot be relabelled as blocked", async () => {
  // No response at all on either profile: still a failure with a null status, and
  // exactly two attempts — a connection that never completes must not become
  // "blocked" (nothing observed a WAF) nor loop.
  const result = await withServer(
    (_method, _url, res) => {
      res.socket?.destroy();
    },
    (baseUrl, counts) =>
      check(baseUrl).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "failure");
  assert.equal(result.r.httpStatus, null);
  assert.equal(result.r.usedFallbackProfile, true);
  assert.equal(result.requests.length, 2, JSON.stringify(result.requests));
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

// --- the caller-supplied ladder (per-host strategy engine) -------------------
// The engine owns rung ordering; this module just executes a list in order and
// stops at the first real measurement. These cases pin that contract.

test("a caller-supplied ladder replaces the default pair", async () => {
  const seen: string[] = [];
  const result = await withServer(
    (_method, _url, res, headers) => {
      seen.push(String(headers!["user-agent"]));
      res.writeHead(200, { "content-type": "text/html" });
      res.end("healthy fixture product page content. ".repeat(60));
    },
    (baseUrl) =>
      checkSampleUrl(baseUrl, "/thing/one", null, UA, silentLogger, CONTEXT, {
        profileLadder: [BROWSER_FALLBACK_PROFILE]
      })
  );

  assert.equal(result.httpStatusCategory, "success");
  // The learned rung went out FIRST — the honest UA was never sent.
  assert.match(seen[0], /Chrome\//);
  assert.equal(
    seen.some((ua) => ua.includes("SitemapHealthChecker")),
    false
  );
});

test("a SINGLE-rung ladder does not escalate — a request saved, not a check weakened", async () => {
  // A host whose learned strategy is already the top rung has nothing to escalate
  // to. It must report the refusal after ONE attempt rather than repeating itself.
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403, { "x-amzn-waf-action": "block" });
      res.end();
    },
    (baseUrl, counts) =>
      checkSampleUrl(baseUrl, "/thing/one", null, UA, silentLogger, CONTEXT, {
        profileLadder: [BROWSER_FALLBACK_PROFILE]
      }).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "blocked");
  assert.equal(result.r.usedFallbackProfile, false);
  assert.deepEqual(result.requests, ["HEAD /thing/one"]);
});

test("a ladder whose second rung is identical to the first does not repeat it", async () => {
  // The guard against the original "reuse the primary UA as the fallback" mistake,
  // now that callers can supply the list.
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403);
      res.end();
    },
    (baseUrl, counts) =>
      checkSampleUrl(baseUrl, "/thing/one", null, UA, silentLogger, CONTEXT, {
        profileLadder: [
          { userAgent: UA, extraHeaders: {} },
          { userAgent: UA, extraHeaders: {} }
        ]
      }).then((r) => ({ r, requests: [...counts.requests] }))
  );

  assert.equal(result.r.httpStatusCategory, "failure");
  assert.deepEqual(result.requests, ["HEAD /thing/one"]);
});

test("a ladder is truncated to two attempts however long the caller's list is", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403);
      res.end();
    },
    (baseUrl, counts) =>
      checkSampleUrl(baseUrl, "/thing/one", null, UA, silentLogger, CONTEXT, {
        profileLadder: [
          { userAgent: "one", extraHeaders: {} },
          { userAgent: "two", extraHeaders: {} },
          { userAgent: "three", extraHeaders: {} },
          { userAgent: "four", extraHeaders: {} }
        ]
      }).then((r) => ({ r, requests: [...counts.requests] }))
  );

  // The two-attempt ceiling belongs to the checker, not to the caller's list.
  assert.equal(result.requests.length, 2, JSON.stringify(result.requests));
});

test("the Server header is captured for the strategy engine", async () => {
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(403, { server: "awselb/2.0" });
      res.end();
    },
    (baseUrl) => check(baseUrl)
  );

  // The one response header worth keeping: it separates "a load balancer refused
  // our IP" from "the origin itself said no", which need opposite responses.
  assert.equal(result.edgeServer, "awselb/2.0");
});

test("an allowH2 profile still works against an HTTP/1.1 origin", async () => {
  // The h2-enabled Agent must remain usable for ordinary h1 traffic — ALPN just
  // does not select h2. If this ever throws, the second transport variant is
  // unusable and every host that negotiates it would report a transport failure.
  const result = await withServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("healthy fixture product page content. ".repeat(60));
    },
    (baseUrl) =>
      checkSampleUrl(baseUrl, "/thing/one", null, UA, silentLogger, CONTEXT, {
        profileLadder: [{ ...BROWSER_FALLBACK_PROFILE, allowH2: true }]
      })
  );

  assert.equal(result.httpStatusCategory, "success");
  assert.equal(result.httpStatus, 200);
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

// --- the reported production case: bare root "/" ----------------------------
// Session da912958, pattern "/" (total_urls 1) persisted http_status 405 /
// category 'blocked' AFTER the retry shipped, while the same site's
// /product/{param} scored GOOD. Devops then proved from the same box that the
// honest UA gets 403 and the full browser profile gets 200 on that exact URL.
//
// This reproduces the site's measured behaviour exactly — 405 to the honest UA on
// BOTH HEAD and GET (so the pre-existing method-rejection re-probe fires first and
// still fails, which is what makes it "blocked"), 200 to the browser profile — at
// path "/" specifically, because a bare root is the one path shape a parameterised
// product URL never exercises.

test("bare root '/' recovers via the fallback exactly as a deep path does", async () => {
  const result = await withServer(
    (_method, url, res, headers) => {
      assert.equal(url, "/", `expected the bare root, got ${url}`);

      if (isBrowserProfile(headers!)) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("healthy fixture home page content. ".repeat(60));
        return;
      }

      // Honest UA: 405 on HEAD *and* GET, the measured signature.
      res.writeHead(405);
      res.end();
    },
    (baseUrl, counts) =>
      checkSampleUrl(baseUrl, "/", null, UA, silentLogger, CONTEXT).then((r) => ({
        r,
        requests: [...counts.requests]
      }))
  );

  // If the retry does NOT fire for the root, this is 'blocked' and the production
  // symptom is reproduced locally — a code bug, not an environment difference.
  assert.equal(
    result.r.httpStatusCategory,
    "success",
    `root did not recover; requests were ${JSON.stringify(result.requests)}`
  );
  assert.equal(result.r.httpStatus, 200);
  assert.equal(result.r.usedFallbackProfile, true);
  // HEAD(405) + GET(405) on the primary, then HEAD + soft-404 GET on the fallback.
  assert.equal(result.requests.length, 4, JSON.stringify(result.requests));
});

test("bare root '/' with a trailing-slash base URL still probes exactly '/'", async () => {
  // Guards the URL-construction edge case: no double slash, no empty path.
  const result = await withServer(
    (_method, url, res) => {
      assert.equal(url, "/");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("healthy fixture home page content. ".repeat(60));
    },
    (baseUrl) =>
      checkSampleUrl(`${baseUrl}/`, "/", null, UA, silentLogger, CONTEXT)
  );

  assert.equal(result.httpStatusCategory, "success");
});

// --- skipSoft404Sniff: the verification path's request cost -----------------
//
// THE PROBLEM IT SOLVES. Verification is rate-limited to 5 requests/second per
// host (config.ts, lowered from 50 after a confirmed AWS WAF captcha incident),
// and the limiter is charged PER REQUEST. A healthy URL cost two — a HEAD plus a
// 64KB ranged GET to sniff the body for not-found wording — so a healthy pattern
// ran at ~2.5 URLs/second and a 1.3M-URL pattern took days.
//
// The saving is only legitimate if the STORED verdict is unchanged, because
// delete-by-status acts on it. These tests assert both halves: one request, and
// the same http_status.

function checkWith(
  baseUrl: string,
  options: Parameters<typeof checkSampleUrl>[6],
  path = "/thing/one"
) {
  return checkSampleUrl(baseUrl, path, null, UA, silentLogger, CONTEXT, options);
}

const HEALTHY_BODY = "healthy fixture product page content. ".repeat(60);

test("a 2xx costs TWO requests by default — the sniff is still there", async () => {
  const { result, requests } = await withServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HEALTHY_BODY);
    },
    async (baseUrl, counts) => ({
      result: await checkWith(baseUrl, {}),
      requests: counts.requests
    })
  );

  assert.deepEqual(requests, ["HEAD /thing/one", "GET /thing/one"]);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.httpStatusCategory, "success");
});

test("skipSoft404Sniff makes a 2xx cost ONE request", async () => {
  const { result, requests } = await withServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HEALTHY_BODY);
    },
    async (baseUrl, counts) => ({
      result: await checkWith(baseUrl, { skipSoft404Sniff: true }),
      requests: counts.requests
    })
  );

  assert.deepEqual(requests, ["HEAD /thing/one"]);
  // The half that makes the saving safe: http_status is what delete-by-status
  // reads, and it comes from the HEAD either way.
  assert.equal(result.httpStatus, 200);
  assert.equal(result.httpStatusCategory, "success");
  assert.equal(result.isHit, true);
});

// A page that WOULD sniff as a soft 404 keeps its real HTTP status. It loses the
// soft_404 label, which is the documented trade: nothing reads
// verified_urls.http_status_category, and a soft 404 is HTTP 200, so it was
// never in a delete set to begin with.
test("a soft-404 body still reports its real 200 when the sniff is skipped", async () => {
  const softBody = "<html><body><h1>Page Not Found</h1></body></html>";

  const sniffed = await withServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(softBody);
    },
    (baseUrl) => checkWith(baseUrl, {})
  );

  const skipped = await withServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(softBody);
    },
    (baseUrl) => checkWith(baseUrl, { skipSoft404Sniff: true })
  );

  // Sniffing still works when it is asked for — sampling depends on this.
  assert.equal(sniffed.httpStatusCategory, "soft_404");
  assert.equal(sniffed.isSoft404, true);

  // Skipped: the status delete-by-status reads is IDENTICAL.
  assert.equal(skipped.httpStatus, sniffed.httpStatus);
  assert.equal(skipped.httpStatus, 200);
  assert.equal(skipped.isSoft404, false);
});

// The flag must not leak into the outcomes that are already one request, or into
// the ones that are not 2xx at all.
test("skipSoft404Sniff changes nothing about a 404 or a 301", async () => {
  const notFound = await withServer(
    (_method, _url, res) => {
      res.writeHead(404);
      res.end();
    },
    async (baseUrl, counts) => ({
      result: await checkWith(baseUrl, { skipSoft404Sniff: true }),
      requests: [...counts.requests]
    })
  );

  assert.equal(notFound.result.httpStatus, 404);
  assert.equal(notFound.result.httpStatusCategory, "failure");

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
    (baseUrl) =>
      checkWith(baseUrl, { skipSoft404Sniff: true, skipRedirectFollow: true })
  );

  assert.equal(moved.httpStatus, 301);
  assert.equal(moved.httpStatusCategory, "redirect");
  assert.match(moved.finalUrl ?? "", /\/thing\/two$/);
});
