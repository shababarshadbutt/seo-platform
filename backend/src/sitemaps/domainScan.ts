import { isSameDomain, normalizeHost } from "./domain.js";
import { streamSitemapUrlLocs } from "./parser.js";

// Normalize the hostname of a single <loc> URL, or null when the value is not
// an http(s) URL (relative locs, mailto:, garbage, …) — those can never be a
// cross-domain signal so they are ignored.
export function hostFromLoc(loc: string): string | null {
  try {
    const url = new URL(loc);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

// Return the first hostname in a sitemap file that does NOT belong to the
// session's site, or null when every URL is same-site.
//
// This streams the ENTIRE file through a sax pass (O(n), no full-file
// buffering) instead of sampling the first few kilobytes. Sampling let
// mixed-domain files slip through whenever the foreign URLs appeared only
// after a run of legitimate same-site URLs; a full stream cannot miss them.
// The stream stops the moment a foreign host is seen, so a clean 50k-URL file
// is still a single fast linear pass and a mixed file exits even sooner.
export async function detectForeignHostInFile(
  storedFilename: string,
  expectedHost: string
): Promise<string | null> {
  let foreignHost: string | null = null;

  await streamSitemapUrlLocs(
    storedFilename,
    (loc) => {
      const host = hostFromLoc(loc);

      if (host && !isSameDomain(host, expectedHost)) {
        foreignHost = host;

        // One mismatch is enough to reject the file — stop streaming.
        return false;
      }

      return true;
    },
    { includeIndexLocs: true }
  );

  return foreignHost;
}
