// WHICH FILES DOES AN APPLY OPEN? (v1.75)
//
// Exactly one answer, used by both apply paths. It used to be answered twice:
//
//   * the queued job built its targets from pattern_file_occurrences
//     unconditionally, so it opened every file the pattern spans;
//   * the inline route added that list ONLY when a rule had been derived, and
//     otherwise scanned just the files the confirmed sampled rows named.
//
// apply-redirects runs inline below FILE_REWRITE_PARALLEL_THRESHOLD files and
// queues above it, so the SAME apply reached a different set of files depending
// on how wide the pattern was. On a 187-file pattern (threshold 200) it ran
// inline: 579,034 URLs had confirmed destinations, the button said so, and 10
// were rewritten — the other 186 files were never opened, and a URL in an
// unopened file cannot be rewritten however many destinations are known.
//
// The reason the narrow scan looked safe is that it is safe WHEN a rule exists,
// because a rule needs the whole pattern to sweep. Confirmed exact destinations
// need it just as much and nothing said so.
//
// So: if this apply will change anything at all, the pattern's own file list is
// the scope. The rewriter no-ops on a file with no matching <loc> (see
// rewriteRedirectSourceFilesOnDisk), so an over-broad scope costs time and
// cannot cost correctness — which is the asymmetry that matters here, since an
// under-broad scope silently loses URLs and reports success.
//
// Deliberately NOT the fix: widening from verified_urls.source_files. That
// column is an empty set by design for stratified runs (v1.69 — a partial file
// list presented as complete is worse than none) and is per-row, so it can be
// partial for any row. pattern_file_occurrences is the only complete answer.

export interface ApplyFileScopeInput {
  // Files the confirmed rows named — sampled_urls.source_file plus whatever
  // verified_urls.source_files carried. Unioned in defensively; every one of
  // these should already be an occurrence file, and if a display-name mapping
  // ever drifts, over-broad is the harmless direction.
  sampledFiles: Iterable<string>;
  // pattern_file_occurrences for this pattern: the precise, complete set of
  // files the pattern's URLs live in.
  occurrenceFiles: Iterable<string>;
  // Confirmed exact destinations to swap.
  hasReplacements: boolean;
  // A whole-pattern rule, an approved rule list, or per-shape rules — anything
  // that sweeps <loc>s nobody enumerated.
  hasRule: boolean;
}

// Returns display filenames to scan. EMPTY MEANS EVERY FILE OF THE ROLE — the
// existing convention in both rewriteRedirectSourceFilesOnDisk and the job's
// target filter, kept rather than invented so neither caller needs a new branch.
export function applyFileScope(input: ApplyFileScopeInput): string[] {
  const occurrences = new Set(input.occurrenceFiles);

  // Nothing will be swept or swapped, so no widening is warranted: report the
  // files the rows named and let the caller decide there is nothing to do.
  if (!input.hasReplacements && !input.hasRule) {
    return Array.from(new Set(input.sampledFiles));
  }

  // No occurrence rows (sessions extracted before that table was populated).
  // The pattern's span is unknown, and the sampled files are known NOT to be
  // it — that is this bug. Fall back to the whole role rather than to a subset
  // that looks like an answer.
  if (occurrences.size === 0) {
    return [];
  }

  for (const file of input.sampledFiles) {
    occurrences.add(file);
  }

  return Array.from(occurrences);
}
