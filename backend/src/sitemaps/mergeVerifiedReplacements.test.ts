import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeVerifiedReplacements } from "./redirectApply.js";

// The reported bug, in one line: the Accept button said 28,546, the toast said
// "10 URLs updated", and ten <loc> entries changed. apply-redirects only ever
// read sampled_urls — the ~1,000-row capped preview — so the full verified
// population written by "Verify all in this pattern" was invisible to it.
// These pin the three merge rules that make the wider set usable safely.

const VERIFIED = [
  {
    url: "https://site.com/nsn/nsn-parts-1",
    final_url: "https://site.com/nsn/nsn-parts/1",
    source_files: ["sitemap-1.xml"]
  },
  {
    url: "https://site.com/nsn/part-types-2",
    final_url: "https://site.com/nsn/part-types/2",
    source_files: ["sitemap-2.xml"]
  }
];

test("verified-only URLs enter the map — the fix for the reported bug", () => {
  const replacements = new Map<string, string>();
  const candidateFiles = new Set<string>();

  const result = mergeVerifiedReplacements({
    replacements,
    candidateFiles,
    verified: VERIFIED
  });

  assert.equal(result.added, 2);
  assert.equal(
    replacements.get("https://site.com/nsn/nsn-parts-1"),
    "https://site.com/nsn/nsn-parts/1"
  );
  // The files those URLs live in come along, or the disk scan would skip them.
  assert.deepEqual(
    [...candidateFiles].sort(),
    ["sitemap-1.xml", "sitemap-2.xml"]
  );
});

test("sampled wins on conflict", () => {
  // The sampled row had its stats recomputed and its undo snapshot written in
  // this transaction; a verified row for the same URL must not overwrite it, or
  // the file and the DB would disagree about what that URL became.
  const replacements = new Map([
    ["https://site.com/nsn/nsn-parts-1", "https://site.com/sampled-destination"]
  ]);
  const candidateFiles = new Set<string>();

  const result = mergeVerifiedReplacements({
    replacements,
    candidateFiles,
    verified: VERIFIED
  });

  assert.equal(
    replacements.get("https://site.com/nsn/nsn-parts-1"),
    "https://site.com/sampled-destination"
  );
  // Only the OTHER row was added.
  assert.equal(result.added, 1);
});

test("out-of-scope URLs never enter the map", () => {
  // "Limit this edit to" has to hold here, not just in the rewriter's guard:
  // this is a second source of replacements, and the v1.66 invariant is that an
  // excluded structure comes out byte-identical.
  const replacements = new Map<string, string>();
  const candidateFiles = new Set<string>();

  const result = mergeVerifiedReplacements({
    replacements,
    candidateFiles,
    verified: VERIFIED,
    matchesScope: (url) => url.includes("/nsn-parts-")
  });

  assert.equal(result.added, 1);
  assert.equal(result.skippedOutOfScope, 1);
  assert.ok(replacements.has("https://site.com/nsn/nsn-parts-1"));
  assert.ok(!replacements.has("https://site.com/nsn/part-types-2"));
  // And the excluded row's file is not scanned either.
  assert.deepEqual([...candidateFiles], ["sitemap-1.xml"]);
});

test("a destination equal to the source is not a replacement", () => {
  const replacements = new Map<string, string>();
  const result = mergeVerifiedReplacements({
    replacements,
    candidateFiles: new Set<string>(),
    verified: [
      {
        url: "https://site.com/same",
        final_url: "https://site.com/same",
        source_files: ["s.xml"]
      }
    ]
  });

  assert.equal(result.added, 0);
  assert.equal(replacements.size, 0);
});

test("a missing source_files list is not a crash", () => {
  // verified_urls.source_files is nullable.
  const candidateFiles = new Set<string>();
  const result = mergeVerifiedReplacements({
    replacements: new Map<string, string>(),
    candidateFiles,
    verified: [
      {
        url: "https://site.com/a",
        final_url: "https://site.com/b",
        source_files: null
      }
    ]
  });

  assert.equal(result.added, 1);
  assert.equal(candidateFiles.size, 0);
});
