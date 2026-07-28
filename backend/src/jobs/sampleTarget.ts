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
