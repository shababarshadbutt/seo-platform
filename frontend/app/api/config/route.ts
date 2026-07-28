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
    // Deployed version for the navbar pill. APP_VERSION (runtime env) is
    // preferred over the NEXT_PUBLIC_ build arg: the build arg is frozen into
    // the image, so re-running an image after editing APP_VERSION in .env would
    // show a stale version — the exact drift the pill exists to expose. The
    // build-time value stays as a fallback for images run without the runtime
    // var, so a version still shows rather than nothing.
    appVersion:
      process.env.APP_VERSION ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "",
    // Master flag for the two AWS paths never exercised against real
    // infrastructure (SFTP pull, S3 publish). Read here rather than as a
    // NEXT_PUBLIC_* inline so DevOps can flip it in .env without rebuilding the
    // image — the same reason seoDeskUrl moved here. Anything other than the
    // exact string "true" leaves the features hidden.
    awsPublishEnabled: (process.env.AWS_PUBLISH_ENABLED ?? "false") === "true"
  });
}
