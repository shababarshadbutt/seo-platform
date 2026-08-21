import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFileScope } from "./applyFileScope.js";

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
