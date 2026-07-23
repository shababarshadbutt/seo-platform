import { Agent, setGlobalDispatcher } from "undici";

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

// A single dispatcher every undici `request()` call can share. Also installed
// as the global dispatcher so call sites that don't pass it explicitly (e.g.
// the sitemap-fetch path in parser.ts, the cleaner) inherit the same TLS
// policy without having to thread it through.
export const tlsAwareDispatcher = new Agent({
  connect: { rejectUnauthorized }
});

setGlobalDispatcher(tlsAwareDispatcher);
