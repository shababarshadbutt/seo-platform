import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFileScope, shouldQueueApply } from "./applyFileScope.js";

// The reported bug: Accept said 579,034, the toast said "10 URLs updated". The
// pattern spans 187 files; the inline path scanned only the files the 10
// confirmed sampled rows named, because no single rule could be derived from
// redirects that each went to a different category. The first test here is the
// assertion that would have caught it.

const OCCURRENCES = Array.from(
  { length: 187 },
  (_, index) => `sitemap-${index + 1}.xml`
);

test("confirmed destinations alone widen to the pattern's whole file list", () => {
  const scope = applyFileScope({
    sampledFiles: ["sitemap-3.xml", "sitemap-11.xml"],
    occurrenceFiles: OCCURRENCES,
    hasReplacements: true,
    // The reported case exactly: no rule, because the confirmed redirects
    // disagree on destination category.
    hasRule: false
  });

  assert.equal(scope.length, 187);
  // The file that was silently never opened.
  assert.ok(scope.includes("sitemap-187.xml"));
});

test("a rule still widens to the whole file list", () => {
  const scope = applyFileScope({
    sampledFiles: ["sitemap-3.xml"],
    occurrenceFiles: OCCURRENCES,
    hasReplacements: false,
    hasRule: true
  });

  assert.equal(scope.length, 187);
});

test("both apply paths agree for the same pattern", () => {
  // The property the two implementations lost. The job passes no sampled files
  // (it re-reads occurrences); the route passes the files its rows named. Both
  // must end up scanning the same set, or the same apply reaches different
  // files depending only on whether the pattern crossed the inline/queued
  // threshold.
  const fromJob = applyFileScope({
    sampledFiles: [],
    occurrenceFiles: OCCURRENCES,
    hasReplacements: true,
    hasRule: false
  });
  const fromRoute = applyFileScope({
    sampledFiles: ["sitemap-3.xml", "sitemap-11.xml"],
    occurrenceFiles: OCCURRENCES,
    hasReplacements: true,
    hasRule: false
  });

  assert.deepEqual(new Set(fromJob), new Set(fromRoute));
});

test("no occurrence rows falls back to every file of the role", () => {
  // Older sessions. An empty result is the established "scan everything"
  // signal in both callers. Returning the sampled files here would be the bug
  // this module exists to remove: a subset that looks like an answer.
  const scope = applyFileScope({
    sampledFiles: ["sitemap-3.xml"],
    occurrenceFiles: [],
    hasReplacements: true,
    hasRule: false
  });

  assert.deepEqual(scope, []);
});

test("nothing to apply does not widen", () => {
  // No rewrite will run, so pulling 187 filenames back would be pure cost.
  const scope = applyFileScope({
    sampledFiles: ["sitemap-3.xml"],
    occurrenceFiles: OCCURRENCES,
    hasReplacements: false,
    hasRule: false
  });

  assert.deepEqual(scope, ["sitemap-3.xml"]);
});

test("sampled files outside the occurrence list are still scanned", () => {
  // Defensive: a display-name mapping drift must not drop a file we know holds
  // an affected URL. Over-broad is the harmless direction.
  const scope = applyFileScope({
    sampledFiles: ["stray.xml"],
    occurrenceFiles: ["sitemap-1.xml"],
    hasReplacements: true,
    hasRule: false
  });

  assert.deepEqual(new Set(scope), new Set(["sitemap-1.xml", "stray.xml"]));
});

// --- inline or queued (v1.77) -----------------------------------------------
// The other half of the same decision. applyFileScope says an apply opens the
// pattern's whole file list; these say a REQUEST may not do that many files
// itself. Routing used to key on the caller's intent, so the apply above ran
// inline over 187 files inside an open transaction and starved the API pool.

test("a wide pattern queues even with no rule and no widen", () => {
  // The reported case: confirmed destinations only. It matched none of the old
  // gate's conditions (approved rules / inferred urls / widen) and therefore
  // rewrote 187 files on the API request. This is the assertion that catches it.
  assert.equal(
    shouldQueueApply({ patternFileSpan: 187, threshold: 25 }),
    true
  );
});

test("a narrow pattern stays inline", () => {
  // The common case, and why the inline path still exists: a handful of files is
  // well inside a request's budget and the user is waiting on the result.
  assert.equal(shouldQueueApply({ patternFileSpan: 3, threshold: 25 }), false);
});

test("the boundary is exclusive, matching the parallel pool's own crossover", () => {
  // At exactly the threshold the file-rewrite pool still takes the sequential
  // path, so the request may too. One number, one meaning, both sides.
  assert.equal(shouldQueueApply({ patternFileSpan: 25, threshold: 25 }), false);
  assert.equal(shouldQueueApply({ patternFileSpan: 26, threshold: 25 }), true);
});

test("intent cannot route an apply — only the file count can", () => {
  // The invariant the last two regressions violated: for a given span the answer
  // is the same whatever the caller asked for. Written as a property because
  // both previous fixes added one more intent flag to the condition instead.
  for (const patternFileSpan of [0, 1, 25, 26, 187, 1200]) {
    const expected = patternFileSpan > 25;

    assert.equal(
      shouldQueueApply({ patternFileSpan, threshold: 25 }),
      expected,
      `span ${patternFileSpan} must route on size alone`
    );
  }
});

test("a session with no occurrence rows stays inline", () => {
  // Span 0 means pattern_file_occurrences was never populated (pre-v1.42
  // sessions). applyFileScope answers that case by scanning the whole role, but
  // it is not a reason to queue: there is no measured width to queue on, and the
  // inline path reports the resulting no-op immediately.
  assert.equal(shouldQueueApply({ patternFileSpan: 0, threshold: 25 }), false);
});
