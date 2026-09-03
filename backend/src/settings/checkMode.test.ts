import assert from "node:assert/strict";
import { test } from "node:test";

import { LEGACY_MODE, parseCheckMode, STAGING_MODE } from "./checkMode.js";

// The strictness rule, pinned. This is the same contract readBooleanFlag has in
// config.ts and for the same reason: this flag decides WHICH SERVER the tool
// measures, so a stored value that is merely close to "2.0" must read as legacy.
// A settings row corrupted to "2" pointing every health check at a staging host
// is a silent wrong answer about a live production site.
test("only the exact string 2.0 selects staging", () => {
  assert.equal(parseCheckMode("2.0"), STAGING_MODE);

  for (const nearMiss of [
    "2",
    "2.0.0",
    " 2.0",
    "2.0 ",
    "v2.0",
    "TRUE",
    "true",
    "staging",
    "1.90",
    "",
    null,
    undefined
  ]) {
    assert.equal(
      parseCheckMode(nearMiss),
      LEGACY_MODE,
      `${JSON.stringify(nearMiss)} must not enable staging`
    );
  }
});

// A missing settings row (fresh install, or a database restored without the
// migration's seed INSERT) is legacy, not an error and not staging.
test("an absent settings value is legacy mode", () => {
  assert.equal(parseCheckMode(undefined), "1.90");
});
