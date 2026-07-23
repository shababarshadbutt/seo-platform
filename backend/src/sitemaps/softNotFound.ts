// Shared "not-found / soft-404" signal vocabulary + a URL-level classifier.
//
// SOFT_404_TEXT_SIGNALS is the single source of truth for the phrases that mark
// a page as a soft-404 landing page. It is consumed BOTH by the HTTP sampler
// (matched against the fetched response BODY during sampling) and by the Fix
// Redirect URLs modal, which flags redirect DESTINATIONS that look like a
// not-found page (v1.42.1). Keeping one list means the two paths can never
// drift apart.
//
// NOTE on the destination check: the modal does NOT re-fetch every destination
// (that would be a second sampling pass over the whole pattern). Instead it
// reuses this vocabulary at the URL level — matching the phrases + explicit
// "not-found" query/path markers against the destination URL string. So a
// destination is flagged when its URL literally advertises a not-found landing
// page (e.g. ".../straightrfq?ref=part-not-found&partNumber=..."), not from a
// body/weighted score, which is only available for URLs that were sampled.
export const SOFT_404_TEXT_SIGNALS = [
  "no entity selected",
  "page not found",
  "404",
  "not found",
  "no results",
  "no data found",
  "does not exist"
];

// Whether a URL looks like a not-found / soft-404 landing page from its string
// alone (path + query), used to flag redirect destinations worth deleting
// rather than adopting. Conservative on the bare "404" signal (standalone token
// only) so an arbitrary part number containing digits is never flagged.
//
// IMPORTANT: this is a URL-STRING HEURISTIC, not an HTTP-verified soft-404. It
// only fires when the URL literally advertises a not-found page; it never
// fetches the destination, so a not-found page with an innocuous URL is NOT
// caught here. Callers should treat a match as a strong hint, not proof.
export function looksLikeNotFoundUrl(rawUrl: string): boolean {
  let decoded: string;

  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    decoded = rawUrl;
  }

  const lower = decoded.toLowerCase();

  // Explicit "not-found" marker anywhere (ref=not-found, ref=part-not-found,
  // /not-found/, notFound, not_found, …). \b before "not" lets it match inside
  // "part-not-found" (the hyphen is a word boundary).
  if (/\bnot[-_ ]?found\b/.test(lower)) {
    return true;
  }

  // Reuse the soft-404 phrase list against the URL with separators normalised to
  // spaces, so "page-not-found" / "no_results" read as their phrases.
  const normalized = lower.replace(/[-_+/?&=]/g, " ");

  return SOFT_404_TEXT_SIGNALS.some((signal) => {
    if (signal === "404") {
      return /\b404\b/.test(normalized);
    }

    return normalized.includes(signal);
  });
}
