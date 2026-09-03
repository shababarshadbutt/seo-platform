import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collisionWarning,
  normalizationProbeSummary
} from "./normalization-probe";
import type {
  NormalizationProbeRun,
  NormalizationProbedUrl,
  RedirectRuleImpactResponse
} from "./api";

function probedUrl(
  source: string,
  originalHealthy: boolean,
  variants: Array<{ url: string; healthy: boolean }>
): NormalizationProbedUrl {
  return {
    source,
    original: { status: originalHealthy ? 200 : 404, healthy: originalHealthy },
    variants: variants.map((variant) => ({
      kind: "strip" as const,
      url: variant.url,
      status: variant.healthy ? 200 : 404,
      healthy: variant.healthy
    }))
  };
}

function run(
  overrides: Partial<NormalizationProbeRun> & {
    totals?: Partial<NormalizationProbeRun["result"] extends null ? never : any>;
  } = {}
): NormalizationProbeRun {
  const { totals, ...rest } = overrides;

  return {
    id: "run-1",
    status: "COMPLETE",
    candidates_total: 10,
    sampled_total: 10,
    requests_total: 20,
    checked_on_staging: true,
    result: {
      urls: [],
      totals: {
        already_healthy: 0,
        resolved: 0,
        ambiguous: 0,
        unresolved: 0,
        ...(totals ?? {})
      },
      by_kind: { strip: 0, stripDropZero: 0 },
      pairs: [],
      recommended: null
    },
    error: null,
    started_at: "2026-09-04T00:00:00Z",
    completed_at: "2026-09-04T00:00:10Z",
    ...rest
  } as NormalizationProbeRun;
}

test("no run shows nothing", () => {
  assert.equal(normalizationProbeSummary(null, false).show, false);
});

test("a running probe says what it is doing", () => {
  const summary = normalizationProbeSummary(null, true);

  assert.equal(summary.show, true);
  assert.equal(summary.tone, "neutral");
});

// A pattern with no zero padding is not a failure and not a finding. Inventing a
// reassuring message for it would be noise on a screen that is already dense.
test("a pattern with no padded URLs shows nothing", () => {
  const summary = normalizationProbeSummary(
    run({ candidates_total: 0, sampled_total: 0 }),
    false
  );

  assert.equal(summary.show, false);
});

test("a failed run surfaces the reason rather than a blank", () => {
  const summary = normalizationProbeSummary(
    run({ status: "FAILED", error: "staging origin could not be derived" }),
    false
  );

  assert.equal(summary.tone, "warning");
  assert.match(summary.detail, /staging origin could not be derived/);
});

test("resolved URLs read as information, not a warning", () => {
  const summary = normalizationProbeSummary(
    run({ totals: { resolved: 7, unresolved: 3 } }),
    false
  );

  assert.equal(summary.tone, "info");
  assert.match(summary.headline, /7 URLs have a live normalized spelling/);
  assert.match(summary.detail, /Checked 10 of 10/);
  assert.match(summary.detail, /3 found no working spelling/);
});

// THE HITL CASE. It must outrank the good news in the headline, because it is the
// only outcome that needs a person.
test("ambiguity leads the headline and carries the rows to decide", () => {
  const ambiguousUrl = probedUrl("https://s.com/page-3-00/", false, [
    { url: "https://s.com/page-3-0/", healthy: true },
    { url: "https://s.com/page-3/", healthy: true }
  ]);
  const summary = normalizationProbeSummary(
    run({
      totals: { resolved: 4, ambiguous: 2 },
      result: {
        urls: [ambiguousUrl],
        totals: {
          already_healthy: 0,
          resolved: 4,
          ambiguous: 2,
          unresolved: 0
        },
        by_kind: { strip: 4, stripDropZero: 0 },
        pairs: [],
        recommended: null
      }
    } as never),
    false
  );

  assert.equal(summary.tone, "warning");
  assert.match(summary.headline, /2 need your decision/);
  assert.match(summary.detail, /has not chosen/);
  assert.equal(summary.ambiguous.length, 1);
});

// A live original AND a live variant is also a decision, not a resolution.
test("a URL that works as written and normalized is offered for decision", () => {
  const bothLive = probedUrl("https://s.com/page-3-00/", true, [
    { url: "https://s.com/page-3/", healthy: true }
  ]);
  const summary = normalizationProbeSummary(
    run({
      result: {
        urls: [bothLive],
        totals: {
          already_healthy: 0,
          resolved: 0,
          ambiguous: 1,
          unresolved: 0
        },
        by_kind: { strip: 0, stripDropZero: 0 },
        pairs: [],
        recommended: null
      }
    } as never),
    false
  );

  assert.equal(summary.ambiguous.length, 1);
});

test("nothing live is stated plainly, not dressed up", () => {
  const summary = normalizationProbeSummary(
    run({ totals: { unresolved: 10 } }),
    false
  );

  assert.equal(summary.tone, "warning");
  assert.match(summary.headline, /No normalized spelling answered/);
});

// THE ENVIRONMENT IS PART OF THE CLAIM. "7 resolved" means something different
// before and after cutover, and a screenshot must not be ambiguous about it.
test("every summary says which environment answered", () => {
  const staging = normalizationProbeSummary(
    run({ totals: { resolved: 7 } }),
    false
  );
  const production = normalizationProbeSummary(
    run({ totals: { resolved: 7 }, checked_on_staging: false }),
    false
  );
  const unknown = normalizationProbeSummary(
    run({ totals: { resolved: 7 }, checked_on_staging: null }),
    false
  );

  assert.match(staging.detail, /Checked against staging/);
  assert.match(production.detail, /Checked against production/);
  assert.doesNotMatch(unknown.detail, /Checked against/);
});

// --- the duplicate warning ---------------------------------------------------

function impact(
  collisions: RedirectRuleImpactResponse["collisions"]
): RedirectRuleImpactResponse {
  return {
    perRule: [],
    scanned: 0,
    anyRule: 0,
    overlapping: 0,
    collisions,
    files_scanned: 0,
    files_skipped: 0
  };
}

test("no collisions means no warning at all", () => {
  assert.equal(collisionWarning(null, 0), null);
  assert.equal(collisionWarning(impact([]), 0), null);
  assert.equal(
    collisionWarning(impact([{ ruleIndex: 0, duplicates: 0 }]), 0),
    null
  );
});

test("a duplicate count is stated with the consequence spelled out", () => {
  const warning = collisionWarning(
    impact([{ ruleIndex: 0, duplicates: 2897, truncated: false }]),
    0
  );

  assert.match(warning ?? "", /2,897 URLs would become duplicates/);
  assert.match(warning ?? "", /same address more than once/);
});

// A number an operator reads before an irreversible button must not overstate its
// own precision.
test("a truncated count is reported as a floor", () => {
  const warning = collisionWarning(
    impact([{ ruleIndex: 1, duplicates: 250000, truncated: true }]),
    1
  );

  assert.match(warning ?? "", /at least 250,000/);
});

test("the warning is matched to the right rule", () => {
  const both = impact([
    { ruleIndex: 0, duplicates: 0 },
    { ruleIndex: 1, duplicates: 5 }
  ]);

  assert.equal(collisionWarning(both, 0), null);
  assert.match(collisionWarning(both, 1) ?? "", /5 URLs/);
});
