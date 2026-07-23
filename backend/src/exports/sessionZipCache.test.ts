import assert from "node:assert/strict";
import { test } from "node:test";

import { isZipCacheFresh } from "./zipCacheFreshness.js";

// Regression guard for the v1.42 stale-download bug: a cached ZIP must only be
// treated as fresh when it was generated STRICTLY AFTER the last file mutation.
// (The download endpoint used to serve any existing cache unconditionally.)
test("isZipCacheFresh — no post-completion mutation is always fresh", () => {
  assert.equal(isZipCacheFresh(new Date("2026-01-01T00:00:00Z"), null), true);
  assert.equal(isZipCacheFresh(null, null), true);
});

test("isZipCacheFresh — a cache generated after the mutation is fresh", () => {
  assert.equal(
    isZipCacheFresh(
      "2026-01-01T00:00:05Z", // zip built 5s after
      "2026-01-01T00:00:00Z" // mutation
    ),
    true
  );
});

test("isZipCacheFresh — a cache generated before the mutation is STALE", () => {
  assert.equal(
    isZipCacheFresh(
      "2026-01-01T00:00:00Z", // zip built before
      "2026-01-01T00:00:05Z" // later edit
    ),
    false
  );
});

test("isZipCacheFresh — equal timestamps are treated as stale (strict >)", () => {
  const t = "2026-01-01T00:00:00.000Z";
  assert.equal(isZipCacheFresh(t, t), false);
});

test("isZipCacheFresh — a mutation with no generated cache is stale", () => {
  assert.equal(isZipCacheFresh(null, new Date()), false);
});
