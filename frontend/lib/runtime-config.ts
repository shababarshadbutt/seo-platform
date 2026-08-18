// The frontend's RUNTIME environment contract, in one place.
//
// WHY THIS IS A LIB MODULE AND NOT INLINE IN THE ROUTE HANDLERS
//
// Everything here used to live inside app/api/config/route.ts and
// app/api/backend/[...path]/route.ts. Two costs of that: the parsing was
// duplicated, and it was untestable — `npm test` in this package runs
// `lib/**/*.test.ts`, so nothing under app/ is ever exercised.
//
// It became worth fixing after a v1.63-Live deployment served a frontend with
// NONE of these variables set. /api/config answered
// {"seoDeskUrl":"","appVersion":"v1.63-Live","awsPublishEnabled":false} and
// every /api/backend/* call answered 502 "BACKEND_URL is not set", because the
// box had been brought up with the dev docker-compose.yml — which still passes
// only the NEXT_PUBLIC_* variables this code stopped reading — instead of
// docker-compose.aws.yml. The visible symptom was the Cleaner's "From SFTP" tab
// silently disappearing, since it is gated on awsPublishEnabled.
//
// So these are pure env-in / value-out functions: the env is a parameter, not a
// global, which is what makes the contract assertable in a test.
//
// NEXT_PUBLIC_* is NOT usable for any of this. It is inlined at BUILD time, so
// under `next build` + `next start` a per-deployment value baked into the image
// is frozen — the same drift this project already got burned by with image tags,
// and the reason next.config.mjs no longer carries the backend rewrite.

// process.env is assignable to this, and so is a plain object literal in a test.
export type Env = Record<string, string | undefined>;

export type RuntimeConfig = {
  seoDeskUrl: string;
  appVersion: string;
  awsPublishEnabled: boolean;
};

export type BackendUrl =
  | { ok: true; url: string }
  | { ok: false; message: string };

// Kept as a single exported constant because three places need the SAME words:
// the proxy's thrown error, the health endpoint's failure reason, and the test.
// This exact sentence is what made the live 502 diagnosable without shell access
// to the box, so it is load-bearing text — do not reword it casually.
export const BACKEND_URL_MISSING =
  "BACKEND_URL is not set: the frontend cannot reach the backend. Set it to the backend's address (in compose that is http://backend:3001).";

// The values the browser bundle is allowed to know, served by /api/config.
//
// The backend URL is deliberately NOT among them: browser calls go to the
// relative /api/backend/* proxy on this origin, so the client never needs to
// know where the backend actually lives.
export function readRuntimeConfig(env: Env = process.env): RuntimeConfig {
  return {
    // Public URL of the separate SEO Desk app, used as a navbar link the BROWSER
    // navigates to — so it must be reachable from the user's machine, not an
    // internal compose service name.
    seoDeskUrl: env.SEO_DESK_URL ?? "",
    // Deployed version for the navbar pill. APP_VERSION (runtime env) is
    // preferred over the NEXT_PUBLIC_ build arg: the build arg is frozen into
    // the image, so re-running an image after editing APP_VERSION in .env would
    // show a stale version — the exact drift the pill exists to expose. The
    // build-time value stays as a fallback for images run without the runtime
    // var, so a version still shows rather than nothing.
    appVersion: env.APP_VERSION ?? env.NEXT_PUBLIC_APP_VERSION ?? "",
    // Master flag for the two AWS paths never exercised against real
    // infrastructure (SFTP pull, S3 publish). Read at runtime so DevOps can flip
    // it in .env without rebuilding the image.
    //
    // FAILS CLOSED, and only the exact string "true" opens it: "TRUE", "1" and
    // "yes" all leave the features hidden. The backend and the worker apply the
    // same rule to the same variable (backend/src/config.ts), so one .env line
    // feeds all three — and all three must be recreated together, or the UI and
    // the endpoints disagree about whether the feature exists.
    awsPublishEnabled: (env.AWS_PUBLISH_ENABLED ?? "false") === "true"
  };
}

// Where /api/backend/* proxies to.
//
// There is deliberately NO localhost fallback: a fallback that silently works on
// a single host is exactly what hid the original build-time-rewrite bug, so an
// unset BACKEND_URL is loud instead. Returned as a result rather than thrown so
// the health endpoint can REPORT the failure without raising it.
export function readBackendUrl(env: Env = process.env): BackendUrl {
  const raw = env.BACKEND_URL?.trim();

  if (!raw) {
    return { ok: false, message: BACKEND_URL_MISSING };
  }

  return { ok: true, url: raw.replace(/\/+$/, "") };
}
