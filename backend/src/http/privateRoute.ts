// SHOULD this request go over the private VPC path, and as what?
//
// privateHostMap.ts answers "is this host mapped". This file answers the policy
// question on top of it: the feature flag, the scheme, the circuit breaker, and
// the one transport artifact that can turn a healthy page into a false finding.
//
// THE URL KEEPS ITS PUBLIC HOSTNAME. This is the load-bearing decision of the
// whole feature and it is worth stating where someone will read it. The private
// address is applied by overriding DNS RESOLUTION (see privateAwareLookup in
// tlsDispatcher.ts), not by rewriting the URL to http://10.0.61.203/path. The
// alternative would have broken, all at once:
//
//   * rateLimitHostKey and the host-strategy cache key, which are both
//     `new URL(url).host` — every learned strategy would re-file itself under an
//     IP shared by ~93 sites;
//   * `new URL(location, sourceUrl)` for redirects, which would resolve against
//     the IP;
//   * every stored URL in sampled_urls / verified_urls, and therefore every
//     finding shown to a user;
//   * vhost selection — ~93 hostnames share each IP, so the origin picks the site
//     from the Host header, and a URL-rewrite would have to reconstruct that
//     header by hand at every call site;
//   * the h2 dispatcher outright, since undici derives :authority from the URL
//     origin and not from a `host` header.
//
// Overriding the lookup keeps all six correct with no code at all. The only thing
// this module rewrites is the SCHEME.
import { config } from "../config.js";
import { privateIpForHost } from "./privateHostMap.js";
import { isPrivateRouteDisabled } from "./privateRouteHealth.js";

export type PrivateRoute = {
  ip: string;
  scheme: "http" | "https";
  matchedVia: "exact" | "www-fallback";
};

function mapOptions() {
  return {
    file: config.privateRoute.mapFile,
    reloadSeconds: config.privateRoute.mapReloadSeconds
  };
}

// Per-host scheme, seeded from config and flipped ONE WAY to https when an origin
// turns out to redirect cleartext to TLS. Process-local for the same reason the
// breaker is: it is a fact about the transport right now, re-learned in one
// request after a restart, and persisting it would freeze a guess.
const schemeByHost = new Map<string, "http" | "https">();

export function privateSchemeFor(hostname: string): "http" | "https" {
  return (
    schemeByHost.get(hostname.toLowerCase()) ?? config.privateRoute.scheme
  );
}

export function notePrivateSchemeFlip(hostname: string): void {
  schemeByHost.set(hostname.toLowerCase(), "https");
}

// The private address for a bare hostname, honouring the flag and the breaker.
//
// This is what the DNS override in tlsDispatcher.ts calls: a connector is handed a
// hostname, never a URL. Null means "resolve it normally", which is why the
// override is safe to leave installed — an unmapped host simply falls through to
// dns.lookup.
export function privateIpForHostname(hostname: string): string | null {
  if (!config.privateRoute.enabled) {
    return null;
  }

  const match = privateIpForHost(hostname, mapOptions());

  if (!match || isPrivateRouteDisabled(match.ip)) {
    return null;
  }

  return match.ip;
}

// Null — meaning "use the public internet exactly as before" — when the flag is
// off, the URL is unparseable, the host is unmapped or conflicted, or the IP has
// been abandoned by the breaker. Every one of those is a normal state, not an
// error: the public path is always available and always correct.
export function privateRouteFor(url: string): PrivateRoute | null {
  if (!config.privateRoute.enabled) {
    return null;
  }

  let hostname: string;

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    hostname = parsed.hostname;
  } catch {
    return null;
  }

  const match = privateIpForHost(hostname, mapOptions());

  if (!match || isPrivateRouteDisabled(match.ip)) {
    return null;
  }

  return {
    ip: match.ip,
    scheme: privateSchemeFor(hostname),
    matchedVia: match.matchedVia
  };
}

export type PrivateRouteStatus = "private" | "private-disabled" | "public";

// How a host is being reached RIGHT NOW, for reports.
//
// Three states rather than two, because "mapped but abandoned" is an operational
// finding that must not be rendered as plain "public". privateIpForHostname
// deliberately collapses it (callers have to fall back to the public path either way),
// so this is the one place that distinguishes them.
export function privateRouteStatusFor(hostname: string): PrivateRouteStatus {
  if (!config.privateRoute.enabled) {
    return "public";
  }

  const match = privateIpForHost(hostname.split(":")[0], mapOptions());

  if (!match) {
    return "public";
  }

  return isPrivateRouteDisabled(match.ip) ? "private-disabled" : "private";
}

export type RoutedUrl = {
  url: string;
  route: PrivateRoute | null;
};

// Rewrite ONLY the scheme. Hostname, port, path, query and fragment are left
// exactly as the caller built them, so the returned URL is still the public
// identity of the page being measured — which is what makes it safe to store and
// to show to a user.
export function applyPrivateRoute(url: string): RoutedUrl {
  const route = privateRouteFor(url);

  if (!route) {
    return { url, route: null };
  }

  try {
    const parsed = new URL(url);
    const target = `${route.scheme}:`;

    if (parsed.protocol === target) {
      return { url, route };
    }

    parsed.protocol = target;

    return { url: parsed.toString(), route };
  } catch {
    return { url, route: null };
  }
}

// A 301/308 to the SAME page over https is not a fact about the page — it is the
// origin telling us it does not serve cleartext. Recorded verbatim it would
// relabel every healthy URL on a whole site family as "redirect", which is the
// single most damaging false finding this feature could produce.
//
// Deliberately narrow: same hostname, same path, same query, and only the scheme
// differs. A 301 that changes the path is a real redirect and must keep being
// reported as one.
export function isForcedTlsRedirect(
  requestUrl: string,
  status: number | null,
  location: string | null | undefined
): boolean {
  if (status !== 301 && status !== 308) {
    return false;
  }

  if (!location) {
    return false;
  }

  try {
    const from = new URL(requestUrl);
    const to = new URL(location, requestUrl);

    return (
      from.protocol === "http:" &&
      to.protocol === "https:" &&
      from.hostname.toLowerCase() === to.hostname.toLowerCase() &&
      from.pathname === to.pathname &&
      from.search === to.search
    );
  } catch {
    return false;
  }
}

// Test seam.
export function resetPrivateSchemes(): void {
  schemeByHost.clear();
}
