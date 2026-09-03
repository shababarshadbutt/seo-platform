import { strict as assert } from "node:assert";
import { test } from "node:test";

import { describeCheckedEnvironment } from "./checked-environment";

const ORIGINS = {
  prod: "https://www.asapsemi.com",
  staging: "https://dev.asapsemi.com"
};

// A session with no verdicts has no environment to report. Rendering a banner
// anyway would put a claim on screen that the data does not support.
test("nothing checked yet renders no banner", () => {
  const banner = describeCheckedEnvironment({ prod: 0, staging: 0 }, ORIGINS);

  assert.equal(banner.kind, "none");
  assert.equal(banner.text, "");
});

test("null counts are treated as nothing checked, not as an error", () => {
  assert.equal(describeCheckedEnvironment(null, ORIGINS).kind, "none");
  assert.equal(describeCheckedEnvironment(undefined, ORIGINS).kind, "none");
});

test("a production-only session names production and stays neutral", () => {
  const banner = describeCheckedEnvironment({ prod: 4208, staging: 0 }, ORIGINS);

  assert.equal(banner.kind, "prod");
  assert.equal(banner.text, "Checked against production — asapsemi.com");
  assert.equal(banner.tone, "neutral");
});

// The host is normalized, so the banner reads the same whether base_url carries a
// www. label or not -- the label is not the point, the ENVIRONMENT is.
test("a staging-only session names the staging host", () => {
  const banner = describeCheckedEnvironment({ prod: 0, staging: 4208 }, ORIGINS);

  assert.equal(banner.kind, "staging");
  assert.equal(banner.text, "Checked against staging — dev.asapsemi.com");
  // Info, not warning: checking staging is what the user asked for. It must be
  // impossible to miss, but it is not a problem.
  assert.equal(banner.tone, "info");
});

// THE CASE THAT MATTERS. Re-checking one pattern after a flip leaves the rest of
// the session on the other environment, so one table shows numbers measured against
// two different servers. This is the most misleading state the feature can produce
// and it is the one that gets the warning tone and an instruction.
test("a mixed session says so loudly and says how to fix it", () => {
  const banner = describeCheckedEnvironment({ prod: 88, staging: 4120 }, ORIGINS);

  assert.equal(banner.kind, "mixed");
  assert.equal(banner.tone, "warning");
  assert.equal(
    banner.text,
    "Mixed environments — 4,120 checked on staging, 88 on production. " +
      "Re-check to make this consistent."
  );
});

// A single stray row of the other environment is still mixed. Rounding it away
// would hide exactly the inconsistency this exists to surface.
test("one stray row is still mixed, not a clean result", () => {
  assert.equal(
    describeCheckedEnvironment({ prod: 1, staging: 100000 }, ORIGINS).kind,
    "mixed"
  );
  assert.equal(
    describeCheckedEnvironment({ prod: 100000, staging: 1 }, ORIGINS).kind,
    "mixed"
  );
});

// The staging origin can legitimately be absent (an old session never checked
// against staging), and the banner must not print "undefined" at a user.
test("a missing staging origin degrades to an empty host, never undefined", () => {
  const banner = describeCheckedEnvironment(
    { prod: 0, staging: 5 },
    { prod: ORIGINS.prod, staging: null }
  );

  assert.ok(!banner.text.includes("undefined"), banner.text);
});
