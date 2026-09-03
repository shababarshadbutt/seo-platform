// The environment ONE RUN measures against, resolved once at job start and then
// threaded through the whole run.
//
// WHY PINNED AT START rather than read per URL. Two reasons, and both matter:
//
//   * COST. A verification sweep is up to ~1.3M URLs. Reading the toggle per probe
//     would be a database round trip per URL.
//   * CORRECTNESS. A toggle flipped halfway through a sweep would otherwise produce
//     a result set that is part production and part staging, with no way to tell
//     which row is which after the fact. Pinning means a running job finishes in
//     the mode it started in, and a queued job picks up whatever the mode is when
//     it STARTS.
//
// Every row still records its own environment (sampled_urls.checked_on_staging), so
// even a flip landing between two patterns of the same session leaves data that
// describes itself.
import {
  LEGACY_MODE,
  readCheckModeUncached,
  STAGING_MODE,
  type CheckMode
} from "../settings/checkMode.js";
import { resolveStagingOrigin } from "../http/stagingOrigin.js";

export type ProbeEnvironment = {
  mode: CheckMode;
  // TRUE only when the mode is 2.0 AND a staging origin was actually resolved.
  isStaging: boolean;
  // The origin health checks are sent to, or null to send them to the URL's own
  // (production) host. ALWAYS null in 1.90 — that is the legacy guarantee.
  stagingOrigin: string | null;
  // The session's production base URL, kept alongside so the identity side of the
  // split is available wherever the transport side is.
  prodOrigin: string;
};

export type ProbeEnvironmentSession = {
  base_url: string;
  staging_base_url?: string | null;
};

// Thrown when 2.0 is on but no staging origin can be worked out for the session.
//
// DELIBERATELY FATAL, NOT A FALLBACK TO PRODUCTION. The operator has switched the
// tool to 2.0 and believes it is measuring the dev site; quietly measuring
// production instead would hand back a full set of plausible-looking verdicts about
// the wrong server — which is precisely the failure mode the private-route config
// warns about, and worse here because the numbers would look completely normal.
// Failing the job is loud, recoverable, and tells the user exactly what to fix.
export class MissingStagingOriginError extends Error {
  constructor(baseUrl: string) {
    super(
      `2.0 mode is on, but no staging origin could be derived from "${baseUrl}". ` +
        `Set a Staging Base URL on this session, or switch checks back to 1.90.`
    );
    this.name = "MissingStagingOriginError";
  }
}

export const LEGACY_ENVIRONMENT: ProbeEnvironment = {
  mode: LEGACY_MODE,
  isStaging: false,
  stagingOrigin: null,
  prodOrigin: ""
};

export async function resolveProbeEnvironment(
  session: ProbeEnvironmentSession
): Promise<ProbeEnvironment> {
  const mode = await readCheckModeUncached();

  // THE LEGACY SHORT-CIRCUIT. In 1.90 this returns before even looking at
  // staging_base_url, so every consumer downstream receives null and reduces to the
  // identity function. Nothing about a 1.90 run can depend on the new column, the
  // new helper, or anything else this feature added.
  if (mode !== STAGING_MODE) {
    return {
      mode: LEGACY_MODE,
      isStaging: false,
      stagingOrigin: null,
      prodOrigin: session.base_url
    };
  }

  const stagingOrigin = resolveStagingOrigin(
    session.base_url,
    session.staging_base_url ?? null
  );

  if (!stagingOrigin) {
    throw new MissingStagingOriginError(session.base_url);
  }

  return {
    mode: STAGING_MODE,
    isStaging: true,
    stagingOrigin,
    prodOrigin: session.base_url
  };
}

// The value the persisters write to checked_on_staging. A plain boolean, so a
// caller cannot accidentally store the origin string.
export function checkedOnStagingFlag(env: ProbeEnvironment): boolean {
  return env.isStaging;
}

// One line for the job's opening log, so a run's environment is answerable from the
// logs alone rather than by correlating timestamps against who flipped the toggle.
export function probeEnvironmentLogFields(env: ProbeEnvironment) {
  return {
    url_check_mode: env.mode,
    staging_origin: env.stagingOrigin,
    checks_target: env.stagingOrigin ?? env.prodOrigin
  };
}
