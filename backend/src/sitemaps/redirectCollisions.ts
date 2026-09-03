import { applyRedirectRule, type RedirectRule } from "./redirectRule.js";

// How many <loc> entries a rule would COLLAPSE INTO DUPLICATES.
//
// WHY THIS IS NEEDED NOW. Every rule kind before normalizeDigits was a literal
// edit, and two different URLs edited literally stay two different URLs. This one
// is a function of a digit run's VALUE, so "page-1-3", "page-1-03" and
// "page-1-003" all normalize to the SAME destination. Apply it to a sitemap
// carrying more than one spelling and the file ends up with the same <loc> twice.
//
// Nothing downstream would notice. rewriteLocs rewrites in place and does not
// de-duplicate — the Cleaner does that, across files, first-occurrence-wins with a
// CSV report (sitemaps/cleaner.ts), but the Migration path deliberately does not.
// So without this the collapse is silent, and the operator finds out from the
// published sitemap.
//
// THE COUNT IS EXACT, and falls out of one observation: what matters is not which
// URLs the rule rewrites but what every URL ENDS UP AS. A URL the rule does not
// touch still occupies its own spelling, and can still be the thing a rewritten
// URL collides with. So count final spellings, and every entry beyond the first
// for a given spelling is a duplicate.
//
// Pure, and fed one <loc> at a time by the same streaming scan RedirectRuleImpact
// uses. It is a SEPARATE class rather than another field on that one because it
// answers a different question and pays a different cost: impact is three
// counters, this holds a map keyed by destination.

// Beyond this many DISTINCT final spellings, stop growing the map and report the
// count as a floor rather than a total.
//
// A pattern can hold ~1.3M URLs, and an unbounded map of that many strings is the
// shape of allocation that has twice put this project into a heap wall. A warning
// does not need to be exact at that scale — "at least 2,897" answers the operator's
// question just as well as an exact number — but it does need to be HONEST about
// being a floor, which is what `truncated` is for.
const DISTINCT_DESTINATION_LIMIT = 250_000;

export type CollisionTotals = {
  // In-scope URLs offered.
  scanned: number;
  // Entries that would share a spelling with an earlier entry after the rewrite.
  // This is the number to put in front of an operator.
  duplicates: number;
  // Distinct spellings that end up carrying more than one entry.
  collidingDestinations: number;
  // True when the distinct-destination cap was hit, so `duplicates` is a floor.
  truncated: boolean;
};

export class RedirectCollisionCounter {
  private readonly rule: RedirectRule;
  private readonly counts = new Map<string, number>();
  private scanned = 0;
  private truncated = false;

  constructor(rule: RedirectRule) {
    this.rule = rule;
  }

  offer(url: string): void {
    this.scanned += 1;

    // applyRedirectRule returns null when the rule does nothing here — and such a
    // URL still occupies its own spelling, so it counts. Leaving it out would miss
    // exactly the case this exists to catch: an untouched "page-1-3" colliding
    // with a rewritten "page-1-003".
    const finalUrl = applyRedirectRule(url, this.rule) ?? url;
    const seen = this.counts.get(finalUrl);

    if (seen !== undefined) {
      this.counts.set(finalUrl, seen + 1);

      return;
    }

    if (this.counts.size >= DISTINCT_DESTINATION_LIMIT) {
      this.truncated = true;

      return;
    }

    this.counts.set(finalUrl, 1);
  }

  totals(): CollisionTotals {
    let duplicates = 0;
    let collidingDestinations = 0;

    for (const count of this.counts.values()) {
      if (count > 1) {
        duplicates += count - 1;
        collidingDestinations += 1;
      }
    }

    return {
      scanned: this.scanned,
      duplicates,
      collidingDestinations,
      truncated: this.truncated
    };
  }
}
