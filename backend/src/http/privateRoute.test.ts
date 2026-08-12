import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// ITS OWN PROCESS, for the reason hostStrategyPinnedUa.test.ts documents: config.ts
// reads process.env at module load, so the flag and the map path have to be set before
// the first import of config. node:test gives each file its own process, and the imports
// below are dynamic so this assignment lands first.
const MAP_DIR = mkdtempSync(path.join(tmpdir(), "private-route-"));
const MAP_FILE = path.join(MAP_DIR, "private-hosts.conf");

writeFileSync(
  MAP_FILE,
  [
    "10.0.61.203 www.aeropartshub.com",
    "10.0.61.203 www.aeroworld360.com",
    "10.0.50.234 stackedindustrials.com",
    "10.0.50.234 www.stackedindustrials.com"
  ].join("\n"),
  "utf8"
);

process.env.PRIVATE_ROUTE_ENABLED = "true";
process.env.PRIVATE_HOST_MAP_FILE = MAP_FILE;
process.env.PRIVATE_HOST_MAP_RELOAD_SECONDS = "5";

const mod = await import("./privateRoute.js");
const health = await import("./privateRouteHealth.js");
const { config } = await import("../config.js");
const { rateLimitBucketFor, rateLimitHostKey } = await import(
  "./hostRateLimiter.js"
);
const { verifyConcurrency } = await import("../jobs/verifyProbe.js");

function reset() {
  mod.resetPrivateSchemes();
  health.resetPrivateRouteHealth();
}

test("precondition: the flag and map really are in effect", () => {
  assert.equal(config.privateRoute.enabled, true);
  assert.equal(config.privateRoute.mapFile, MAP_FILE);
  assert.equal(config.privateRoute.scheme, "http");
});

// THE CORE GUARANTEE. Only the scheme changes — because this URL is also the page's
// public identity: it is stored in sampled_urls.url, shown in findings, and compared
// against sitemap <loc> values.
test("applyPrivateRoute rewrites ONLY the scheme", () => {
  reset();

  const routed = mod.applyPrivateRoute(
    "https://www.aeropartshub.com/part/ABC-123?utm=x#frag"
  );

  assert.equal(routed.url, "http://www.aeropartshub.com/part/ABC-123?utm=x#frag");
  assert.equal(routed.route?.ip, "10.0.61.203");
  assert.equal(routed.route?.matchedVia, "exact");
});

test("an unmapped host is returned untouched, with no route", () => {
  reset();

  const routed = mod.applyPrivateRoute("https://www.not-in-the-map.com/x");

  assert.equal(routed.url, "https://www.not-in-the-map.com/x");
  assert.equal(routed.route, null);
});

test("a non-http(s) URL and an unparseable URL are both left alone", () => {
  reset();

  assert.equal(mod.privateRouteFor("mailto:someone@example.com"), null);
  assert.equal(mod.privateRouteFor("not a url at all"), null);
  assert.equal(mod.applyPrivateRoute("not a url at all").url, "not a url at all");
});

test("the www fallback routes a host listed under its other spelling", () => {
  reset();

  // The map has only www.aeropartshub.com.
  const routed = mod.applyPrivateRoute("https://aeropartshub.com/x");

  assert.equal(routed.url, "http://aeropartshub.com/x");
  assert.equal(routed.route?.matchedVia, "www-fallback");
});

// ---- The forced-TLS artifact ------------------------------------------------
//
// WHAT THIS PREVENTS: an origin that answers :80 with "301 -> https://<same page>" is
// declining our transport, not describing the page. Recorded as a redirect it would
// relabel every healthy URL on ~93 sites as "redirect".

test("isForcedTlsRedirect is true ONLY for a scheme-only redirect to the same page", () => {
  const from = "http://www.aeropartshub.com/part/ABC?x=1";

  assert.equal(
    mod.isForcedTlsRedirect(from, 301, "https://www.aeropartshub.com/part/ABC?x=1"),
    true
  );
  // 308 is the other permanent form.
  assert.equal(
    mod.isForcedTlsRedirect(from, 308, "https://www.aeropartshub.com/part/ABC?x=1"),
    true
  );
  // A relative Location resolves against the request URL and stays http — not a TLS
  // upgrade, so a real redirect.
  assert.equal(mod.isForcedTlsRedirect(from, 301, "/somewhere-else"), false);
});

test("a REAL redirect is never mistaken for the transport artifact", () => {
  const from = "http://www.aeropartshub.com/old-part";

  // Different path: a genuine redirect, and it must keep being reported as one.
  assert.equal(
    mod.isForcedTlsRedirect(from, 301, "https://www.aeropartshub.com/new-part"),
    false
  );
  // Different query.
  assert.equal(
    mod.isForcedTlsRedirect(
      "http://www.aeropartshub.com/p?a=1",
      301,
      "https://www.aeropartshub.com/p?a=2"
    ),
    false
  );
  // Different host — e.g. the apex-to-www redirect, a real finding.
  assert.equal(
    mod.isForcedTlsRedirect(from, 301, "https://www.somewhere-else.com/old-part"),
    false
  );
  // A temporary redirect is a statement about the page, not the transport.
  assert.equal(
    mod.isForcedTlsRedirect(from, 302, "https://www.aeropartshub.com/old-part"),
    false
  );
  assert.equal(
    mod.isForcedTlsRedirect(from, 307, "https://www.aeropartshub.com/old-part"),
    false
  );
  // No Location header at all, and a non-redirect status.
  assert.equal(mod.isForcedTlsRedirect(from, 301, null), false);
  assert.equal(
    mod.isForcedTlsRedirect(from, 200, "https://www.aeropartshub.com/old-part"),
    false
  );
});

test("the scheme flip is ONE WAY and per host — it cannot ping-pong", () => {
  reset();

  assert.equal(mod.privateSchemeFor("www.aeropartshub.com"), "http");

  mod.notePrivateSchemeFlip("www.aeropartshub.com");

  assert.equal(mod.privateSchemeFor("www.aeropartshub.com"), "https");
  assert.equal(
    mod.applyPrivateRoute("https://www.aeropartshub.com/x").url,
    "https://www.aeropartshub.com/x"
  );
  // Flipping again is idempotent; nothing anywhere sets a host back to http, so a
  // host cannot alternate mid-run and measure the same pattern two ways.
  mod.notePrivateSchemeFlip("www.aeropartshub.com");
  assert.equal(mod.privateSchemeFor("www.aeropartshub.com"), "https");

  // Per host: a different site on the same box is unaffected.
  assert.equal(mod.privateSchemeFor("www.aeroworld360.com"), "http");
});

// ---- The breaker's effect on routing ---------------------------------------

test("an abandoned IP stops routing privately — every host on that box", () => {
  reset();

  assert.equal(mod.privateRouteFor("https://stackedindustrials.com/x")?.ip, "10.0.50.234");

  health.disablePrivateRoute("10.0.50.234");

  // Both spellings, i.e. the whole box, fall back to the public path. The URL is
  // returned unchanged, which is byte-for-byte today's behaviour.
  assert.equal(mod.privateRouteFor("https://stackedindustrials.com/x"), null);
  assert.equal(
    mod.applyPrivateRoute("https://www.stackedindustrials.com/x").url,
    "https://www.stackedindustrials.com/x"
  );
  // A different box is untouched.
  assert.equal(
    mod.privateRouteFor("https://www.aeropartshub.com/x")?.ip,
    "10.0.61.203"
  );
});

test("privateRouteStatusFor distinguishes public, private and abandoned", () => {
  reset();

  assert.equal(mod.privateRouteStatusFor("www.aeropartshub.com"), "private");
  assert.equal(mod.privateRouteStatusFor("www.not-in-the-map.com"), "public");

  health.disablePrivateRoute("10.0.61.203");

  // NOT "public": a mapped-but-abandoned route is an operational finding, and the
  // fleet report must not render it as the ordinary default.
  assert.equal(
    mod.privateRouteStatusFor("www.aeropartshub.com"),
    "private-disabled"
  );
  // Accepts a host:port as it appears in host_probe_profiles keys.
  assert.equal(
    mod.privateRouteStatusFor("www.aeroworld360.com:8080"),
    "private-disabled"
  );
});

// ---- Which budget a request is charged to -----------------------------------

test("a privately-routed request is charged to its BOX, not its hostname", () => {
  reset();

  const a = rateLimitBucketFor(
    "http://www.aeropartshub.com/x",
    "10.0.61.203"
  );
  const b = rateLimitBucketFor(
    "http://www.aeroworld360.com/y",
    "10.0.61.203"
  );

  // ~93 hostnames share each box, so the thing that can be overloaded is the SERVER.
  // Two different sites on one IP must share one budget — per-host keying would hand
  // one machine 93 independent budgets and call it rate limiting.
  assert.equal(a.key, "priv:10.0.61.203");
  assert.deepEqual(a.key, b.key);
  assert.equal(a.options.requestsPerSecond, config.privateRoute.maxRequestsPerSecond);
  assert.equal(a.options.burst, config.privateRoute.rateLimitBurst);
});

test("a public request keeps today's hostname key and the verification budget", () => {
  const bucket = rateLimitBucketFor("https://www.not-in-the-map.com/x", null);

  assert.equal(bucket.key, "www.not-in-the-map.com");
  assert.equal(bucket.key, rateLimitHostKey("https://www.not-in-the-map.com/x"));
  assert.equal(
    bucket.options.requestsPerSecond,
    config.verification.maxRequestsPerSecond
  );
});

// The `priv:` prefix is load-bearing: acquireHostSlot takes its options PER CALL, so one
// key shared between two different budgets would produce incoherent spacing for both.
test("a private bucket key can never collide with a hostname key", () => {
  const privateKey = rateLimitBucketFor("http://www.aeropartshub.com/x", "10.0.61.203").key;

  // Even a session whose base_url is literally the IP gets a different key.
  assert.notEqual(privateKey, rateLimitHostKey("http://10.0.61.203/x"));
  assert.match(privateKey, /^priv:/);
});

test("concurrency follows the route, because rate without concurrency is a fiction", () => {
  reset();

  assert.equal(
    verifyConcurrency("https://www.aeropartshub.com"),
    config.privateRoute.maxConcurrency
  );
  assert.equal(
    verifyConcurrency("https://www.not-in-the-map.com"),
    config.verification.maxConcurrency
  );
  // Called with nothing, it is exactly the public behaviour it always was.
  assert.equal(verifyConcurrency(), config.verification.maxConcurrency);
});
