import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  deriveStagingBaseUrl,
  parseUrlCheckMode
} from "./staging-origin";

// THE SAME CASE TABLE as backend/src/http/stagingOrigin.test.ts. These two files
// must agree: the backend decides where a probe actually goes, and this one decides
// what the New Analysis form PROMISES it will go. A user typing a base URL, reading
// the derived placeholder and getting something else is exactly the drift the
// lib/host.ts <-> domain.ts pairing already exists to prevent.

test("deriveStagingBaseUrl prefixes dev. and drops www.", () => {
  assert.equal(
    deriveStagingBaseUrl("https://www.asapsemi.com"),
    "https://dev.asapsemi.com"
  );
  assert.equal(
    deriveStagingBaseUrl("https://asapsemi.com"),
    "https://dev.asapsemi.com"
  );
  assert.equal(
    deriveStagingBaseUrl("https://WWW.AsapSemi.com"),
    "https://dev.asapsemi.com"
  );
});

test("deriveStagingBaseUrl is idempotent on a host that is already dev.", () => {
  assert.equal(
    deriveStagingBaseUrl("https://dev.asapsemi.com"),
    "https://dev.asapsemi.com"
  );
});

test("deriveStagingBaseUrl preserves scheme and port and drops any path", () => {
  assert.equal(deriveStagingBaseUrl("http://example.com"), "http://dev.example.com");
  assert.equal(
    deriveStagingBaseUrl("https://example.com:8443"),
    "https://dev.example.com:8443"
  );
  assert.equal(
    deriveStagingBaseUrl("https://example.com/some/path"),
    "https://dev.example.com"
  );
});

test("deriveStagingBaseUrl prefixes an existing subdomain rather than replacing it", () => {
  assert.equal(
    deriveStagingBaseUrl("https://shop.example.com"),
    "https://dev.shop.example.com"
  );
});

// A half-typed base URL is the NORMAL state of this field, so returning null (and
// showing no promise at all) has to be well-defined rather than incidental.
test("deriveStagingBaseUrl returns null for anything that is not an http(s) URL", () => {
  for (const bad of ["", "   ", "mailto:a@b.com", "ftp://example.com", "garbage"]) {
    assert.equal(deriveStagingBaseUrl(bad), null);
  }
});

test("only the exact string 2.0 reads as staging", () => {
  assert.equal(parseUrlCheckMode("2.0"), "2.0");

  for (const nearMiss of ["2", "2.0.0", " 2.0", "TRUE", "", null, undefined]) {
    assert.equal(parseUrlCheckMode(nearMiss), "1.90");
  }
});
