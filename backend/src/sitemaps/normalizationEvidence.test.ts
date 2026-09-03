import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isHealthy,
  outcomeFor,
  summarizeEvidence,
  type ProbedUrl
} from "./normalizationEvidence.js";

function answer(status: number | null, soft = false) {
  return { status, healthy: isHealthy(status, soft) };
}

function url(
  source: string,
  original: { status: number | null; soft?: boolean },
  variants: Array<{ kind: "strip" | "stripDropZero"; url: string; status: number | null; soft?: boolean }>
): ProbedUrl {
  return {
    source,
    original: answer(original.status, original.soft),
    variants: variants.map((v) => ({
      kind: v.kind,
      url: v.url,
      ...answer(v.status, v.soft)
    }))
  };
}

test("only a non-soft 2xx counts as healthy", () => {
  assert.equal(isHealthy(200, false), true);
  assert.equal(isHealthy(204, false), true);
  // A styled "not found" page served as 200 is the failure mode that would let a
  // whole pattern be rewritten onto URLs that do not exist.
  assert.equal(isHealthy(200, true), false);
  // A redirect means the invented URL is not itself the destination.
  assert.equal(isHealthy(301, false), false);
  assert.equal(isHealthy(404, false), false);
  assert.equal(isHealthy(null, false), false);
});

test("a broken original with one live variant is resolved", () => {
  const probed = url("https://s.com/page-1-003/", { status: 404 }, [
    { kind: "strip", url: "https://s.com/page-1-3/", status: 200 }
  ]);

  assert.equal(outcomeFor(probed), "resolved");
});

// THE HITL CASE, stated twice because it arises two ways.
test("two live variants are ambiguous, never auto-resolved", () => {
  const probed = url("https://s.com/page-3-00/", { status: 404 }, [
    { kind: "strip", url: "https://s.com/page-3-0/", status: 200 },
    { kind: "stripDropZero", url: "https://s.com/page-3/", status: 200 }
  ]);

  assert.equal(outcomeFor(probed), "ambiguous");
});

test("a live original AND a live variant is ambiguous, not already_healthy", () => {
  // Both spellings serve a page. Which one the sitemap should carry is an SEO
  // judgement (canonical, indexed, linked), not something a status code settles.
  const probed = url("https://s.com/page-3-00/", { status: 200 }, [
    { kind: "stripDropZero", url: "https://s.com/page-3/", status: 200 }
  ]);

  assert.equal(outcomeFor(probed), "ambiguous");
});

test("a live original with no live variant needs no fix", () => {
  const probed = url("https://s.com/page-3-00/", { status: 200 }, [
    { kind: "stripDropZero", url: "https://s.com/page-3/", status: 404 }
  ]);

  assert.equal(outcomeFor(probed), "already_healthy");
});

test("nothing live is unresolved, not a guess", () => {
  const probed = url("https://s.com/page-1-003/", { status: 404 }, [
    { kind: "strip", url: "https://s.com/page-1-3/", status: 404 }
  ]);

  assert.equal(outcomeFor(probed), "unresolved");
});

test("the summary recommends the reading every resolved pair supports", () => {
  const summary = summarizeEvidence([
    url("https://s.com/page-1-003/", { status: 404 }, [
      { kind: "strip", url: "https://s.com/page-1-3/", status: 200 }
    ]),
    url("https://s.com/page-2-007/", { status: 404 }, [
      { kind: "strip", url: "https://s.com/page-2-7/", status: 200 }
    ])
  ]);

  assert.equal(summary.totals.resolved, 2);
  assert.equal(summary.byKind.strip, 2);
  assert.deepEqual(summary.recommended, {
    kind: "normalizeDigits",
    dropZeroTokens: false
  });
});

// An ambiguous URL is not a pair. Counting it would let a reading nobody chose
// become the recommendation.
test("ambiguous urls are excluded from the pairs and surfaced for a human", () => {
  const summary = summarizeEvidence([
    url("https://s.com/page-1-003/", { status: 404 }, [
      { kind: "strip", url: "https://s.com/page-1-3/", status: 200 }
    ]),
    url("https://s.com/page-3-00/", { status: 404 }, [
      { kind: "strip", url: "https://s.com/page-3-0/", status: 200 },
      { kind: "stripDropZero", url: "https://s.com/page-3/", status: 200 }
    ])
  ]);

  assert.equal(summary.totals.ambiguous, 1);
  assert.equal(summary.pairs.length, 1);
  assert.equal(summary.ambiguous.length, 1);
  assert.equal(summary.ambiguous[0].source, "https://s.com/page-3-00/");
});

// Resolved pairs that disagree support no single reading, and the run must say so
// rather than recommending one that is right for half the pattern.
test("pairs that no single reading explains recommend nothing", () => {
  const summary = summarizeEvidence([
    url("https://s.com/page-1-003/", { status: 404 }, [
      { kind: "strip", url: "https://s.com/page-1-3/", status: 200 }
    ]),
    url("https://s.com/x-007/", { status: 404 }, [
      { kind: "strip", url: "https://s.com/totally-different/", status: 200 }
    ])
  ]);

  assert.equal(summary.totals.resolved, 2);
  assert.equal(summary.recommended, null);
});

test("an empty run summarizes to zeros and no recommendation", () => {
  const summary = summarizeEvidence([]);

  assert.deepEqual(summary.totals, {
    already_healthy: 0,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0
  });
  assert.equal(summary.recommended, null);
  assert.deepEqual(summary.pairs, []);
});
