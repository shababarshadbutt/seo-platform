import type {
  NormalizationProbeRun,
  NormalizationProbedUrl,
  RedirectRuleImpactResponse
} from "./api";

// What a normalization probe run MEANS on screen.
//
// In lib/ because `npm test` runs lib/**/*.test.ts and nothing under app/, so
// wording left inline in the 9,000-line results page cannot be tested at all. And
// this wording carries claims an operator acts on — how many URLs a rewrite would
// collapse, and which environment the evidence came from — so it is exactly the
// kind that needs pinning.

export type ProbeSummary = {
  // Nothing to show: no run yet, or a run that found no padded URLs.
  show: boolean;
  headline: string;
  detail: string;
  tone: "neutral" | "info" | "warning";
  // URLs where more than one spelling answered. These are the human's to decide.
  ambiguous: NormalizationProbedUrl[];
};

const EMPTY: ProbeSummary = {
  show: false,
  headline: "",
  detail: "",
  tone: "neutral",
  ambiguous: []
};

// Which environment answered. Load-bearing rather than decorative: the normalized
// URLs are expected to exist only on the new site, so a run that says "resolved"
// is usually saying "resolved ON STAGING" — and after cutover that is a different
// claim from "resolved on production".
function environmentNote(run: NormalizationProbeRun): string {
  if (run.checked_on_staging === null) {
    return "";
  }

  return run.checked_on_staging
    ? " Checked against staging."
    : " Checked against production.";
}

export function normalizationProbeSummary(
  run: NormalizationProbeRun | null,
  running: boolean
): ProbeSummary {
  if (running) {
    return {
      show: true,
      headline: "Checking which normalized spellings exist…",
      detail:
        "Probing each padded URL and its normalized readings against the site.",
      tone: "neutral",
      ambiguous: []
    };
  }

  if (!run) {
    return EMPTY;
  }

  if (run.status === "FAILED") {
    return {
      show: true,
      headline: "The normalization check could not finish",
      detail: run.error ?? "No reason was recorded.",
      tone: "warning",
      ambiguous: []
    };
  }

  if (run.status !== "COMPLETE" || !run.result) {
    return EMPTY;
  }

  // A pattern with no zero-padded URLs is not a failure and not a finding — but
  // this only renders after someone PRESSED a button, and silence there is
  // indistinguishable from the button not working. So it reports the empty
  // result rather than hiding.
  //
  // Worded as "sampled URLs" because two different situations reach here — a
  // pattern whose URLs carry no padding, and one whose sample pool was never
  // built — and the run does not record which. Naming the thing that was actually
  // looked at is true of both.
  if (run.candidates_total === 0) {
    return {
      show: true,
      headline: "No zero-padded URLs in this pattern",
      detail:
        "None of this pattern's sampled URLs carry a padded number, so there is nothing to normalize.",
      tone: "neutral",
      ambiguous: []
    };
  }

  const { totals } = run.result;
  const ambiguous = run.result.urls.filter(
    (url) => url.variants.some((v) => v.healthy) && countHealthy(url) > 1
  );
  const environment = environmentNote(run);
  const scope = `Checked ${run.sampled_total} of ${run.candidates_total} URLs with zero padding.`;

  if (totals.resolved === 0 && totals.ambiguous === 0) {
    return {
      show: true,
      headline: "No normalized spelling answered",
      detail: `${scope} None of the normalized URLs exist, so there is nothing to redirect to.${environment}`,
      tone: "warning",
      ambiguous: []
    };
  }

  const parts = [scope];

  if (totals.resolved > 0) {
    parts.push(
      `${totals.resolved} resolved to a normalized spelling that is live.`
    );
  }

  if (totals.unresolved > 0) {
    parts.push(`${totals.unresolved} found no working spelling.`);
  }

  if (totals.already_healthy > 0) {
    parts.push(`${totals.already_healthy} already work as written.`);
  }

  if (totals.ambiguous > 0) {
    return {
      show: true,
      headline: `${totals.ambiguous} need your decision`,
      // The whole reason a person is being asked: the tool measured more than one
      // live answer and will not pick between them.
      detail: `${parts.join(" ")} More than one spelling answers for ${totals.ambiguous}, so the tool has not chosen.${environment}`,
      tone: "warning",
      ambiguous
    };
  }

  return {
    show: true,
    headline: `${totals.resolved} URLs have a live normalized spelling`,
    detail: `${parts.join(" ")}${environment}`,
    tone: "info",
    ambiguous: []
  };
}

function countHealthy(url: NormalizationProbedUrl): number {
  return (
    url.variants.filter((variant) => variant.healthy).length +
    (url.original.healthy ? 1 : 0)
  );
}

// The duplicate warning for one rule, or null when there is nothing to warn about.
//
// Phrased as a floor when the counter was truncated, because a number an operator
// reads before pressing an irreversible button must not overstate its own
// precision.
export function collisionWarning(
  impact: RedirectRuleImpactResponse | null,
  ruleIndex: number
): string | null {
  const entry = impact?.collisions?.find(
    (candidate) => candidate.ruleIndex === ruleIndex
  );

  if (!entry || !entry.duplicates) {
    return null;
  }

  const count = entry.truncated
    ? `at least ${entry.duplicates.toLocaleString()}`
    : entry.duplicates.toLocaleString();

  return `${count} URLs would become duplicates of another URL in this pattern. The sitemap will contain the same address more than once.`;
}
