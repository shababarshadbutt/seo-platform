// Which numbers the Fix Redirect URLs modal reports once "Limit this edit to"
// has a structure selected (v1.55).
//
// Extracted as pure functions for the same reason fix-accept-count.ts,
// fix-visibility.ts and fix-status-filter.ts are: results/page.tsx has no test
// file, so logic left in the component is logic nothing can assert.
//
// THE TRAP THIS EXISTS TO AVOID. There are two very different "how many URLs"
// numbers in play, and they can differ by an order of magnitude:
//
//   * the DROPDOWN count — "nsn-parts-{var} (613)" — is POOL-relative.
//     getPatternStructures bounds its URL pool at ~1,000 rows server-side, so
//     613 means "613 of the sampled pool", not 613 in the pattern.
//   * the SCOPED OCCURRENCE count comes from source-files, which scans each
//     candidate file's real <loc> entries with the same test the real edit
//     applies (scopedPatternSourceFileBreakdown). That is the true rewrite
//     scope, and can be ~21,000 where the dropdown says 613.
//
// In the Update Pattern modal the pooled number sits far from any action. In the
// Fix modal it would sit inches from the Accept button, so the rule is: anything
// describing what a CLICK will do uses the occurrence count, never the pool.

export type FixScopeInput = {
  // patterns.total_urls — the whole pattern's real occurrence count.
  patternTotal: number;
  // Sum of occurrences from source-files for the selected structure(s), or null
  // while that request is still in flight / failed.
  scopedOccurrences: number | null;
  // Is any dropdown off "Any structure"?
  hasScope: boolean;
};

// The denominator every count in the dialog is measured against: the whole
// pattern when unscoped, the structure's real occurrence count when scoped.
//
// Returns patternTotal while a scoped count is still loading rather than 0. A
// transient 0 would flip the Accept button to "(0)" and read as "nothing will
// change" for a scope that is about to report thousands — the count is allowed
// to be stale for a moment, never wrong in the alarming direction.
export function scopedFixTotal(input: FixScopeInput): number {
  if (!input.hasScope || input.scopedOccurrences === null) {
    return input.patternTotal;
  }

  return input.scopedOccurrences;
}

// Is the chosen combination real? Clusters at each position are detected
// independently over all URLs, so nothing guarantees the intersection of two of
// them is non-empty. Surfaced in the UI and used to block Accept, so the user
// finds out here rather than from a job that rewrites nothing.
//
// Distinguished from "still loading" on purpose: only a settled 0 counts.
export function fixScopeMatchesNothing(input: FixScopeInput): boolean {
  return input.hasScope && input.scopedOccurrences === 0;
}

// "nsn-parts-{var} + part-types-{var}" — the human name for the current
// combination, for the summary box and the toggle caption. Labels arrive from
// the dropdown selections, so they read the way the user picked them.
export function fixScopeLabel(labels: string[]): string {
  return labels.join(" + ");
}
