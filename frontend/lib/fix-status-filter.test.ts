import { strict as assert } from "node:assert";
import { test } from "node:test";

import { candidateStatus, filterByStatus } from "./fix-status-filter.js";

// The reported bug: clicking a status chip did not change the URL list. These
// are the click outcomes, as data — select 404, see only 404s.

const CANDIDATES = [
  { key: "a", http_status: 301 },
  { key: "b", http_status: 404 },
  { key: "c", http_status: 301 },
  { key: "d", http_status: 302 },
  { key: "e", http_status: 404 },
  { key: "f", http_status: 200 },
  // An inferred row: matched the pattern, never HTTP-checked.
  { key: "g", http_status: null },
  // pg hands bigints back as strings, so a status can arrive either way.
  { key: "h", http_status: "404" }
];

test("selecting 404 shows only the 404 URLs", () => {
  const shown = filterByStatus(CANDIDATES, new Set([404]));

  assert.deepEqual(
    shown.map((candidate) => candidate.key),
    ["b", "e", "h"]
  );
});

test("selecting 301 shows only the 301 URLs", () => {
  const shown = filterByStatus(CANDIDATES, new Set([301]));

  assert.deepEqual(
    shown.map((candidate) => candidate.key),
    ["a", "c"]
  );
});

test("selecting two codes shows the union of both", () => {
  const shown = filterByStatus(CANDIDATES, new Set([301, 302]));

  assert.deepEqual(
    shown.map((candidate) => candidate.key),
    ["a", "c", "d"]
  );
});

test("no selection is the All chip — every candidate, unchanged", () => {
  const shown = filterByStatus(CANDIDATES, new Set());

  assert.equal(shown.length, CANDIDATES.length);
  // Same array contents AND same order: "All" must not reorder the list.
  assert.deepEqual(shown, CANDIDATES);
});

test("a status with no matching rows yields an empty list, not everything", () => {
  // The failure mode a naive `filter` guard invites: falling back to the full
  // list when nothing matches, which reads as "the filter did nothing".
  assert.deepEqual(filterByStatus(CANDIDATES, new Set([307])), []);
});

test("inferred rows (no status) never appear under a status chip", () => {
  for (const code of [301, 302, 307, 308, 404]) {
    const shown = filterByStatus(CANDIDATES, new Set([code]));

    assert.ok(
      shown.every((candidate) => candidate.key !== "g"),
      `the unchecked row leaked into the ${code} filter`
    );
  }

  // …but it is still there unfiltered.
  assert.ok(
    filterByStatus(CANDIDATES, new Set()).some(
      (candidate) => candidate.key === "g"
    )
  );
});

test("candidateStatus normalises the wire shapes", () => {
  assert.equal(candidateStatus({ http_status: 404 }), 404);
  assert.equal(candidateStatus({ http_status: "404" }), 404);
  assert.equal(candidateStatus({ http_status: null }), null);
  assert.equal(candidateStatus({ http_status: "not-a-number" }), null);
});
