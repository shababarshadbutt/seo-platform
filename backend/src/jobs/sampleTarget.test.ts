import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSampleTarget } from "./sampleTarget.js";

// The sampler re-hosts sitemap paths onto base_url. When base_url and the
// sitemap's own <loc> differ only by "www.", that sent every probe to the wrong
// variant of the same site: the answer described the www redirect instead of the
// page, and any REAL redirect on the correct host was never seen because only one
// hop is followed.
test("a www-only mismatch probes the sitemap's own URL, not the base_url host", () => {
  // base_url without www, sitemap with www — the reported case.
  assert.equal(
    resolveSampleTarget(
      "https://aerooemparts.com",
      "/niin-look-up/014420438",
      "https://www.aerooemparts.com/niin-look-up/014420438"
    ),
    "https://www.aerooemparts.com/niin-look-up/014420438"
  );

  // And the reverse: base_url with www, sitemap without.
  assert.equal(
    resolveSampleTarget(
      "https://www.example.com",
      "/a",
      "https://example.com/a"
    ),
    "https://example.com/a"
  );
});

test("matching hosts are unchanged — base_url still supplies the host", () => {
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", "https://example.com/a"),
    "https://example.com/a"
  );
  assert.equal(
    resolveSampleTarget("https://example.com/", "a", "https://example.com/a"),
    "https://example.com/a"
  );
});

// The re-hosting behaviour is deliberate and must survive: a session may point a
// sitemap at a different environment. Only the www label is special-cased.
test("a genuinely different host is still re-hosted onto base_url", () => {
  assert.equal(
    resolveSampleTarget(
      "https://staging.example.com",
      "/a",
      "https://www.example.com/a"
    ),
    "https://staging.example.com/a"
  );

  // Subdomains are NOT treated as equivalent here, unlike isSameDomain: probing
  // shop.example.com when the user asked for example.com would silently change
  // which page is checked.
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", "https://shop.example.com/a"),
    "https://example.com/a"
  );

  // Look-alike hosts must not collapse together.
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", "https://notexample.com/a"),
    "https://example.com/a"
  );
});

test("a missing or unusable source_url falls back to base_url + path", () => {
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", null),
    "https://example.com/a"
  );
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", "not a url"),
    "https://example.com/a"
  );
  // Non-http schemes can't be probed.
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", "mailto:x@example.com"),
    "https://example.com/a"
  );
});

// A www-equivalent host must not smuggle in a different scheme or port.
test("the sitemap URL is used verbatim, including its own scheme", () => {
  assert.equal(
    resolveSampleTarget("https://example.com", "/a", "http://www.example.com/a"),
    "http://www.example.com/a"
  );
});
