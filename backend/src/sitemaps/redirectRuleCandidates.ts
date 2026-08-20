import {
  applyRedirectRule,
  diffPair,
  sameRule,
  type RedirectRule
} from "./redirectRule.js";

// The rewrite rules a human could choose from, when the machine refuses to
// choose for them.
//
// WHY THIS EXISTS. deriveRedirectRule answers "is there ONE unambiguous rule?"
// and returns null the moment two sampled pairs diff differently. That is the
// right answer for the automatic path — inferring a rewrite for 579,034 URLs
// from pairs that disagree is exactly the overreach v1.68 was written to stop.
//
// But it leaves a person who can SEE the right answer with no way to say so. On
// the reported pattern the modal said "the confirmed redirects were too varied
// to infer a single rewrite rule, so only the 0 reviewed URLs can be rewritten"
// — while a human looking at ten before/after pairs could tell at a glance which
// transformation was intended. This produces that shortlist, ranked, so the
// choice is theirs and the applying is still the server's.
//
// deriveRedirectRule is deliberately untouched. Two different questions.

export type RedirectRuleCandidate = {
  rule: RedirectRule;
  // How many of the supplied pairs this rule REPRODUCES.
  fits: number;
  total: number;
  // A pair it reproduces, so the UI can show the rule working rather than only
  // describing it.
  example: { source: string; dest: string } | null;
  // A pair it does NOT reproduce, where one exists. The more useful half of the
  // evidence: a rule at 8/10 is only safe to approve if you can see what the
  // other 2 would become.
  counterExample: { source: string; actual: string | null; expected: string } | null;
};

// Rank: best fit first, then the cheaper rule kind.
//
// "insert" before "replace" on equal fit because an insert is anchored on a
// literal prefix every URL in the pattern shares, while a replace acts on EVERY
// occurrence of its needle — the global-replace hazard that turns a find of "-"
// into a rewrite of every hyphen in the URL. Given two rules that explain the
// evidence equally well, the one with the narrower blast radius should be the
// one a tired operator accepts by default.
function candidateRank(candidate: RedirectRuleCandidate): number {
  return candidate.rule.kind === "insert" ? 0 : 1;
}

export function redirectRuleCandidates(
  pairs: { source: string; dest: string }[]
): RedirectRuleCandidate[] {
  const usable = pairs.filter(
    (pair) => pair.source && pair.dest && pair.source !== pair.dest
  );

  if (usable.length === 0) {
    return [];
  }

  // One reading per pair, deduplicated. sameRule rather than JSON equality so
  // this agrees with deriveRedirectRule about what "the same rule" means.
  const rules: RedirectRule[] = [];

  for (const pair of usable) {
    const rule = diffPair(pair.source, pair.dest);

    if (rule && !rules.some((existing) => sameRule(existing, rule))) {
      rules.push(rule);
    }
  }

  return rules
    .map((rule) => {
      let fits = 0;
      let example: RedirectRuleCandidate["example"] = null;
      let counterExample: RedirectRuleCandidate["counterExample"] = null;

      // SCORED BY APPLYING IT, not by counting how many pairs produced it.
      //
      // A rule derived from one pair frequently reproduces another whose own
      // diff looked different — the two decompositions differ, the outcome does
      // not. Counting derivations would understate a rule that is in fact
      // universal, and "fits 10 of 10" has to mean REPRODUCES 10 of 10 or the
      // number a human is about to trust is not the number they think it is.
      for (const pair of usable) {
        const applied = applyRedirectRule(pair.source, rule);

        if (applied === pair.dest) {
          fits += 1;
          example = example ?? pair;
        } else if (!counterExample) {
          counterExample = {
            source: pair.source,
            actual: applied,
            expected: pair.dest
          };
        }
      }

      return { rule, fits, total: usable.length, example, counterExample };
    })
    // A rule that reproduces nothing is noise: it was derived from a pair it
    // then failed to reproduce, which can happen when the diff is not
    // expressible as a global replace.
    .filter((candidate) => candidate.fits > 0)
    .sort(
      (a, b) => b.fits - a.fits || candidateRank(a) - candidateRank(b)
    );
}

// Is this rule one the server itself would have offered?
//
// THE AUTHORITY GUARANTEE. apply-redirects is deliberately built so "the client
// only says WHICH urls; the server recomputes their destinations, so a client
// can't inject arbitrary rewrites". Letting a human choose a rule must not
// weaken that: the choice is checked against the candidates the server derives
// from its OWN confirmed pairs, and anything else is refused. A caller cannot
// invent a rewrite, only pick from readings of evidence the server already has.
export function isOfferedRule(
  rule: RedirectRule,
  pairs: { source: string; dest: string }[]
): boolean {
  return redirectRuleCandidates(pairs).some((candidate) =>
    sameRule(candidate.rule, rule)
  );
}

// Narrow an untrusted body value to a RedirectRule. Shape only — whether it is
// ACCEPTABLE is isOfferedRule's job.
export function parseRedirectRule(raw: unknown): RedirectRule | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Record<string, unknown>;

  if (
    value.kind === "replace" &&
    typeof value.find === "string" &&
    typeof value.replace === "string" &&
    value.find.length > 0
  ) {
    return { kind: "replace", find: value.find, replace: value.replace };
  }

  if (
    value.kind === "insert" &&
    typeof value.prefix === "string" &&
    typeof value.insert === "string" &&
    value.insert.length > 0
  ) {
    return { kind: "insert", prefix: value.prefix, insert: value.insert };
  }

  return null;
}
