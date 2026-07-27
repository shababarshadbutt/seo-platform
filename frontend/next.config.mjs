/** @type {import('next').NextConfig} */

// Reverse-proxy every backend call through the frontend's OWN origin.
//
// Why: lib/api.ts runs in each user's browser. On the old per-laptop setup an
// absolute http://localhost:3001 worked because the backend really was on that
// laptop. On the shared VM every browser is remote, so "localhost" points at
// the user's own machine and the internal service name (http://backend:3001) is
// unreachable from outside Docker — either way it breaks for every user.
//
// Routing browser calls to a relative /api/backend/* on the frontend origin and
// letting Next proxy them server-side to BACKEND_URL means: exactly ONE public
// port (the frontend's), no CORS to configure, and no public hostname or IP
// baked into the image. BACKEND_URL is read here at server start, not inlined
// into the client bundle, so one image works in any environment.
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3001";

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/backend/:path*",
        destination: `${backendUrl.replace(/\/$/, "")}/:path*`
      }
    ];
  }
};

export default nextConfig;
