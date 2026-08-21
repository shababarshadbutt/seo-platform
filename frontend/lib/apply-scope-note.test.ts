import assert from "node:assert/strict";
import { test } from "node:test";

import { applyScopeNote } from "./apply-scope-note";

test("a partial scan says so — the reported case", () => {
  // 10 of 579,034 URLs were rewritten because 4 of 187 files were opened.
  assert.equal(
    applyScopeNote({ filesScanned: 4, patternFileCount: 187 }),
    "across 4 of 187 files"
  );
});

test("full coverage stays silent", () => {
  // The normal case. A caveat on every apply is a caveat nobody reads.
  assert.equal(
    applyScopeNote({ filesScanned: 187, patternFileCount: 187 }),
    null
  );
});

test("an over-broad scan is not reported as partial", () => {
  // applyFileScope can return more files than the occurrence rows list (a
  // sampled file outside it), so scanned may exceed the total.
  assert.equal(
    applyScopeNote({ filesScanned: 190, patternFileCount: 187 }),
    null
  );
});

test("no occurrence rows produces no note", () => {
  // Older sessions: "of 0 files" would be nonsense.
  assert.equal(applyScopeNote({ filesScanned: 4, patternFileCount: 0 }), null);
});

test("missing fields produce no note", () => {
  // An older backend that does not send pattern_file_count must not make the
  // toast say anything about scope.
  assert.equal(
    applyScopeNote({ filesScanned: undefined, patternFileCount: undefined }),
    null
  );
});

test("large counts are grouped", () => {
  assert.equal(
    applyScopeNote({ filesScanned: 1200, patternFileCount: 45000 }),
    "across 1,200 of 45,000 files"
  );
});
