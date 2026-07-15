// Shared host-comparison logic for sitemap URL domain-mismatch detection.
// Used by both the upload-time host check (routes/sessions.ts) and the
// extraction-time per-URL mismatch flagging (jobs/extractPatternsJob.ts) so the
// two paths can never disagree about what counts as "the same site".

// Normalize a hostname for comparison: lowercase and drop a leading "www."
// (only the www label, never an arbitrary subdomain).
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

// Whether a URL's host belongs to the same site as the session base URL.
// Subdomains of the base host count as the same site — e.g. shop.example.com
// and parts.example.com both belong to example.com — because SEO teams
// legitimately spread one site's URLs across subdomains. A bare "www." is
// already collapsed by normalizeHost, so www.example.com === example.com.
//
// Guards against look-alike hosts:
//   - example.com vs example.com.au   -> different (not a subdomain match)
//   - example.com vs notexample.com   -> different (no dot boundary)
export function isSameDomain(
  detectedHost: string,
  expectedHost: string
): boolean {
  const detected = normalizeHost(detectedHost);
  const expected = normalizeHost(expectedHost);

  if (detected === expected) {
    return true;
  }

  // A subdomain of the expected host: the detected host ends with
  // ".<expected>", which enforces a label boundary so "notexample.com" does
  // not match "example.com".
  return detected.endsWith(`.${expected}`);
}
