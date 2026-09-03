// What the results page says about WHICH ENVIRONMENT produced the numbers on it.
//
// WHY THIS IS A LIB MODULE. `npm test` in this package runs lib/**/*.test.ts and
// nothing under app/, so any logic left inline in the 9,000-line results page is
// untestable by construction. The wording here is the whole point of the feature's
// UI half — a screenshot of a results table must never be ambiguous about which
// server it describes — so it is exactly the kind of thing that needs a test.
//
// Driven by the ROWS (session.checked_environments), never by the current toggle.
// The toggle says what the NEXT run will do; the rows say what THIS data already
// is, and after a flip those disagree. Reading the toggle here is how a page ends
// up labelling production numbers as staging.
import { normalizeHost } from "./host";

export type CheckedEnvironments = {
  prod: number;
  staging: number;
};

export type CheckedEnvironmentBanner = {
  // "none" renders nothing: a session with no verdicts yet has no environment to
  // report, and an empty banner would just be noise on a fresh session.
  kind: "none" | "prod" | "staging" | "mixed";
  text: string;
  // Mixed is a real inconsistency the user should resolve, so it gets the amber
  // treatment. A clean staging run is INFORMATION, not a warning — it is what the
  // user asked for — but it still must be impossible to miss in a screenshot.
  tone: "neutral" | "info" | "warning";
};

function hostLabel(origin: string | null | undefined): string {
  if (!origin) {
    return "";
  }

  try {
    return normalizeHost(new URL(origin).hostname);
  } catch {
    return origin;
  }
}

export function describeCheckedEnvironment(
  counts: CheckedEnvironments | null | undefined,
  origins: { prod: string; staging?: string | null }
): CheckedEnvironmentBanner {
  const prod = counts?.prod ?? 0;
  const staging = counts?.staging ?? 0;

  if (prod === 0 && staging === 0) {
    return { kind: "none", text: "", tone: "neutral" };
  }

  if (staging === 0) {
    return {
      kind: "prod",
      text: `Checked against production — ${hostLabel(origins.prod)}`,
      tone: "neutral"
    };
  }

  if (prod === 0) {
    return {
      kind: "staging",
      text: `Checked against staging — ${hostLabel(origins.staging ?? "")}`,
      tone: "info"
    };
  }

  // THE MIXED CASE, and it WILL happen: re-checking one pattern after a flip
  // leaves the rest of the session on the other environment. Two numbers in one
  // table measured against two different servers is the single most misleading
  // state this feature can produce, so it says so plainly and tells the user how to
  // resolve it.
  return {
    kind: "mixed",
    text:
      `Mixed environments — ${staging.toLocaleString()} checked on staging, ` +
      `${prod.toLocaleString()} on production. Re-check to make this consistent.`,
    tone: "warning"
  };
}
