/** @type {import('next').NextConfig} */

// The browser -> backend reverse proxy deliberately does NOT live here.
//
// It used to: a rewrite from /api/backend/:path* to `${process.env.BACKEND_URL}`.
// That is a trap. `next build` calls rewrites() and writes the RESOLVED
// destination into .next/routes-manifest.json; `next start` serves from that
// manifest and never calls rewrites() again. So the destination is fixed at
// BUILD time, not read at server start — and since the image is built without
// BACKEND_URL (on purpose: one artifact, any environment), the build baked in a
// "http://localhost:3001" fallback. Two containers on a Docker network then got
// ECONNREFUSED 127.0.0.1:3001 on every call, with the correct
// BACKEND_URL=http://backend:3001 sitting unused in the container's env.
//
// It is now app/api/backend/[...path]/route.ts, which runs per request and reads
// process.env.BACKEND_URL from the live environment. Do not "simplify" it back
// into a rewrite: any env-dependent rewrite destination has this same bug, and
// on a single machine the localhost fallback masks it.
const nextConfig = {};

export default nextConfig;
