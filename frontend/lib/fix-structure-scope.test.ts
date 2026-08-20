import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  fixScopeLabel,
  fixScopeMatchesNothing,
  scopedFixTotal
} from "./fix-structure-scope";

test("unscoped: the whole pattern's total", () => {
  assert.equal(
    scopedFixTotal({
      patternTotal: 28413,
      scopedOccurrences: null,
      hasScope: false
    }),
    28413
  );
});

test("unscoped ignores a stale scoped count", () => {
  // Dropping back to "Any structure" must report the pattern again immediately,
  // even if the last scoped fetch is still sitting in state.
  assert.equal(
    scopedFixTotal({
      patternTotal: 28413,
      scopedOccurrences: 613,
      hasScope: false
    }),
    28413
  );
});

test("scoped: the structure's real occurrence count", () => {
  assert.equal(
    scopedFixTotal({
      patternTotal: 28413,
      scopedOccurrences: 21043,
      hasScope: true
    }),
    21043
  );
});

test("scoped but still loading: the pattern total, NOT zero", () => {
  // A transient 0 would render "Accept Selected Changes (0)" and read as
  // "nothing will change" for a scope about to report thousands. Stale for a
  // moment is acceptable; wrong in the alarming direction is not.
  assert.equal(
    scopedFixTotal({
      patternTotal: 28413,
      scopedOccurrences: null,
      hasScope: true
    }),
    28413
  );
});

test("a settled scoped zero IS reported as zero", () => {
  // The empty-combination case: once the count has landed, 0 is the truth and
  // fixScopeMatchesNothing blocks the button.
  const input = {
    patternTotal: 28413,
    scopedOccurrences: 0,
    hasScope: true
  };

  assert.equal(scopedFixTotal(input), 0);
  assert.equal(fixScopeMatchesNothing(input), true);
});

test("loading is not 'matches nothing'", () => {
  // The distinction the button depends on: null must never block Accept the way
  // a real empty combination does.
  assert.equal(
    fixScopeMatchesNothing({
      patternTotal: 28413,
      scopedOccurrences: null,
      hasScope: true
    }),
    false
  );
});

test("unscoped is never 'matches nothing', even at zero", () => {
  // A pattern with no occurrences at all is a different (already handled) empty
  // state; it must not render the "pick different structures" copy.
  assert.equal(
    fixScopeMatchesNothing({
      patternTotal: 0,
      scopedOccurrences: 0,
      hasScope: false
    }),
    false
  );
});

test("the label joins a combination the way the dropdowns were picked", () => {
  assert.equal(fixScopeLabel(["nsn-parts-{var}"]), "nsn-parts-{var}");
  assert.equal(
    fixScopeLabel(["nsn-parts-{var}", "part-types-{var}"]),
    "nsn-parts-{var} + part-types-{var}"
  );
  assert.equal(fixScopeLabel([]), "");
});
