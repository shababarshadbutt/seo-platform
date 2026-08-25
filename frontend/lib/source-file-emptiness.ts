// Why the Update Pattern modal's source-file list is empty, in words.
//
// WHAT WAS WRONG. The list rendered one hardcoded sentence — "No source files
// found for this pattern." — for every way it could come back empty, and the
// scoped scan has four of them plus a request failure. On the reported session
// the "Limit this edit to" dropdown offered real structures with real counts
// (quote 885, manufacturer 115) while the list underneath showed 0 files and
// Preview was dead, with nothing on screen to say why or what to do.
//
// The two numbers legitimately disagree: the dropdown counts come from
// pattern_urls (a bounded sample of URLs recorded at extraction), while the file
// list comes from actually opening the sitemaps on disk. A pattern can have
// thousands of recorded URLs and still have nothing scannable — most often
// because its sitemaps were fetched from a URL and no local copy was ever
// written, which makes them read-only everywhere in the app, not missing.
//
// Kept as a pure function rather than inline JSX so the wording and, more
// importantly, the PRIORITY between simultaneous causes are unit-testable.
import type { ScopedSkipCounts } from "./api";

export type SourceFileEmptinessInput = {
  // Present only when the request was scoped to a structure; the unscoped
  // rollup opens no files and so reports no drops.
  skipped?: ScopedSkipCounts | null;
  // Does this pattern's recorded data predate its last fix? Pass
  // hasStaleCountsAfterFix(row) — this module deliberately does not re-derive
  // that rule, fix-visibility.ts owns it.
  staleAfterFix: boolean;
};

// The sentence shown when the list has no rows.
//
// ORDER MATTERS and is not arbitrary: several counters can be non-zero at once
// (a pattern spanning both remote and cleaned-up files), so this reports the
// cause with the most actionable remedy first, and only ever names one. Naming
// all of them would put the user in front of a list of four possibilities to
// eliminate, which is barely better than the bare zero this replaces.
export function sourceFileEmptinessMessage({
  skipped,
  staleAfterFix
}: SourceFileEmptinessInput): string {
  const plain = "No source files found for this pattern.";

  if (!skipped) {
    return plain;
  }

  // Each branch spells out its singular and plural form in full rather than
  // assembling one from fragments. It is more words here, but pronouns and verbs
  // both have to agree ("its upload was" / "their uploads were") and stitching
  // that together from helpers is how sentences like "1 file were fetched" get
  // shipped — which makes the message read as machine noise and get skimmed
  // past, defeating the point of writing it.

  // First, because no amount of widening the scope will help and there is no
  // remedy inside this modal: nothing was ever written to disk to edit.
  if (skipped.remote > 0) {
    return skipped.remote === 1
      ? "1 file for this pattern was fetched from a URL, so this session has no local copy to edit. Upload that sitemap file to edit it."
      : `${skipped.remote} files for this pattern were fetched from a URL, so this session has no local copy to edit. Upload those sitemap files to edit them.`;
  }

  if (skipped.unreadable > 0) {
    return skipped.unreadable === 1
      ? "1 file for this pattern is no longer on disk — its upload was cleaned up. Re-upload it to edit this pattern."
      : `${skipped.unreadable} files for this pattern are no longer on disk — their uploads were cleaned up. Re-upload them to edit this pattern.`;
  }

  // The next two share a counter — read successfully, matched nothing — and have
  // opposite remedies: a stale template needs a re-analysis, a narrow scope
  // needs widening. Checking staleAfterFix first is what separates them.
  if (skipped.no_matches > 0 && staleAfterFix) {
    return skipped.no_matches === 1
      ? "This pattern's URL counts predate its last fix, so its template no longer matches what is in the 1 file on disk. Re-run the analysis to refresh them."
      : `This pattern's URL counts predate its last fix, so its template no longer matches what is in the ${skipped.no_matches} files on disk. Re-run the analysis to refresh them.`;
  }

  if (skipped.no_matches > 0) {
    return skipped.no_matches === 1
      ? 'No URL in the 1 file for this pattern matches the structure selected above. Try "Any structure".'
      : `No URL in the ${skipped.no_matches} files for this pattern matches the structure selected above. Try "Any structure".`;
  }

  if (skipped.no_file_row > 0) {
    return skipped.no_file_row === 1
      ? "The 1 file this pattern was extracted from is no longer part of this session."
      : `The ${skipped.no_file_row} files this pattern was extracted from are no longer part of this session.`;
  }

  return plain;
}

// What the panel says when the request FAILED, as opposed to succeeding with
// nothing in it. Lives beside sourceFileEmptinessMessage because it answers the
// same question — what goes in that box when it has no rows — and the two must
// not drift into different voices.
//
// WHAT WAS WRONG. v1.80 stopped swallowing the error and interpolated
// error.message raw, which put a browser internal in front of the user:
// "Could not load this pattern's source files: signal is aborted without
// reason". That is an abort, and the abort is this request's own timeout.
//
// MATCH ON name, NEVER ON THE MESSAGE TEXT. The identical condition is worded
// differently depending on who reports it — undici (the Next proxy hop, Node 24)
// says "This operation was aborted", Chromium says "signal is aborted without
// reason" — so any check against the text is a check that silently stops working
// in the other runtime, or on a browser update. `name` is "AbortError" in both.
//
// And an AbortError reaching this particular caller can ONLY be the timeout:
// getPatternSourceFiles passes no init.signal, so fetchWithTimeout's own timer
// is the sole thing that can abort it. Do not widen this to cover navigation or
// unmount aborts without giving the caller a way to tell them apart — the two
// need opposite wording ("took too long" vs. say nothing at all).
export function sourceFileLoadErrorMessage(error: unknown): string {
  const isAbort =
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError";

  if (isAbort) {
    // Deliberately says what to do next. "Any structure" takes the DB-rollup
    // path on the backend and opens no files at all, so unlike a retry it is
    // guaranteed to return — that is real advice, not a consolation.
    return 'Scanning this pattern\'s sitemap files took too long to finish. It spans enough files that the scoped preview cannot complete in time — pick a narrower structure above, or switch to "Any structure", which reads recorded counts instead of opening files.';
  }

  return `Could not load this pattern's source files: ${
    error instanceof Error ? error.message : "request failed"
  }`;
}
