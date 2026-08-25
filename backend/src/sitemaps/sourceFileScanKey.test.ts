import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sourceFileScanCacheKey } from "./sourceFileScanKey.js";

import type { ResolvedStructureFilter } from "./structureClusters.js";

const filter = (
  segmentIndex: number,
  value: string,
  anchor: "prefix" | "suffix" = "prefix"
): ResolvedStructureFilter =>
  ({ segmentIndex, anchor, value }) as unknown as ResolvedStructureFilter;

describe("sourceFileScanCacheKey", () => {
  it("is insensitive to the order the filters arrive in", () => {
    // THE POINT OF THE CANONICALISER, and the reason this does not reuse
    // fingerprintFilters() from routes/sessions.ts: that one deliberately does
    // NOT sort, because changing the job fingerprint would make a
    // retry-after-timeout look like a new operation. Inheriting that here would
    // mean the same scope, serialised two ways, paid for two ~100s scans.
    const base = {
      patternId: "pattern-1",
      filesVersion: "files-abc"
    };

    assert.equal(
      sourceFileScanCacheKey({
        ...base,
        resolvedFilters: [filter(0, "quote"), filter(2, "abb")]
      }),
      sourceFileScanCacheKey({
        ...base,
        resolvedFilters: [filter(2, "abb"), filter(0, "quote")]
      })
    );
  });

  it("separates scopes that differ in any component", () => {
    const key = (over: Partial<Parameters<typeof sourceFileScanCacheKey>[0]>) =>
      sourceFileScanCacheKey({
        patternId: "pattern-1",
        filesVersion: "files-abc",
        resolvedFilters: [filter(0, "quote")],
        ...over
      });

    const baseline = key({});

    assert.notEqual(baseline, key({ patternId: "pattern-2" }));
    assert.notEqual(baseline, key({ resolvedFilters: [filter(0, "manufacturer")] }));
    assert.notEqual(baseline, key({ resolvedFilters: [filter(1, "quote")] }));
    assert.notEqual(
      baseline,
      key({ resolvedFilters: [filter(0, "quote", "suffix")] })
    );
    // An unscoped key is not a scoped one — the scoped path is the only caller,
    // but a collision here would serve a rollup as if it were a scan.
    assert.notEqual(baseline, key({ resolvedFilters: [] }));
  });

  it("a changed file set makes every earlier entry unreachable", () => {
    // The invalidation mechanism in one assertion. Nothing deletes a cached
    // answer; a new filesVersion simply means no reader will ever ask for the
    // old key again. If this ever passes with EQUAL keys, a fix applied to a
    // pattern would keep serving its pre-fix file list.
    const base = {
      patternId: "pattern-1",
      resolvedFilters: [filter(0, "quote")]
    };

    assert.notEqual(
      sourceFileScanCacheKey({ ...base, filesVersion: "before-the-fix" }),
      sourceFileScanCacheKey({ ...base, filesVersion: "after-the-fix" })
    );
  });

  it("is stable across calls, so a hit is actually reachable", () => {
    const input = {
      patternId: "pattern-1",
      filesVersion: "files-abc",
      resolvedFilters: [filter(0, "quote")]
    };

    assert.equal(sourceFileScanCacheKey(input), sourceFileScanCacheKey(input));
  });

  it("carries a version prefix so a payload shape change can retire old entries", () => {
    assert.match(
      sourceFileScanCacheKey({
        patternId: "pattern-1",
        filesVersion: "files-abc",
        resolvedFilters: []
      }),
      /^sourcefiles:v1:pattern-1:files-abc:[0-9a-f]{64}$/
    );
  });
});
