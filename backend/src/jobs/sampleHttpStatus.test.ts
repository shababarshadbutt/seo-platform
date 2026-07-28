import assert from "node:assert/strict";
import { test } from "node:test";

import { isMethodRejectedStatus } from "./sampleHttpStatus.js";

// The checker probes with HEAD. A host that refuses HEAD made every sampled URL
// on it report as a failure, which reads as "Broken" in the UI — a false negative
// a redirect Fix could then act on. Only the two method-specific statuses trigger
// the GET re-probe.
test("only method-specific statuses trigger the GET re-probe", () => {
  assert.equal(isMethodRejectedStatus(405), true, "405 Method Not Allowed");
  assert.equal(isMethodRejectedStatus(501), true, "501 Not Implemented");
});

// Re-probing these with GET would hide a real signal rather than correct a bogus
// one, so they are deliberately excluded.
test("authorisation, rate-limit and availability statuses are NOT re-probed", () => {
  for (const status of [400, 401, 403, 404, 410, 429, 500, 502, 503, 504]) {
    assert.equal(
      isMethodRejectedStatus(status),
      false,
      `${status} must not be treated as a method rejection`
    );
  }
});

test("success and redirect statuses are untouched, as is a failed request", () => {
  for (const status of [200, 204, 301, 302, 307, 308]) {
    assert.equal(isMethodRejectedStatus(status), false, `${status}`);
  }

  // A transport error yields a null status — must not be mistaken for a method
  // rejection and re-probed.
  assert.equal(isMethodRejectedStatus(null), false, "null (request failed)");
});
