import { NextResponse } from "next/server";

// Runtime configuration for the browser bundle.
//
// NEXT_PUBLIC_* is inlined at BUILD time, so under `next build` + `next start`
// any per-deployment URL baked into the image is frozen — exactly the drift
// this project already got burned by with image tags. These values are read
// here, server-side, per request, so the same distributed image can be pointed
// at a different environment by changing .env alone.
//
// The backend URL deliberately is NOT exposed: browser calls go to the relative
// /api/backend/* rewrite on this origin (see next.config.mjs), so the client
// never needs to know where the backend actually lives.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    // Public URL of the separate SEO Desk app, used as a navbar link the
    // BROWSER navigates to — so it must be reachable from the user's machine,
    // not an internal compose service name.
    seoDeskUrl: process.env.SEO_DESK_URL ?? "",
    // Static per image build, so NEXT_PUBLIC_ is genuinely correct here; served
    // alongside the rest so the client has one place to read config from.
    appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? ""
  });
}
