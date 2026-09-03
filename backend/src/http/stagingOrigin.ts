// Sending a health check to the STAGING host while everything stored stays
// production. The 2.0 half of the 1.90 / 2.0 toggle.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE:
//
//   Every HOST-DERIVED value (rate-limit bucket, host-strategy key, private-route
//   lookup, concurrency ceiling) comes from the STAGED url.
//   Every STORED or USER-VISIBLE value (sampled_urls.url, verified_urls.url,
//   final_url, exports) comes from the PRODUCTION identity.
//
// That is the same identity-vs-transport split http/privateRoute.ts already makes
// one layer down, and for a sharper reason here: sampled_urls.url is
// rewrite-participating. It is UPDATEd in lockstep with the sitemap XML and
// cross-joined against verified_urls.url as raw text, so a staging host stored in
// it silently breaks delete-by-status and the problem-file grouping. See
// migrations/057_staging_checks.sql.
//
// WHY THIS IS NOT PART OF sampleTarget.ts. resolveSampleTarget's return value IS
// the identity — the URL that goes into the database and gets compared against
// sitemap <loc> values. Swapping the host there would change what the tool
// reports, not where it asks. The swap belongs at the moment of the request, in
// sampleUrlCheck.runCheckWithProfile, next to applyPrivateRoute.
//
// WHY THIS IS NOT privateHostMap. Private routing overrides DNS ONLY: same
// hostname, same SNI, same Host header, different address. Staging is a genuinely
// DIFFERENT host — different certificate, different SNI, different Host header,
// and a different server that may have its own WAF, its own auth and its own rate
// behaviour, and therefore deserves its own host_probe_profiles row and its own
// rate bucket. Filing staging's learned behaviour under the production hostname is
// exactly the mistake hostRateLimiter's "every identity use keeps the hostname"
// note warns about.
//
// The two COMPOSE, and the order is meaningful: staging picks WHICH host, private
// routing picks HOW to reach it. Applied in that order, a future dev.* line in the
// private host map works with no further change.
//
// Pure: no DB, no config, no network, no clock — so its tests mock nothing.
import { normalizeHost } from "../sitemaps/domain.js";

// The staging origin for a production base URL: strip "www.", prefix "dev.".
//
// www.asapsemi.com -> dev.asapsemi.com
//     asapsemi.com -> dev.asapsemi.com
//
// IDEMPOTENT: a base URL that already names a dev host is returned unchanged, so
// a session created directly against staging needs no special case anywhere.
//
// Scheme and port are PRESERVED. Any path is DROPPED — this returns an origin,
// which is what sessions.staging_base_url's CHECK constraint also enforces.
// Paths are identical between the two environments; that premise is what the
// whole feature rests on, so a path here would be meaningless.
//
// KNOWN LIMITATION, mitigated in the UI rather than here: a site already served
// from a subdomain (shop.example.com -> dev.shop.example.com) or on a multi-label
// public suffix may not follow this convention. That is what the per-session
// staging_base_url override is for, and why the New Analysis form shows the
// derived value as the field's placeholder BEFORE the session is created.
export function deriveStagingBaseUrl(baseUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (!host) {
    return null;
  }

  // Already a dev host: return the origin unchanged rather than producing
  // dev.dev.asapsemi.com.
  const stagingHost = host.startsWith("dev.") ? host : `dev.${normalizeHost(host)}`;

  return originOf(url.protocol, stagingHost, url.port);
}

// The staging origin actually in effect for a session: the explicit override
// wins, otherwise derive it. null means "no staging origin is available", which
// callers must treat as an error in 2.0 mode, never as a fallback to production —
// silently measuring the wrong server is the failure this whole column exists to
// prevent.
export function resolveStagingOrigin(
  baseUrl: string,
  override: string | null | undefined
): string | null {
  const trimmed = override?.trim();

  if (trimmed) {
    try {
      const url = new URL(trimmed);

      if (url.protocol === "http:" || url.protocol === "https:") {
        return originOf(url.protocol, url.hostname.toLowerCase(), url.port);
      }
    } catch {
      // An unusable override falls through to the derivation rather than failing
      // the run: the column is CHECK-constrained on write, so reaching here means
      // data older or stranger than the constraint, and the derived host is still
      // a better answer than none.
    }
  }

  return deriveStagingBaseUrl(baseUrl);
}

// TRANSPORT. Move a URL onto the staging origin, preserving path, query and hash.
//
// stagingOrigin === null returns the input UNCHANGED, by identity. That is the
// whole of the 1.90 guarantee: in legacy mode every caller passes null, this
// returns its argument, and every downstream value — the request URL, the rate
// bucket, the strategy key — is computed from exactly the same string as before.
export function applyStagingOrigin(
  url: string,
  stagingOrigin: string | null
): string {
  if (!stagingOrigin) {
    return url;
  }

  try {
    const target = new URL(url);
    const staging = new URL(stagingOrigin);

    // Already on the staging host: nothing to do, and re-writing would drop a
    // port the caller deliberately set.
    if (target.host === staging.host && target.protocol === staging.protocol) {
      return url;
    }

    target.protocol = staging.protocol;
    target.hostname = staging.hostname;
    // Assigned EXPLICITLY rather than via `host`. Setting `host` to a value that
    // carries no port leaves the existing port in place, so a production URL on
    // :8080 would keep :8080 on a staging origin that never named one — pointing
    // the probe at a port the staging host may not even be listening on. Caught by
    // a test, not by review.
    target.port = staging.port;

    return target.toString();
  } catch {
    // An unparseable URL is left alone. The probe path will fail on it for its
    // own reasons and report that honestly, which is better than this module
    // inventing a target.
    return url;
  }
}

// IDENTITY. Map a URL observed ON the staging host back to the production origin.
//
// This is the inverse of applyStagingOrigin and it is NOT optional. Its caller is
// final_url, which is not display-only: routes/sessions.ts hands it to
// applyRedirectsJob as the redirect DESTINATION WRITTEN INTO THE PRODUCTION
// SITEMAP, and verifyUrlsJob distills it into pattern_shape_rules to drive bulk
// rewrites. A staging origin answering a 301 with
// "Location: https://dev.asapsemi.com/new-path" would otherwise put a dev host
// into production sitemap files.
//
// A destination on some OTHER host (a CDN, a partner domain, an external
// redirect) is left exactly as measured — it is a real third-party destination,
// not an artifact of how we asked.
export function toProdIdentity(
  url: string | null,
  stagingOrigin: string | null,
  prodOrigin: string
): string | null {
  if (!url || !stagingOrigin) {
    return url;
  }

  try {
    const observed = new URL(url);
    const staging = new URL(stagingOrigin);

    if (observed.host !== staging.host) {
      return url;
    }

    const prod = new URL(prodOrigin);

    observed.protocol = prod.protocol;
    observed.host = prod.host;

    return observed.toString();
  } catch {
    return url;
  }
}

// Whether a URL sits on the production origin, and so should be re-staged before
// a redirect is FOLLOWED during a 2.0 run.
//
// Needed because final_url has already been normalized back to the prod identity
// by the time the follow-up request is built. Following it verbatim would send a
// live request to PRODUCTION in the middle of a staging run — measuring the wrong
// server, and touching an origin the operator did not intend to touch at all.
export function isProdOrigin(url: string, prodOrigin: string): boolean {
  try {
    return new URL(url).host === new URL(prodOrigin).host;
  } catch {
    return false;
  }
}

// scheme://host[:port] with no trailing slash, matching the shape base_url is
// stored in (routes/sessions.ts parseBaseUrl strips the trailing slash) and the
// shape sessions_staging_base_url_absolute enforces.
function originOf(protocol: string, hostname: string, port: string): string {
  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
}
