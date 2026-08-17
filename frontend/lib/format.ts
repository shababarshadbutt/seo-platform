// Shared display formatters.
//
// These were duplicated per-page (formatNumber in 9 places, formatEta in 1).
// Only the two the Sitemap Cleaner progress panel needs are lifted here for
// now — the remaining formatNumber copies are left alone deliberately, since
// churning eight unrelated pages is regression surface this change has no
// reason to take on.

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

// Human-readable ETA (e.g. "2 min", "30 sec"). Moved verbatim from the
// results-page download overlay so the cleaner reads identically.
export function formatEta(seconds: number) {
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60);

    return `${minutes} min`;
  }

  return `${Math.max(1, Math.round(seconds))} sec`;
}
