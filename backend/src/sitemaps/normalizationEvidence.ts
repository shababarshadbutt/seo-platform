// Reading a normalization probe run: what each URL's answers MEAN.
//
// Pure and separate from the job so the decision rules — what counts as healthy,
// when an outcome is ambiguous, which reading the evidence recommends — are
// testable without a database, a queue or a socket. The job does the I/O; this
// decides what the I/O showed.
import { deriveNormalizationRule, type RedirectRule } from "./redirectRule.js";
import type { NormalizationKind } from "./digitNormalization.js";

export type ProbeAnswer = {
  status: number | null;
  // A genuine 2xx that is not a soft 404.
  healthy: boolean;
};

export type ProbedVariant = ProbeAnswer & {
  kind: NormalizationKind;
  url: string;
};

export type ProbedUrl = {
  source: string;
  original: ProbeAnswer;
  variants: ProbedVariant[];
};

export type UrlOutcome =
  // The URL as written still works. Nothing to fix, and NOT evidence for any
  // rewrite — even if a variant also answered.
  | "already_healthy"
  // Broken as written, exactly one reading works. This is a source->dest pair.
  | "resolved"
  // More than one reading works, or the original works AND a variant does. A
  // person has to choose; the tool must not.
  | "ambiguous"
  // Nothing answered. Reported, never guessed at.
  | "unresolved";

// A 2xx that is not a soft 404. Everything else — 3xx, 4xx, 5xx, blocked, no
// response — is not proof that a page exists.
//
// 3xx deliberately does NOT count as healthy for a VARIANT. A redirect means the
// invented URL is not itself the destination, and following it would be inferring
// a second hop from a URL we made up.
export function isHealthy(status: number | null, isSoft404: boolean): boolean {
  return status !== null && status >= 200 && status < 300 && !isSoft404;
}

export function outcomeFor(probed: ProbedUrl): UrlOutcome {
  const healthyVariants = probed.variants.filter((variant) => variant.healthy);

  if (probed.original.healthy) {
    // The original works. If a variant works too, both spellings are live and
    // only a person can say which the sitemap should carry — that is the "if both
    // are working" case, and it must not resolve itself.
    return healthyVariants.length > 0 ? "ambiguous" : "already_healthy";
  }

  if (healthyVariants.length === 0) {
    return "unresolved";
  }

  return healthyVariants.length === 1 ? "resolved" : "ambiguous";
}

export type EvidenceSummary = {
  totals: Record<UrlOutcome, number>;
  // How many URLs each reading resolved on its own. What ranks one reading above
  // the other in the UI.
  byKind: Record<NormalizationKind, number>;
  // The confirmed source -> dest pairs, from RESOLVED urls only. Ambiguous ones
  // are excluded on purpose: a pair nobody has chosen is not evidence.
  pairs: { source: string; dest: string }[];
  // The rule those pairs support, or null when they support none.
  recommended: RedirectRule | null;
  // URLs a person still has to decide about.
  ambiguous: ProbedUrl[];
};

export function summarizeEvidence(probed: ProbedUrl[]): EvidenceSummary {
  const totals: Record<UrlOutcome, number> = {
    already_healthy: 0,
    resolved: 0,
    ambiguous: 0,
    unresolved: 0
  };
  const byKind: Record<NormalizationKind, number> = {
    strip: 0,
    stripDropZero: 0
  };
  const pairs: { source: string; dest: string }[] = [];
  const ambiguous: ProbedUrl[] = [];

  for (const url of probed) {
    const outcome = outcomeFor(url);

    totals[outcome] += 1;

    if (outcome === "ambiguous") {
      ambiguous.push(url);
      continue;
    }

    if (outcome !== "resolved") {
      continue;
    }

    const winner = url.variants.find((variant) => variant.healthy);

    if (winner) {
      byKind[winner.kind] += 1;
      pairs.push({ source: url.source, dest: winner.url });
    }
  }

  return {
    totals,
    byKind,
    pairs,
    // deriveNormalizationRule adopts a reading only when it explains EVERY pair,
    // so a pattern whose URLs disagree yields null rather than a rule that is
    // right for most of them.
    recommended: deriveNormalizationRule(pairs),
    ambiguous
  };
}
