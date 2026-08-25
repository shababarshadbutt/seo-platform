import assert from "node:assert/strict";
import { test } from "node:test";

import { sourceFileEmptinessMessage } from "./source-file-emptiness";
import type { ScopedSkipCounts } from "./api";

const noSkips: ScopedSkipCounts = {
  remote: 0,
  no_file_row: 0,
  unreadable: 0,
  no_matches: 0
};

const skips = (over: Partial<ScopedSkipCounts>): ScopedSkipCounts => ({
  ...noSkips,
  ...over
});

test("remote files — the reported case", () => {
  // The asap-ittechnology session: "Limit this edit to" offered quote (885) and
  // manufacturer (115) from pattern_urls, while every sitemap behind the
  // pattern was a child of a fetched index stored as filename = 'https://…'
  // with no local copy. Nothing to scan, and nothing this modal can do about it.
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ remote: 3 }),
      staleAfterFix: false
    }),
    "3 files for this pattern were fetched from a URL, so this session has no local copy to edit. Upload those sitemap files to edit them."
  );
});

test("uploads cleaned up off disk", () => {
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ unreadable: 2 }),
      staleAfterFix: false
    }),
    "2 files for this pattern are no longer on disk — their uploads were cleaned up. Re-upload them to edit this pattern."
  );
});

test("read fine but matched nothing, after a fix — blames the stale template", () => {
  // apply-redirects rewrites the <loc>s without re-extracting, so the template
  // stops describing what is on disk. Same counter as the case below, opposite
  // remedy, which is the whole reason staleAfterFix is a separate input.
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ no_matches: 4 }),
      staleAfterFix: true
    }),
    "This pattern's URL counts predate its last fix, so its template no longer matches what is in the 4 files on disk. Re-run the analysis to refresh them."
  );
});

test("read fine but matched nothing, no fix — blames the scope", () => {
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ no_matches: 1 }),
      staleAfterFix: false
    }),
    'No URL in the 1 file for this pattern matches the structure selected above. Try "Any structure".'
  );
});

test("the file rows are gone", () => {
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ no_file_row: 5 }),
      staleAfterFix: false
    }),
    "The 5 files this pattern was extracted from are no longer part of this session."
  );
});

test("remote outranks every other cause", () => {
  // A pattern can span remote AND cleaned-up AND non-matching files at once.
  // Only one sentence is shown, and it must be the one with a remedy the user
  // can act on first — listing four possibilities to eliminate is barely better
  // than the bare zero this replaces.
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ remote: 1, unreadable: 9, no_matches: 9, no_file_row: 9 }),
      staleAfterFix: true
    }),
    "1 file for this pattern was fetched from a URL, so this session has no local copy to edit. Upload that sitemap file to edit it."
  );
});

test("unreadable outranks a non-match", () => {
  assert.equal(
    sourceFileEmptinessMessage({
      skipped: skips({ unreadable: 1, no_matches: 3 }),
      staleAfterFix: false
    }),
    "1 file for this pattern is no longer on disk — its upload was cleaned up. Re-upload it to edit this pattern."
  );
});

test("scoped request that dropped nothing keeps the plain wording", () => {
  // The pattern genuinely has no files — pattern_file_occurrences was empty, so
  // the scan never had a candidate to drop. Nothing to explain.
  assert.equal(
    sourceFileEmptinessMessage({ skipped: noSkips, staleAfterFix: false }),
    "No source files found for this pattern."
  );
});

test("unscoped request has no drop counters to reason from", () => {
  // "Any structure" everywhere takes the DB rollup, which opens no files. The
  // absent key means "dropping isn't a thing on this path", not "nothing was
  // dropped" — so this must not claim a cause it cannot know.
  assert.equal(
    sourceFileEmptinessMessage({ skipped: null, staleAfterFix: true }),
    "No source files found for this pattern."
  );
  assert.equal(
    sourceFileEmptinessMessage({ staleAfterFix: false }),
    "No source files found for this pattern."
  );
});
