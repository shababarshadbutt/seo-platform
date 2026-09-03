import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyStagingOrigin,
  deriveStagingBaseUrl,
  isProdOrigin,
  resolveStagingOrigin,
  toProdIdentity
} from "./stagingOrigin.js";

// THE 1.90 INERTNESS PROOF, first in the file on purpose.
//
// The whole legacy guarantee reduces to this one property: in 1.90 every caller
// passes null, so the URL that gets requested, the string the rate bucket is
// derived from and the key the host strategy is cached under are all byte-for-byte
// the string they were before this feature existed. If this test ever fails,
// nothing else in the file matters.
test("applyStagingOrigin with no staging origin returns the URL unchanged", () => {
  const cases = [
    "https://www.asapsemi.com/parts/abc-123",
    "https://asapsemi.com/a?b=c#d",
    "http://example.com:8080/x",
    "https://example.com/%7Bparam%7D/weird",
    "not a url at all"
  ];

  for (const url of cases) {
    assert.equal(applyStagingOrigin(url, null), url);
  }
});

test("deriveStagingBaseUrl prefixes dev. and drops www.", () => {
  assert.equal(
    deriveStagingBaseUrl("https://www.asapsemi.com"),
    "https://dev.asapsemi.com"
  );
  assert.equal(
    deriveStagingBaseUrl("https://asapsemi.com"),
    "https://dev.asapsemi.com"
  );
  // Case is normalized, matching normalizeHost.
  assert.equal(
    deriveStagingBaseUrl("https://WWW.AsapSemi.com"),
    "https://dev.asapsemi.com"
  );
});

// A session created directly against the dev site must not become
// dev.dev.asapsemi.com when 2.0 is switched on.
test("deriveStagingBaseUrl is idempotent on a host that is already dev.", () => {
  assert.equal(
    deriveStagingBaseUrl("https://dev.asapsemi.com"),
    "https://dev.asapsemi.com"
  );
  assert.equal(
    deriveStagingBaseUrl(deriveStagingBaseUrl("https://www.asapsemi.com")!),
    "https://dev.asapsemi.com"
  );
});

test("deriveStagingBaseUrl preserves scheme and port and drops any path", () => {
  assert.equal(deriveStagingBaseUrl("http://example.com"), "http://dev.example.com");
  assert.equal(
    deriveStagingBaseUrl("https://example.com:8443"),
    "https://dev.example.com:8443"
  );
  // base_url is stored without a trailing slash, but a path must not survive into
  // an origin either way — sessions_staging_base_url_absolute forbids one.
  assert.equal(
    deriveStagingBaseUrl("https://example.com/some/path"),
    "https://dev.example.com"
  );
});

// The documented limitation: an existing subdomain gets dev. prefixed to the whole
// host rather than replacing the subdomain. Pinned so the behaviour is a decision
// rather than an accident — the per-session override is the escape hatch.
test("deriveStagingBaseUrl prefixes an existing subdomain rather than replacing it", () => {
  assert.equal(
    deriveStagingBaseUrl("https://shop.example.com"),
    "https://dev.shop.example.com"
  );
});

test("deriveStagingBaseUrl returns null for anything that is not an http(s) URL", () => {
  for (const bad of ["", "   ", "mailto:a@b.com", "ftp://example.com", "garbage"]) {
    assert.equal(deriveStagingBaseUrl(bad), null);
  }
});

test("resolveStagingOrigin prefers an explicit override over the derivation", () => {
  assert.equal(
    resolveStagingOrigin("https://www.asapsemi.com", "https://staging.asapsemi.com"),
    "https://staging.asapsemi.com"
  );
  // Absent, blank and whitespace-only all mean "derive it".
  for (const empty of [null, undefined, "", "   "]) {
    assert.equal(
      resolveStagingOrigin("https://www.asapsemi.com", empty),
      "https://dev.asapsemi.com"
    );
  }
});

test("resolveStagingOrigin falls back to the derivation for an unusable override", () => {
  assert.equal(
    resolveStagingOrigin("https://www.asapsemi.com", "not a url"),
    "https://dev.asapsemi.com"
  );
});

test("applyStagingOrigin swaps host and scheme but preserves path, query and hash", () => {
  assert.equal(
    applyStagingOrigin(
      "https://www.asapsemi.com/parts/abc-123?x=1#frag",
      "https://dev.asapsemi.com"
    ),
    "https://dev.asapsemi.com/parts/abc-123?x=1#frag"
  );
});

// The prod port must not survive onto a staging origin that does not name one,
// and a staging port must be applied when it does.
test("applyStagingOrigin carries the staging port and drops the production one", () => {
  assert.equal(
    applyStagingOrigin("https://example.com:8080/a", "https://dev.example.com"),
    "https://dev.example.com/a"
  );
  assert.equal(
    applyStagingOrigin("https://example.com/a", "http://dev.example.com:3000"),
    "http://dev.example.com:3000/a"
  );
});

test("applyStagingOrigin leaves a URL already on the staging host alone", () => {
  const already = "https://dev.asapsemi.com/a";

  assert.equal(applyStagingOrigin(already, "https://dev.asapsemi.com"), already);
});

// THE SITEMAP-CORRUPTION GUARD. final_url becomes the redirect destination written
// into production sitemap <loc> values, so a staging Location header must come back
// wearing the production host.
test("toProdIdentity maps a staging redirect destination back to production", () => {
  assert.equal(
    toProdIdentity(
      "https://dev.asapsemi.com/new-path",
      "https://dev.asapsemi.com",
      "https://www.asapsemi.com"
    ),
    "https://www.asapsemi.com/new-path"
  );
});

test("toProdIdentity leaves a genuine third-party destination untouched", () => {
  const external = "https://cdn.example.net/asset";

  assert.equal(
    toProdIdentity(external, "https://dev.asapsemi.com", "https://www.asapsemi.com"),
    external
  );
});

test("toProdIdentity is a no-op in 1.90 and on null", () => {
  const url = "https://www.asapsemi.com/a";

  assert.equal(toProdIdentity(url, null, "https://www.asapsemi.com"), url);
  assert.equal(toProdIdentity(null, "https://dev.asapsemi.com", "https://www.asapsemi.com"), null);
});

// applyStagingOrigin and toProdIdentity must be exact inverses for a prod-host URL,
// or a redirect chain drifts a little further from the truth on every hop.
test("applyStagingOrigin and toProdIdentity round-trip", () => {
  const prodOrigin = "https://www.asapsemi.com";
  const stagingOrigin = "https://dev.asapsemi.com";
  const original = "https://www.asapsemi.com/parts/abc-123?x=1";

  const staged = applyStagingOrigin(original, stagingOrigin);

  assert.equal(staged, "https://dev.asapsemi.com/parts/abc-123?x=1");
  assert.equal(toProdIdentity(staged, stagingOrigin, prodOrigin), original);
});

// Guards the redirect FOLLOW: a final_url already normalized back to prod has to be
// recognised as prod so it can be re-staged, or a 2.0 run quietly requests
// production.
test("isProdOrigin recognises the production host and only that host", () => {
  assert.equal(isProdOrigin("https://www.asapsemi.com/a", "https://www.asapsemi.com"), true);
  assert.equal(isProdOrigin("https://dev.asapsemi.com/a", "https://www.asapsemi.com"), false);
  assert.equal(isProdOrigin("https://cdn.example.net/a", "https://www.asapsemi.com"), false);
  assert.equal(isProdOrigin("garbage", "https://www.asapsemi.com"), false);
});
