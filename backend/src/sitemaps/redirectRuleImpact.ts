import { applyRedirectRule, type RedirectRule } from "./redirectRule.js";

// How many URLs each approved rule would actually rewrite.
//
// WHY A COUNT AND NOT AN ESTIMATE. The rule shortlist reports "fits 3 of 10",
// which is about the SAMPLE — ten confirmed redirects. What an operator needs
// before pressing a button that rewrites files is the real number over the
// pattern: "2,300 URLs". Scaling the sample fit up to the population would be
// instant and would be a pooled estimate, which is the class of number that
// produced the 28,546-vs-10 complaint in the first place. So this counts.
//
// Pure, and fed one <loc> at a time by a streaming scan of the pattern's files
// (see routes' use of scanPatternFiles) — the population is never held.

export type RuleImpact = {
  ruleIndex: number;
  // URLs this rule would rewrite IF IT WERE FIRST. Independent per rule, so a
  // reader can compare options without re-running the scan per selection.
  matches: number;
};

export type RuleImpactTotals = {
  perRule: RuleImpact[];
  // URLs scanned that belong to this pattern (and pass any structure scope).
  scanned: number;
  // Distinct URLs at least one rule would rewrite. Equals the sum of perRule
  // when no URL is claimed twice, which is the expected case for the
  // category-per-rule shortlists these come from.
  anyRule: number;
  // URLs more than one rule matches. Expected to be 0: needles like
  // "product/safety/rfq" and "product/abrasives/rfq" cannot both match. Counted
  // rather than assumed, because summing per-rule numbers into a button label
  // would silently over-report if it ever happened — and a wrong number on that
  // button is the specific failure this project keeps having to fix.
  overlapping: number;
};

export class RedirectRuleImpact {
  private readonly rules: RedirectRule[];
  private readonly matches: number[];
  private scanned = 0;
  private anyRule = 0;
  private overlapping = 0;

  constructor(rules: RedirectRule[]) {
    this.rules = rules;
    this.matches = new Array(rules.length).fill(0);
  }

  // Offer one in-scope URL. The caller has already checked it belongs to the
  // pattern and passes any structure filter.
  offer(url: string): void {
    this.scanned += 1;

    let hits = 0;

    for (let index = 0; index < this.rules.length; index += 1) {
      const applied = applyRedirectRule(url, this.rules[index]);

      // applyRedirectRule returns null when the rule does not apply OR when it
      // would not change the URL — both mean "this rule does nothing here", which
      // is what must not be counted.
      if (applied !== null) {
        this.matches[index] += 1;
        hits += 1;
      }
    }

    if (hits > 0) {
      this.anyRule += 1;
    }

    if (hits > 1) {
      this.overlapping += 1;
    }
  }

  totals(): RuleImpactTotals {
    return {
      perRule: this.matches.map((count, index) => ({
        ruleIndex: index,
        matches: count
      })),
      scanned: this.scanned,
      anyRule: this.anyRule,
      overlapping: this.overlapping
    };
  }
}
