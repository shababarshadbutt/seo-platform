import type { NextRequest } from "next/server";

import { readBackendUrl } from "@/lib/runtime-config";

// Server-side reverse proxy for every browser -> backend call.
//
// WHY THIS IS A ROUTE HANDLER AND NOT A next.config REWRITE
//
// It used to be a rewrite whose destination was `process.env.BACKEND_URL`. That
// looks like it reads the environment at server start, and the old comment
// claimed exactly that, but it does NOT: `next build` EVALUATES rewrites() and
// serialises the resolved string into .next/routes-manifest.json, and
// `next start` serves from that manifest without ever calling rewrites() again.
// The image is built with no BACKEND_URL set (deliberately — one artifact must
// deploy anywhere), so the build froze the old "http://localhost:3001" fallback
// into the manifest and the container's real BACKEND_URL=http://backend:3001 was
// never consulted. On one machine that fallback happens to work, which is why it
// survived local testing; in separate containers it is ECONNREFUSED on every
// call.
//
// A route handler runs per request, so process.env.BACKEND_URL is read from the
// live environment on every call. There is deliberately NO localhost fallback
// anywhere in this file: a fallback that silently works on a single host is what
// hid the original bug, so a missing BACKEND_URL is a loud 500 instead.
//
// What this has to carry, all of which the rewrite handled for free:
//   - streamed request bodies  (multi-thousand-file uploads must not buffer)
//   - streamed response bodies (ZIP downloads, and SSE progress streams)
//   - SSE held open for up to 30 minutes
//   - client disconnects propagating upstream so the backend can tear down
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A proxied response is never a cache candidate.
export const fetchCache = "force-no-store";

function backendBase(): string {
  const backend = readBackendUrl();

  if (!backend.ok) {
    // Loud, not localhost. See the note above. Same sentence /api/health reports
    // as its failure reason, so one message identifies this misconfiguration
    // whether it is met through a proxied call or through the healthcheck.
    throw new Error(backend.message);
  }

  return backend.url;
}

// Headers that describe THIS connection rather than the message, so forwarding
// them to (or from) the upstream is wrong.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function requestHeaders(request: NextRequest): Headers {
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    const name = key.toLowerCase();

    if (HOP_BY_HOP.has(name)) {
      return;
    }

    // Rewritten by fetch for the upstream origin; forwarding ours would point
    // the backend at the frontend's hostname.
    if (name === "host") {
      return;
    }

    // The body is re-streamed, so any length we were given no longer describes
    // what we send — undici sets the framing itself.
    if (name === "content-length") {
      return;
    }

    headers.set(key, value);
  });

  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();

  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();

    if (HOP_BY_HOP.has(name)) {
      return;
    }

    // fetch has already decoded the body, so a surviving content-encoding would
    // tell the browser to decode it a second time. content-length is dropped
    // with it because the decoded length differs from the encoded one; when the
    // upstream did NOT encode (the normal case here — the backend registers no
    // compression) content-length is preserved below, which matters for the
    // download progress UI.
    if (name === "content-encoding" || name === "content-length") {
      return;
    }

    headers.set(key, value);
  });

  if (!upstream.headers.has("content-encoding")) {
    const length = upstream.headers.get("content-length");

    if (length) {
      headers.set("content-length", length);
    }
  }

  return headers;
}

async function proxy(
  request: NextRequest,
  context: { params: { path?: string[] } }
): Promise<Response> {
  const suffix = (context.params.path ?? []).map(encodeURIComponent).join("/");
  // nextUrl.search keeps the query string verbatim, including repeated keys
  // (?exclude=1&exclude=2) that a parsed-and-rebuilt version would collapse.
  const target = `${backendBase()}/${suffix}${request.nextUrl.search}`;

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  const upstream = await fetch(target, {
    method: request.method,
    headers: requestHeaders(request),
    // Streamed, not buffered: a 2,000-file upload must not be read into memory
    // here. duplex "half" is required by undici whenever body is a stream.
    body: hasBody ? request.body : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
    // Propagate the browser going away, so a closed SSE stream or an abandoned
    // download stops work upstream instead of orphaning it.
    signal: request.signal,
    // We forward the backend's own 3xx to the browser rather than resolving it
    // here — the redirect target is the backend's to decide.
    redirect: "manual",
    cache: "no-store"
  } as RequestInit & { duplex?: "half" });

  // upstream.body is passed through unread, so SSE frames and ZIP bytes reach
  // the browser as they arrive rather than being collected first.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream)
  });
}

async function handle(
  request: NextRequest,
  context: { params: { path?: string[] } }
): Promise<Response> {
  try {
    return await proxy(request, context);
  } catch (error) {
    // A client that navigated away aborts the fetch; that is not an error worth
    // logging or reporting.
    if (error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }

    const message =
      error instanceof Error ? error.message : "backend request failed";

    console.error(`[api/backend] ${request.method} ${request.nextUrl.pathname}: ${message}`);

    // 502: this hop failed, which is materially different from the backend
    // itself returning an error, and the message names the misconfiguration.
    return new Response(JSON.stringify({ error: "Bad Gateway", message }), {
      status: 502,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
