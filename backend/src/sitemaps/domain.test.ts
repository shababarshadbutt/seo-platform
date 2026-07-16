import assert from "node:assert/strict";
import { test } from "node:test";

import { isSameDomain, normalizeHost } from "./domain.js";

test("normalizeHost lowercases and strips a leading www.", () => {
  assert.equal(normalizeHost("WWW.Example.com"), "example.com");
  assert.equal(normalizeHost("example.com"), "example.com");
  assert.equal(normalizeHost("shop.example.com"), "shop.example.com");
});

test("www and apex are the same site", () => {
  assert.equal(isSameDomain("www.site.com", "site.com"), true);
  assert.equal(isSameDomain("site.com", "www.site.com"), true);
  assert.equal(isSameDomain("site.com", "site.com"), true);
});

test("subdomains belong to the same site", () => {
  assert.equal(isSameDomain("shop.site.com", "site.com"), true);
  assert.equal(isSameDomain("parts.site.com", "site.com"), true);
  assert.equal(isSameDomain("deep.nested.site.com", "site.com"), true);
  assert.equal(isSameDomain("www.shop.site.com", "site.com"), true);
});

test("comparison is case-insensitive", () => {
  assert.equal(isSameDomain("Shop.Site.com", "site.com"), true);
  assert.equal(isSameDomain("SITE.COM", "site.com"), true);
});

test("genuinely different domains are not the same site", () => {
  assert.equal(isSameDomain("site.com", "othersite.com"), false);
  assert.equal(isSameDomain("aftermarketaviationspares.com", "asapindustrialservices.com"), false);
});

test("look-alike hosts are not treated as subdomains", () => {
  // ccTLD variant must not match the .com site.
  assert.equal(isSameDomain("site.com.au", "site.com"), false);
  // No label boundary before the expected host.
  assert.equal(isSameDomain("notsite.com", "site.com"), false);
  assert.equal(isSameDomain("evilsite.com", "site.com"), false);
});
