import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";

import { checkSampleUrl } from "./sampleUrlCheck.js";

// The 2.0 mode, against TWO real local servers standing in for production and
// staging. Two servers rather than a stub because the whole point of the feature
// is WHICH SOCKET the bytes go to, and a stubbed dispatcher cannot fail the way
// this is meant to fail: the production server here records every request it
// receives, so "did a staging run touch production?" is an assertion, not a
// reading of the code.
//
// No DB and no Redis — sampleUrlCheck imports only undici, the TLS dispatcher and
// the pure predicate modules.

type Handler = (
  method: string,
  url: string,
  res: import("node:http").ServerResponse
) => void;

type Recorder = { origin: string; requests: string[]; close: () => void };

async function startServer(handler: Handler): Promise<Recorder> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req.method ?? "GET", req.url ?? "/", res);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => server.close()
  };
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

// THE CORE CLAIM: the bytes go to staging, the stored identity stays production.
test("2.0 sends the request to staging and still reports the production URL", async () => {
  const prod = await startServer((_m, _u, res) => {
    res.writeHead(200);
    res.end();
  });
  const staging = await startServer((_m, _u, res) => {
    res.writeHead(404);
    res.end();
  });

  try {
    const result = await checkSampleUrl(
      prod.origin,
      "/thing/one",
      null,
      UA,
      silentLogger,
      CONTEXT,
      { stagingOrigin: staging.origin }
    );

    // The verdict came from STAGING (404), not from production (200). If the
    // staging swap silently did nothing this would be 200 and the test would fail
    // for the right reason.
    assert.equal(result.httpStatus, 404);
    // PRODUCTION NEVER HEARD FROM US.
    assert.deepEqual(prod.requests, []);
    assert.ok(staging.requests.length > 0);
    // And the stored identity is the production URL, because this string becomes
    // sampled_urls.url and gets matched against sitemap <loc> values.
    assert.equal(result.url, `${prod.origin}/thing/one`);
    assert.equal(result.checkedOnStaging, true);
  } finally {
    prod.close();
    staging.close();
  }
});

// THE NEGATIVE CONTROL. Same call, no staging origin: 1.90 behaviour, untouched.
test("1.90 sends the request to production and touches no staging host", async () => {
  const prod = await startServer((_m, _u, res) => {
    res.writeHead(200);
    res.end();
  });
  const staging = await startServer((_m, _u, res) => {
    res.writeHead(404);
    res.end();
  });

  try {
    const result = await checkSampleUrl(
      prod.origin,
      "/thing/one",
      null,
      UA,
      silentLogger,
      CONTEXT
    );

    assert.equal(result.httpStatus, 200);
    assert.deepEqual(staging.requests, []);
    assert.ok(prod.requests.length > 0);
    assert.equal(result.url, `${prod.origin}/thing/one`);
    assert.equal(result.checkedOnStaging, false);
  } finally {
    prod.close();
    staging.close();
  }
});

// THE SITEMAP-CORRUPTION GUARD.
//
// final_url is handed to applyRedirectsJob as the redirect destination WRITTEN
// INTO PRODUCTION SITEMAP <loc> VALUES. A staging origin answering with an
// absolute Location on its own host must come back wearing the production host,
// or "Apply redirects" writes a dev URL into the customer's sitemap.
test("an absolute staging redirect destination comes back on the production host", async () => {
  const prod = await startServer((_m, _u, res) => {
    res.writeHead(200);
    res.end();
  });
  let stagingOrigin = "";
  const staging = await startServer((_m, url, res) => {
    if (url === "/thing/one") {
      res.writeHead(301, { location: `${stagingOrigin}/thing/new` });
      res.end();

      return;
    }

    res.writeHead(200);
    res.end();
  });

  stagingOrigin = staging.origin;

  try {
    const result = await checkSampleUrl(
      prod.origin,
      "/thing/one",
      null,
      UA,
      silentLogger,
      CONTEXT,
      { stagingOrigin: staging.origin }
    );

    assert.equal(result.httpStatusCategory, "redirect");
    // THE ASSERTION THAT MATTERS: no staging host in the value that reaches a
    // sitemap file.
    assert.equal(result.finalUrl, `${prod.origin}/thing/new`);
    assert.ok(
      !result.finalUrl?.includes(new URL(staging.origin).port),
      `final_url leaked the staging origin: ${result.finalUrl}`
    );
    // And production was still never contacted -- including by the redirect
    // FOLLOW, which is the mirror-image bug: final_url is a production identity by
    // then, so following it verbatim would have gone straight to production.
    assert.deepEqual(prod.requests, []);
    // HEAD on /thing/one, then the followed HEAD on /thing/new -- both on staging.
    assert.deepEqual(staging.requests, [
      "HEAD /thing/one",
      "HEAD /thing/new"
    ]);
  } finally {
    prod.close();
    staging.close();
  }
});

// A genuine third-party destination is a real fact about where a visitor lands,
// not an artifact of how we asked, so it must survive verbatim.
test("a third-party redirect destination is left exactly as measured", async () => {
  const prod = await startServer((_m, _u, res) => {
    res.writeHead(200);
    res.end();
  });
  // Stands in for an external host. Never actually reached: it is only ever a
  // Location value here, and the follow goes to it directly.
  const external = await startServer((_m, _u, res) => {
    res.writeHead(200);
    res.end();
  });
  const staging = await startServer((_m, url, res) => {
    if (url === "/thing/one") {
      res.writeHead(301, { location: `${external.origin}/elsewhere` });
      res.end();

      return;
    }

    res.writeHead(200);
    res.end();
  });

  try {
    const result = await checkSampleUrl(
      prod.origin,
      "/thing/one",
      null,
      UA,
      silentLogger,
      CONTEXT,
      { stagingOrigin: staging.origin }
    );

    assert.equal(result.finalUrl, `${external.origin}/elsewhere`);
    // The external destination is followed on ITS OWN host, not re-staged.
    assert.deepEqual(external.requests, ["HEAD /elsewhere"]);
    assert.deepEqual(prod.requests, []);
  } finally {
    prod.close();
    external.close();
    staging.close();
  }
});

// A relative Location is resolved against the production identity already (that is
// pre-existing behaviour), so it must NOT pick up the staging host on the way.
test("a relative staging redirect resolves against the production identity", async () => {
  const prod = await startServer((_m, _u, res) => {
    res.writeHead(200);
    res.end();
  });
  const staging = await startServer((_m, url, res) => {
    if (url === "/thing/one") {
      res.writeHead(301, { location: "/thing/new" });
      res.end();

      return;
    }

    res.writeHead(200);
    res.end();
  });

  try {
    const result = await checkSampleUrl(
      prod.origin,
      "/thing/one",
      null,
      UA,
      silentLogger,
      CONTEXT,
      { stagingOrigin: staging.origin }
    );

    assert.equal(result.finalUrl, `${prod.origin}/thing/new`);
    assert.deepEqual(prod.requests, []);
  } finally {
    prod.close();
    staging.close();
  }
});
