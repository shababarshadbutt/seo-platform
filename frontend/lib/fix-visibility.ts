// Visibility rule for the pattern table's Fix button.
//
// The button keys off the pattern's STATUS alone, not off whether a redirect
// happened to land in the ≤ sample_size sampled URLs: a Broken pattern whose
// tiny sample is all 404s (e.g. total_urls = 1) still needs its Fix entry
// point, and a Healthy pattern hides Fix even when its sample contains a
// redirect — per the SEO team's spec, only Broken/Warning are fixable.
export type PatternStatus = "GOOD" | "WARNING" | "BAD" | "UNKNOWN";

export function showFixButton(row: { status: PatternStatus }): boolean {
  return row.status === "BAD" || row.status === "WARNING";
}

// Visibility rule for the pattern table's CHECK button — the entry point for a
// pattern nothing is known about yet.
//
// Deliberately a SECOND function rather than a mode flag on showFixButton. The
// two answer different questions and must not be collapsed: Fix means "a problem
// is confirmed, act on it" (BAD/WARNING), Check means "we have no measurement,
// go get one" (UNKNOWN). Conflating those two states is exactly how the original
// bug happened — samplePatternsJob wrote BAD for a pattern it had never sampled,
// so "confirmed broken" and "never checked" became indistinguishable.
//
// UNKNOWN is what the backend's PENDING status normalises to on the frontend
// (normalizeStatus maps anything outside GOOD/WARNING/BAD to UNKNOWN), so this
// covers never-scored patterns without the frontend needing to know the enum.
//
// GOOD is deliberately excluded, matching the note above: a healthy, already-
// verified pattern has neither a problem to fix nor an unknown to resolve, so it
// correctly shows no button at all.
export function showCheckButton(row: { status: PatternStatus }): boolean {
  return row.status === "UNKNOWN";
}

// What the pattern table's action cell shows, as ONE answer instead of two
// independent booleans.
//
// WHAT WAS WRONG. The two predicates above are exhaustive over status, and
// neither of them has a state for "this one is done". A successful fix rewrites
// the sampled rows in place (url becomes final_url, category becomes 'success' —
// applyRedirectsJob) and the row is rescored, so a fixed pattern lands on GOOD
// and its button disappears. That is indistinguishable from a pattern that was
// healthy all along, and on a table of hundreds of rows it left reviewers
// reopening patterns to find out whether they had already dealt with them.
//
// "fixed" therefore OUTRANKS both — it is a fact about what was done to the
// pattern, not a reading of its current measurement, and it stays true whatever
// a later re-check decides. A pattern that was fixed and has since gone Broken
// again still shows "fixed": the useful thing to know at a glance is that a fix
// was already attempted here, and the row's own Status cell is what reports the
// current verdict. Conflating the two is what this whole state exists to stop.
export type FixButtonState = "fix" | "fixed" | "check" | "none";

export function fixButtonState(row: {
  status: PatternStatus;
  redirectsAppliedAt?: string | null;
}): FixButtonState {
  if (row.redirectsAppliedAt) {
    return "fixed";
  }

  if (showFixButton(row)) {
    return "fix";
  }

  return showCheckButton(row) ? "check" : "none";
}

// The badge and the ACTION are two answers, not one (v1.74).
//
// WHAT WAS WRONG. fixButtonState returns "fixed" and the row renders an inert
// grey chip INSTEAD of the Fix button, so a fixed pattern had no way back in. On
// the reported session two patterns showed Fixed, a third reported "0 URLs
// updated", and there was no route to reopen any of them and find out why.
//
// "fixed" outranking the current status is still right — it is a fact about what
// was done, not a reading of the latest measurement, and the comment above
// explains why. What was wrong is that it suppressed the action as well as
// answering the question. A pattern that was fixed can still need previewing,
// re-fixing after a re-analysis, or simply looking at.
export function fixActionState(row: {
  status: PatternStatus;
  redirectsAppliedAt?: string | null;
}): Exclude<FixButtonState, "fixed"> {
  if (showFixButton(row)) {
    return "fix";
  }

  return showCheckButton(row) ? "check" : "none";
}

// Is this pattern showing a Fixed badge?
export function showFixedBadge(row: {
  redirectsAppliedAt?: string | null;
}): boolean {
  return Boolean(row.redirectsAppliedAt);
}

// Do this pattern's URL counts predate its last fix?
//
// THE ROOT CAUSE OF THE REPORTED CONFUSION. apply-redirects rewrites the <loc>
// entries and then recomputes only redirect_pct and confidence_pct — it never
// re-extracts pattern_urls, pattern_file_occurrences or total_urls. So once a
// pattern has been fixed, its occurrence count, coverage and URL list describe
// the PRE-FIX files, and its template no longer matches what is on disk.
//
// That is why a second apply reports "0 URLs updated" and why the Update Pattern
// modal says "No source files found" while the table still shows 6,969
// occurrences: both are correct readings of stale inputs. Saying so is what makes
// the zeros comprehensible instead of looking like a broken tool.
//
// Cleared by a re-analysis for free: extraction DELETEs and re-INSERTs the
// pattern rows, so redirects_applied_at comes back NULL on a fresh row. That is
// why this needs no separate timestamp to compare against.
export function hasStaleCountsAfterFix(row: {
  redirectsAppliedAt?: string | null;
}): boolean {
  return Boolean(row.redirectsAppliedAt);
}
