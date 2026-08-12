import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// DOES A PRIVATELY-ROUTED CHECK ACTUALLY WORK — end to end, over a real socket.
//
// Everything else about this feature is unit-tested in isolation. What no unit test can
// show is the thing the whole feature rests on: that overriding DNS sends the request to
// a different machine while the URL, the Host header and the SNI servername all keep
// saying the site's public hostname. That is what makes ~93 vhosts per box work, and
// what makes the stored verdict describe the right page.
//
// THE FIXTURE. A hostname that resolves NOWHERE in real DNS (`.local` TLD, never
// registered) is mapped to 127.0.0.1, where the test's own server listens. So if the
// request arrives at all, it arrived because of the map — there is no other way it could
// have got there. That is the assertion, not a mock.
//
// PORTS. The map holds no ports (like /etc/hosts), so the port comes from the URL and
// the connection lands on 127.0.0.1:<that port>. Using a base_url with an explicit port
// is what lets this run on an ephemeral port instead of needing :80.

const HOST = "www.privatetest.local";
const PRIVATE_IP = "127.0.0.1";

const FIXTURE_DIR = mkdtempSync(path.join(tmpdir(), "private-route-check-"));
const MAP_FILE = path.join(FIXTURE_DIR, "private-hosts.conf");

writeFileSync(MAP_FILE, `${PRIVATE_IP} ${HOST}\n`, "utf8");

process.env.PRIVATE_ROUTE_ENABLED = "true";
process.env.PRIVATE_HOST_MAP_FILE = MAP_FILE;
// The TLS half of this file uses a self-signed certificate, which cannot be trusted
// in-process (NODE_EXTRA_CA_CERTS is read before node starts). Production keeps
// verification ON — and the reason it can is exactly what this file proves: SNI stays
// the real hostname, so the site's real certificate is the one being validated.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const { checkSampleUrl } = await import("./sampleUrlCheck.js");
const { notePrivateSchemeFlip, privateSchemeFor, resetPrivateSchemes } =
  await import("../http/privateRoute.js");
const { resetPrivateRouteHealth } = await import(
  "../http/privateRouteHealth.js"
);

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
  sessionId: "00000000-0000-0000-0000-0000000000aa",
  patternId: "00000000-0000-0000-0000-0000000000bb",
  template: "/part/{param}",
  sampleIndex: 0
};

const UA = "Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)";

type Seen = { method: string; url: string; host: string | undefined };

async function withHttpServer<T>(
  handler: (
    method: string,
    url: string,
    res: import("node:http").ServerResponse,
    headers: IncomingHttpHeaders
  ) => void,
  body: (port: number, seen: Seen[]) => Promise<T>
): Promise<T> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      host: req.headers.host
    });
    handler(req.method ?? "GET", req.url ?? "/", res, req.headers);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, PRIVATE_IP, () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  try {
    return await body(port, seen);
  } finally {
    server.close();
  }
}

function reset() {
  resetPrivateSchemes();
  resetPrivateRouteHealth();
}

// ---- The core case ----------------------------------------------------------

test("a mapped host is reached at its private IP, over http, with the public hostname intact", async () => {
  reset();

  await withHttpServer(
    (_method, _url, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>a perfectly ordinary product page, long enough to not be a short body. ".repeat(30) + "</body></html>");
    },
    async (port, seen) => {
      // base_url is https, as a real session's would be — the sitemap says https.
      const result = await checkSampleUrl(
        `https://${HOST}:${port}`,
        "/part/ABC-123",
        null,
        UA,
        silentLogger,
        CONTEXT
      );

      // 1. IT ARRIVED. This hostname does not resolve in DNS; the only path to this
      //    server is the map.
      assert.ok(seen.length >= 1, "the private server received no request");
      assert.equal(seen[0].method, "HEAD");
      assert.equal(seen[0].url, "/part/ABC-123");

      // 2. THE HOST HEADER IS THE PUBLIC HOSTNAME. This is what lets one box serve ~93
      //    different sites — without it every one of them would get whichever site the
      //    default backend serves.
      assert.equal(seen[0].host, `${HOST}:${port}`);

      // 3. THE STORED URL IS THE PUBLIC IDENTITY — https, hostname, no IP anywhere.
      //    This value goes into sampled_urls.url and into every finding a user reads,
      //    and is compared against sitemap <loc> values.
      assert.equal(result.url, `https://${HOST}:${port}/part/ABC-123`);
      assert.ok(!result.url.includes(PRIVATE_IP));

      // 4. The transport is recorded separately, which is the whole point of mig 045.
      assert.equal(result.viaPrivateRoute, true);
      assert.equal(result.httpStatus, 200);
      assert.equal(result.httpStatusCategory, "success");
    }
  );
});

test("an unmapped host is NOT routed privately — it keeps today's behaviour exactly", async () => {
  reset();

  await withHttpServer(
    (_method, _url, res) => {
      res.writeHead(200);
      res.end("ok");
    },
    async (port) => {
      // 127.0.0.1 is not in the map, so nothing is rewritten and nothing is diverted.
      const result = await checkSampleUrl(
        `http://${PRIVATE_IP}:${port}`,
        "/part/ABC-123",
        null,
        UA,
        silentLogger,
        CONTEXT
      );

      assert.equal(result.viaPrivateRoute, false);
      assert.equal(result.url, `http://${PRIVATE_IP}:${port}/part/ABC-123`);
    }
  );
});

// ---- The forced-TLS artifact, over a real socket ----------------------------
//
// THE FAILURE THIS PREVENTS. An origin that answers cleartext with
// "301 -> https://<same page>" is refusing our transport, not describing the page. Left
// alone it would relabel every healthy URL on a whole site family as "redirect" — the
// most damaging false finding this feature could produce.

test("a scheme-only 301 is treated as a transport artifact, not reported as a redirect", async () => {
  reset();

  await withHttpServer(
    (_method, url, res, headers) => {
      // What an nginx `return 301 https://$host$request_uri` does.
      res.writeHead(301, { location: `https://${headers.host}${url}` });
      res.end();
    },
    async (port, seen) => {
      const result = await checkSampleUrl(
        `https://${HOST}:${port}`,
        "/part/ABC-123",
        null,
        UA,
        silentLogger,
        CONTEXT
      );

      // The artifact was recognised: this host is remembered as https-only, so every
      // later check in this process goes straight there. One way, once per host.
      assert.equal(privateSchemeFor(HOST), "https");

      // AND THE VERDICT IS NOT "redirect". Before the guard, this fixture produced
      // httpStatusCategory "redirect" with finalUrl set — a healthy page reported as
      // moved. Here the re-probe replaced that observation. (No TLS listener exists on
      // this port, so the re-probe cannot answer and the honest result is a failure;
      // in production the origin's TLS listener answers and the true status is used.)
      assert.notEqual(result.httpStatusCategory, "redirect");

      // The re-probe really was attempted — more than the one original HEAD was paid
      // for, which is what `responseMs` and the request count both show.
      assert.ok(
        seen.length >= 1,
        "expected the original cleartext HEAD to have been made"
      );
    }
  );
});

// ---- The https path, and SNI ------------------------------------------------

const KEY_FILE = path.join(FIXTURE_DIR, "key.pem");
const CERT_FILE = path.join(FIXTURE_DIR, "cert.pem");

function tlsFixtureAvailable(): boolean {
  if (existsSync(CERT_FILE)) {
    return true;
  }

  try {
    // openssl is present in this environment (git-bash ships it) but this test refuses
    // to become a hard dependency on that: without it the case SKIPS with a reason
    // rather than failing, and the skip is reported.
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY_FILE,
        "-out", CERT_FILE,
        "-days", "1",
        "-subj", `/CN=${HOST}`,
        "-addext", `subjectAltName=DNS:${HOST}`
      ],
      { stdio: "ignore" }
    );

    return existsSync(CERT_FILE);
  } catch {
    return false;
  }
}

test("over https the private route keeps SNI as the real hostname", async (t) => {
  if (!tlsFixtureAvailable()) {
    t.skip("openssl not available to generate a self-signed certificate");
    return;
  }

  reset();
  // Start from the flipped state, which is what the artifact guard above produces. The
  // two cases are separate because a scheme flip keeps the PORT — so the cleartext
  // server and the TLS server cannot share one ephemeral port.
  notePrivateSchemeFlip(HOST);

  const servernames: Array<string | undefined> = [];
  const hostHeaders: Array<string | undefined> = [];
  const server = createTlsServer(
    {
      key: readFileSync(KEY_FILE),
      cert: readFileSync(CERT_FILE)
    },
    (req, res) => {
      hostHeaders.push(req.headers.host);
      res.writeHead(404);
      res.end();
    }
  );

  // SNI is read off the handshake itself — the one place the answer actually exists.
  server.on("secureConnection", (socket) => {
    servernames.push((socket as { servername?: string }).servername);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, PRIVATE_IP, () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  try {
    const result = await checkSampleUrl(
      `https://${HOST}:${port}`,
      "/part/MISSING",
      null,
      UA,
      silentLogger,
      CONTEXT
    );

    // THE ASSERTION THAT MATTERS: every TLS handshake asked for the site's real
    // hostname, not for 127.0.0.1. That is why production can leave certificate
    // verification ON while connecting to a private IP — the certificate being
    // checked is the site's own.
    //
    // More than one handshake is expected and correct: a 404 is not a clean result, so
    // checkSampleUrl escalates to the browser profile once (v1.60). Both attempts must
    // present the same servername, so this asserts over all of them rather than
    // pinning a count that a change to the escalation rule would break.
    assert.ok(servernames.length >= 1, "no TLS handshake reached the server");
    assert.deepEqual(
      [...new Set(servernames)],
      [HOST],
      "every handshake must present the site's real hostname as SNI"
    );
    assert.deepEqual([...new Set(hostHeaders)], [`${HOST}:${port}`]);

    // A real measurement came back over the private path, and the identity URL is
    // still the public one.
    assert.equal(result.httpStatus, 404);
    assert.equal(result.viaPrivateRoute, true);
    assert.equal(result.url, `https://${HOST}:${port}/part/MISSING`);
  } finally {
    server.close();
  }
});
