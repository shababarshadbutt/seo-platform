import { lookup as dnsLookup } from "node:dns";

import { Agent, buildConnector, setGlobalDispatcher } from "undici";

import { privateIpForHostname } from "./privateRoute.js";

// Corporate HTTPS-inspection proxies (common on SEO team machines) intercept
// outbound TLS and re-sign certificates with a corporate CA that Node.js does
// not trust. Left unhandled, EVERY outbound request — URL liveness sampling and
// remote sitemap fetches — fails with "self-signed certificate in certificate
// chain", so the whole health check reports "No response" and a 0% score.
//
// Setting NODE_TLS_REJECT_UNAUTHORIZED=0 tells the tool to accept those
// re-signed certificates. This is a deliberate, safe trade-off for THIS tool:
//   • it only affects outbound liveness/fetch requests (no inbound trust),
//   • it runs on a private corporate network, and
//   • the alternative is every URL reporting "No response", which is worse.
// It is opt-in per deployment via the env var and defaults to secure
// (verification ON) when the var is unset. (v1.39 Fix 1)
export const rejectUnauthorized =
  process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";

// TWO dispatchers, ONE OF EACH, created at module load and reused forever.
//
// WHY CACHED, not per-request. An undici Agent owns the connection pool: keep
// alive, TLS session reuse, h2 session reuse. Constructing one per request throws
// all of that away and forces a fresh TCP + TLS handshake every time, which on a
// 1.3M-URL sweep is strictly slower than the single-Agent code it replaced. So
// the transport variants are enumerated here, once, and callers SELECT one.
//
// WHY TWO. allowH2 is a property of the Agent's TLS connector, not of a request:
// it decides what goes in the ALPN extension of the handshake
// (['http/1.1'] vs ['http/1.1','h2']). It therefore cannot be chosen per request
// on a shared Agent — a second variant is the only way to offer both.
//
// WHY IT MATTERS. undici defaults allowH2 to false, so every request this tool
// has ever made advertised HTTP/1.1 only, and over HTTP/1.1 undici writes header
// names in lowercase. A real Chrome advertises h2 and capitalises on 1.1, so the
// browser-profile requests were claiming to be a browser from a client that
// visibly could not be one. The h2 variant exists to close that gap for hosts
// that need it — selected per host by the strategy engine, never guessed.
// WHAT THE EDGE ACTUALLY CHOSE, not what we offered.
//
// allowH2 says what went into the ALPN extension; it cannot say what came back. Those
// differ in exactly the case worth knowing about: we advertise ['http/1.1','h2'] and the
// edge picks http/1.1 anyway. Devops' successful hand-test of this site family
// negotiated HTTP/2, ours may not be, and nothing in the codebase could tell you —
// which is the open question in verify-http2-hypothesis.txt. The only place the answer
// exists is the TLS socket, so the connector is wrapped to read it on the way past.
//
// BOUNDED, because this lives in a worker that talks to 650+ hosts and is not restarted
// between runs.
const ALPN_CACHE_MAX_HOSTS = 1024;

// A recorded protocol is only reported for this long.
//
// The value is consumed within milliseconds of the connect that produced it (the probe
// that triggered the handshake logs it immediately), so anything older belongs to a
// DIFFERENT connection — undici pools, so a later request may reuse a socket or open a
// fresh one, and this map only hears about the latter. Reporting a three-hour-old
// observation as "what this probe negotiated" would be a plausible-looking measurement
// that is simply not true, which is the failure mode the whole diagnostics effort exists
// to remove.
const ALPN_MAX_AGE_MS = 60_000;

const observedAlpn = new Map<string, { alpn: string; at: number }>();

function recordAlpn(host: string, alpn: string): void {
  // Oldest-first eviction: Map preserves insertion order, so the first key is the least
  // recently RECORDED. Losing an entry costs one null field in a log line; growing
  // without limit is a leak.
  if (observedAlpn.size >= ALPN_CACHE_MAX_HOSTS && !observedAlpn.has(host)) {
    const oldest = observedAlpn.keys().next();

    if (!oldest.done) {
      observedAlpn.delete(oldest.value);
    }
  }

  observedAlpn.delete(host);
  observedAlpn.set(host, { alpn, at: Date.now() });
}

// Null when: the target was plain http:// (no TLS, so no ALPN — not "h1"), the socket
// was pooled from an earlier connection this map never saw, or the observation is older
// than ALPN_MAX_AGE_MS. All three mean "we do not know", which is the honest answer.
export function observedAlpnFor(host: string): string | null {
  const seen = observedAlpn.get(host);

  if (!seen || Date.now() - seen.at > ALPN_MAX_AGE_MS) {
    return null;
  }

  return seen.alpn;
}

// Test seam only.
export function resetObservedAlpn(): void {
  observedAlpn.clear();
}

// KEYED THE SAME WAY rateLimitHostKey KEYS, i.e. `new URL(url).host.toLowerCase()`:
// hostname, plus `:port` only when the port is not the protocol's default. The connector
// is handed hostname and port separately, so writing `${hostname}:${port}` would file
// every https host under "example.com:443" while every reader looks up "example.com" and
// gets null forever — a silent, total miss that would look exactly like "the edge never
// negotiated h2".
function connectorHostKey(options: {
  hostname?: string;
  port?: string | number;
  protocol?: string;
}): string {
  const hostname = String(options.hostname ?? "").toLowerCase();
  const port = String(options.port ?? "");
  const isDefaultPort =
    port === "" ||
    (options.protocol === "https:" && port === "443") ||
    (options.protocol === "http:" && port === "80");

  return isDefaultPort ? hostname : `${hostname}:${port}`;
}

// ---- The private-VPC DNS override ---------------------------------------
//
// Answers a mapped hostname with its private 10.x address and delegates
// everything else to the real resolver. This is the ENTIRE mechanism by which a
// health check reaches a site privately: the URL, the Host header, the SNI
// servername and every host-derived cache key keep saying the public hostname,
// and only the socket goes somewhere else.
//
// It is installed on its own dispatcher pair, NOT on the two above. The h1 agent
// above is also the global dispatcher, which serves remote sitemap fetches and the
// cleaner — traffic that is deliberately out of scope for private routing. Keeping
// the override off it makes that scope a structural guarantee rather than a
// convention someone has to remember.
// Typed loosely on purpose. Node's LookupFunction is a set of overloads keyed on
// whether options.all is true, and this one function answers BOTH — which no single
// overload signature describes. The two callback shapes are what the tests pin
// down; the cast at the call site is where that widening is admitted.
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void;

// EXPORTED FOR TESTS ONLY. A mistake in here breaks every request that uses the private
// dispatcher — including the delegation path, which would break requests to unmapped
// hosts too — and none of that is reachable through the Agent without a live socket.
export function privateAwareLookup(
  hostname: string,
  options: { all?: boolean },
  callback: LookupCallback
): void {
  const ip = privateIpForHostname(hostname);

  if (!ip) {
    // Not mapped: behave exactly like no override existed.
    (dnsLookup as unknown as (h: string, o: unknown, c: LookupCallback) => void)(
      hostname,
      options,
      callback
    );
    return;
  }

  // BOTH CALLBACK SHAPES MATTER. net.connect calls lookup with options.all either
  // unset (expecting `cb(null, address, family)`) or true (expecting
  // `cb(null, [{address, family}])`). Answering the wrong shape does not fail
  // gracefully — it breaks the connect for every request that uses this
  // dispatcher, so both are handled and both are asserted in the tests.
  if (options.all) {
    callback(null, [{ address: ip, family: 4 }]);
    return;
  }

  callback(null, ip, 4);
}

function buildDispatcher(
  allowH2: boolean,
  connect: ReturnType<typeof buildConnector>
) {
  return new Agent({
    allowH2,
    // The socket is passed straight through untouched — this only reads a property on
    // the way past. Anything else here would be in the path of every outbound request
    // the tool makes.
    connect(options, callback) {
      connect(options, (error, socket) => {
        // The error and success paths are passed on SEPARATELY rather than forwarded as
        // one pair: undici's callback signature is a discriminated tuple
        // ([Error, null] | [null, Socket]), and collapsing them would need a cast that
        // could hide a real connect error from the pool.
        if (error || !socket) {
          callback(error ?? new Error("connect produced no socket"), null);
          return;
        }

        // TLSSocket.alpnProtocol is the negotiated protocol, `false` when the peer did
        // not negotiate one, and absent entirely on a plain TCP socket.
        const negotiated = (socket as { alpnProtocol?: string | false })
          .alpnProtocol;

        if (typeof negotiated === "string" && negotiated !== "") {
          recordAlpn(connectorHostKey(options), negotiated);
        }

        callback(null, socket);
      });
    }
  });
}

const publicConnector = buildConnector({ rejectUnauthorized });
// `lookup` is not in undici's BuildOptions type, but buildConnector spreads its
// remaining options into BOTH net.connect and tls.connect
// (undici/lib/core/connect.js), which is exactly where node reads it — so the cast
// is admitting a gap in the typings, not forcing something through.
//
// Verified in the same function: tls.connect is called with `servername` derived
// from the hostname and `host: hostname`, so overriding the lookup changes the
// socket's destination WITHOUT touching SNI. That is what lets the https fallback
// validate a site's real certificate against its private IP.
const privateConnector = buildConnector({
  rejectUnauthorized,
  lookup: privateAwareLookup
} as Parameters<typeof buildConnector>[0]);

const http1Dispatcher = buildDispatcher(false, publicConnector);
const http2Dispatcher = buildDispatcher(true, publicConnector);

// The private-routed pair. Same TLS posture, same ALPN observation, same pooling —
// the ONLY difference is where the hostname resolves. rejectUnauthorized is
// deliberately left alone: on the https fallback path (an origin that redirects
// :80 to TLS) the SNI servername is still the real hostname, so the site's real
// certificate validates. There is no "skip verification for private hosts" escape
// hatch, because that would accept any host on the VPC as any customer site.
const privateHttp1Dispatcher = buildDispatcher(false, privateConnector);
const privateHttp2Dispatcher = buildDispatcher(true, privateConnector);

// The default for every caller that does not care (sitemap fetches, the cleaner)
// and the global dispatcher: HTTP/1.1 only, i.e. exactly the behaviour that
// shipped before the h2 variant existed. Nothing changes for anyone who does not
// explicitly ask for h2.
export const tlsAwareDispatcher = http1Dispatcher;

// Pick the cached dispatcher for a transport. Returns the SAME instance every
// time for a given argument — asserted in tlsDispatcher.test.ts, because an
// accidental per-call `new Agent()` would look correct and quietly halve
// throughput.
export function dispatcherFor(allowH2: boolean | undefined) {
  return allowH2 ? http2Dispatcher : http1Dispatcher;
}

// Same contract as dispatcherFor, for requests that should resolve mapped
// hostnames to their private VPC address. Callers select this ONLY for URL health
// checks whose target is privately routed; everything else keeps using
// dispatcherFor, which has no DNS override at all.
export function privateDispatcherFor(allowH2: boolean | undefined) {
  return allowH2 ? privateHttp2Dispatcher : privateHttp1Dispatcher;
}

setGlobalDispatcher(http1Dispatcher);
