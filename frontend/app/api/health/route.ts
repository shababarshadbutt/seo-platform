import { NextResponse } from "next/server";

import { readBackendUrl, readRuntimeConfig } from "@/lib/runtime-config";

// Liveness AND configuration check for the frontend container.
//
// It used to report a flat {ok:true}, and that is how a broken v1.63-Live deploy
// passed: the compose healthcheck went green on a frontend that had no
// BACKEND_URL at all, so every user-facing call answered 502 while `docker
// compose ps` said healthy. A healthcheck that cannot fail is not a healthcheck.
//
// Now an unreachable-by-configuration frontend reports 503, which the compose
// healthcheck (`fetch(...).then(r => process.exit(r.ok ? 0 : 1))`) turns into an
// unhealthy container — so `up -d --force-recreate` fails at deploy time instead
// of serving a dead app.
//
// force-dynamic is REQUIRED, not stylistic. Without it Next may evaluate this
// handler during `next build` and serve a static answer, freezing the BUILD
// environment's verdict into the image — the identical trap that made the
// backend rewrite read the wrong URL forever (see next.config.mjs).
export const dynamic = "force-dynamic";

export function GET() {
  const backend = readBackendUrl();
  const config = readRuntimeConfig();

  // BOOLEANS, never the values. This endpoint is reachable from the public
  // internet on the deployed box, and the SEO Desk address and the backend's
  // location are not things it should hand out. "Is it configured" is the whole
  // question a healthcheck needs answered.
  const body = {
    ok: backend.ok,
    service: "frontend",
    name: "Sitemap Migration Health Checker",
    version: config.appVersion,
    config: {
      backendUrl: backend.ok,
      seoDeskUrl: config.seoDeskUrl.length > 0,
      awsPublishEnabled: config.awsPublishEnabled
    },
    ...(backend.ok ? {} : { reason: backend.message })
  };

  return NextResponse.json(body, { status: backend.ok ? 200 : 503 });
}
