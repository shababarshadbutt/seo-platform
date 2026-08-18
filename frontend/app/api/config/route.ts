import { NextResponse } from "next/server";

import { readRuntimeConfig } from "@/lib/runtime-config";

// Runtime configuration for the browser bundle.
//
// NEXT_PUBLIC_* is inlined at BUILD time, so under `next build` + `next start`
// any per-deployment URL baked into the image is frozen — exactly the drift
// this project already got burned by with image tags. These values are read
// here, server-side, per request, so the same distributed image can be pointed
// at a different environment by changing .env alone.
//
// The backend URL deliberately is NOT exposed: browser calls go to the relative
// /api/backend/* proxy on this origin (see app/api/backend/[...path]/route.ts),
// so the client never needs to know where the backend actually lives.
//
// The parsing itself lives in lib/runtime-config.ts, where it is unit-tested and
// shared with the proxy and /api/health — a frontend whose env is half-supplied
// must not be able to disagree with itself about what it has.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(readRuntimeConfig());
}
