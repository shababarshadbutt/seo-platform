// Staging-origin derivation, mirroring backend/src/http/stagingOrigin.ts.
//
// The backend is the source of truth: it is what the probe path actually uses, and
// GET /api/sessions/:id returns effective_staging_base_url already resolved, so an
// EXISTING session's target never depends on this file. This copy exists for one
// job only — showing the user, in the New Analysis form, what will be derived
// BEFORE the session exists to ask about. It must stay behaviourally identical;
// see lib/staging-origin.test.ts, which pins the same cases as the backend test.
//
// Same arrangement, and the same reason, as lib/host.ts mirroring
// backend/src/sitemaps/domain.ts.
import { normalizeHost } from "./host";

export type UrlCheckMode = "1.90" | "2.0";

export const LEGACY_MODE: UrlCheckMode = "1.90";
export const STAGING_MODE: UrlCheckMode = "2.0";

// Only the exact string "2.0" is staging. Mirrors parseCheckMode in
// backend/src/settings/checkMode.ts, so a malformed value renders as the safe mode
// rather than as an amber "you are pointed at staging" banner that is not true.
export function parseUrlCheckMode(raw: string | null | undefined): UrlCheckMode {
  return raw === STAGING_MODE ? STAGING_MODE : LEGACY_MODE;
}

// https://www.asapsemi.com -> https://dev.asapsemi.com
//
// Strips "www.", prefixes "dev.", preserves scheme and port, drops any path, and is
// idempotent on a host that already starts with "dev.". null when the input is not
// a usable http(s) URL — which is the normal state while someone is still typing.
export function deriveStagingBaseUrl(baseUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(baseUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  const host = url.hostname.toLowerCase();

  if (!host) {
    return null;
  }

  const stagingHost = host.startsWith("dev.") ? host : `dev.${normalizeHost(host)}`;

  return `${url.protocol}//${stagingHost}${url.port ? `:${url.port}` : ""}`;
}
