// The global 1.90 / 2.0 toggle: which environment URL health checks are sent to.
//
// WHY THIS IS NOT AN ENV VAR. Every other flag in this codebase
// (AWS_PUBLISH_ENABLED, PRIVATE_ROUTE_ENABLED) is read by readBooleanFlag from
// process.env, which is correct for them: they gate unverified infrastructure
// paths and are flipped by DevOps at deploy time. This one is flipped by a USER
// from a button in the navbar, at runtime, and must be seen by the API process
// AND the worker process, which are separate containers. An env var would need a
// redeploy; a module-level variable would only ever change in whichever container
// served the click. So it lives in the database.
//
// WHY THE PROBE PATH NEVER READS IT. A verification sweep is up to ~1.3M URLs; a
// per-probe read would be a DB round trip per URL. Instead each job reads the mode
// ONCE at start (readCheckModeUncached) and pins it into a ProbeEnvironment that
// is threaded through the run. Consequences, both deliberate:
//
//   * A RUNNING job keeps its mode to completion. Flipping the toggle mid-sweep
//     does not produce a half-production, half-staging result set.
//   * A QUEUED job picks up whatever the mode is when it STARTS, not when it was
//     enqueued.
//
// Either way every row records which environment measured it
// (sampled_urls.checked_on_staging), so the data is self-describing even when a
// flip lands between two patterns of the same session.
//
// WHY NO REDIS PUB/SUB. It would buy sub-second propagation to a process that
// pins its mode at job start anyway. The 5s cache TTL below is already far tighter
// than the thing it feeds. Do not add one.
import { pool } from "../db/pool.js";

export type CheckMode = "1.90" | "2.0";

export const CHECK_MODE_KEY = "url_check_mode";

// The default, the fallback, and the value every pre-existing row was measured
// under. Named rather than repeated so "what does this degrade to?" has one answer.
export const LEGACY_MODE: CheckMode = "1.90";
export const STAGING_MODE: CheckMode = "2.0";

// How long a read is trusted. Only the settings endpoint and the once-per-job
// pin read through this, so the TTL trades nothing for a bounded staleness that
// is invisible next to a job's runtime.
const CACHE_TTL_MS = 5_000;

let cached: { mode: CheckMode; readAt: number } | null = null;
// Single-flight: a burst of navbar polls across tabs collapses into one query,
// the same shape getRuntimeConfig uses on the frontend.
let inFlight: Promise<CheckMode> | null = null;

// ONLY the exact string "2.0" selects staging.
//
// "2", "2.0.0", " 2.0", "TRUE", "true", "" and null all mean 1.90. Same rule and
// same reasoning as readBooleanFlag in config.ts: a flag that changes which server
// the tool measures — and therefore what it reports about a live site — must not
// be switched on by a near-miss. Exported so the rule is testable rather than an
// inline comparison repeated per call site.
export function parseCheckMode(raw: string | null | undefined): CheckMode {
  return raw === STAGING_MODE ? STAGING_MODE : LEGACY_MODE;
}

// The mode, straight from the database, no cache. Used for the once-per-job pin,
// where a 5s-stale answer would be silently wrong for the whole run.
export async function readCheckModeUncached(): Promise<CheckMode> {
  try {
    const result = await pool.query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = $1",
      [CHECK_MODE_KEY]
    );

    return parseCheckMode(result.rows[0]?.value);
  } catch {
    // DEGRADES TO LEGACY. An unreachable settings row must never be read as "2.0"
    // — that would point checks at a host the operator did not choose. The caller
    // gets the same answer a fresh install gives.
    return LEGACY_MODE;
  }
}

// The mode for display and for the settings endpoint, cached for CACHE_TTL_MS.
export async function readCheckMode(): Promise<CheckMode> {
  const now = Date.now();

  if (cached && now - cached.readAt < CACHE_TTL_MS) {
    return cached.mode;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = readCheckModeUncached()
    .then((mode) => {
      cached = { mode, readAt: Date.now() };

      return mode;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export async function writeCheckMode(
  mode: CheckMode,
  actor: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by`,
    [CHECK_MODE_KEY, mode, actor]
  );

  // In-process only. The OTHER container picks the change up within CACHE_TTL_MS,
  // which is what the TTL is for.
  resetCheckModeCache();
}

export type CheckModeState = {
  mode: CheckMode;
  updated_at: string | null;
  updated_by: string | null;
};

export async function readCheckModeState(): Promise<CheckModeState> {
  try {
    const result = await pool.query<{
      value: string;
      updated_at: string;
      updated_by: string | null;
    }>(
      "SELECT value, updated_at, updated_by FROM app_settings WHERE key = $1",
      [CHECK_MODE_KEY]
    );
    const row = result.rows[0];

    return {
      mode: parseCheckMode(row?.value),
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null
    };
  } catch {
    return { mode: LEGACY_MODE, updated_at: null, updated_by: null };
  }
}

// Exported for the write path and for tests, which must not inherit a mode set by
// a previous test.
export function resetCheckModeCache(): void {
  cached = null;
  inFlight = null;
}
