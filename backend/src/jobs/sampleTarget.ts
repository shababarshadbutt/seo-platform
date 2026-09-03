// How a sampled path is turned into the URL that actually gets probed.
//
// Its own module, like sampleHttpStatus.ts, so unit tests can import it without
// dragging in samplePatternsJob -> sessionCompletion -> preGenerateZipQueue,
// which opens a Redis connection at module load and hangs the test process.
import { normalizeHost } from "../sitemaps/domain.js";

export function targetUrlForPath(baseUrl: string, path: string) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  return `${normalizedBaseUrl}${normalizedPath}`;
}

// Which URL to actually probe for a sampled path.
//
// Paths are normally re-hosted onto base_url, which is deliberate: it lets a
// session check one site's sitemap against another environment. But when
// base_url and the sitemap's own <loc> differ ONLY by the "www." label, that
// re-hosting sends the request to the wrong variant of the same site, and the
// answer describes the www redirect rather than the page:
//
//   base_url https://example.com + loc https://www.example.com/a
//     -> probes https://example.com/a -> 301 to https://www.example.com/a
//     -> recorded as "redirect", and any REAL redirect on the www host is never
//        seen, because only one hop is followed. On hosts whose apex has no
//        valid certificate it is recorded as an outright failure instead.
//
// So when the hosts are www-equivalent, probe the sitemap's own URL. Genuinely
// different hosts still get re-hosted onto base_url exactly as before —
// isSameDomain's subdomain allowance is deliberately NOT reused here, since
// probing shop.example.com when the user asked for example.com would change
// which page is being checked.
//
// WHAT THIS FUNCTION DOES NOT DO: private routing. It returns the PUBLIC identity
// of the page — the URL that gets stored in sampled_urls.url, shown in findings and
// compared against sitemap <loc> values. Rewriting its scheme to http for a
// privately-routed host would put "http://..." in the database for a site whose
// sitemap says https, silently changing user-visible data.
//
// The private scheme is applied one layer down, at the moment of the request, in
// sampleUrlCheck.runCheckWithProfile. Identity and transport are deliberately two
// different values.
//
// AND FOR THE SAME REASON: DO NOT ADD THE STAGING HOST SWAP HERE. It looks like the
// natural home for it — one function, pure, already the place base_url meets the
// path — and it is the wrong one. The 1.90/2.0 toggle sends health checks to a
// dev/staging host while the sitemap files stay production, so the staging host
// must NEVER reach this return value:
//
//   * it becomes sampled_urls.url, which is REWRITE-PARTICIPATING — UPDATEd in
//     lockstep with the XML by bulkReplaceJob and patternStructureJob, and
//     cross-joined against verified_urls.url as raw text by maintenanceJobs
//     (AND s.url = ANY($3::text[])). A dev host on one side and the prod <loc> on
//     the other makes that match return zero rows, and delete-by-status silently
//     stops marking anything;
//   * collectProblemFileGroups then scans the PRODUCTION XML for strings that are
//     not in it;
//   * and it is what every finding, export and Fix-modal row shows the user.
//
// The staging swap lives with the private-scheme swap, at the moment of the
// request: sampleUrlCheck.runCheckWithProfile, via http/stagingOrigin.ts.
export function resolveSampleTarget(
  baseUrl: string,
  path: string,
  sourceUrl: string | null
): string {
  const fallback = targetUrlForPath(baseUrl, path);

  if (!sourceUrl) {
    return fallback;
  }

  try {
    const source = new URL(sourceUrl);
    const base = new URL(baseUrl);

    if (source.protocol !== "http:" && source.protocol !== "https:") {
      return fallback;
    }

    const sameHost = source.hostname.toLowerCase() === base.hostname.toLowerCase();
    const wwwEquivalent =
      normalizeHost(source.hostname) === normalizeHost(base.hostname);

    // Only the www-label case is redirected to the sitemap's own URL. Identical
    // hosts already agree, so nothing changes for them.
    return !sameHost && wwwEquivalent ? source.toString() : fallback;
  } catch {
    return fallback;
  }
}
