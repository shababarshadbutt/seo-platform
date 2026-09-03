import type { FastifyInstance } from "fastify";

import { pool } from "../db/pool.js";
import {
  LEGACY_MODE,
  parseCheckMode,
  readCheckModeState,
  STAGING_MODE,
  writeCheckMode,
  type CheckMode
} from "../settings/checkMode.js";

// The global 1.90 / 2.0 toggle: which environment URL health checks are sent to.
//
// GLOBAL AND RUNTIME-FLIPPABLE, which is why it is a route and a table rather than
// an env var like AWS_PUBLISH_ENABLED. Any user can change it from the navbar, and
// both the API and the worker have to see the change without a redeploy.
//
// It deliberately does NOT gate the flip on running jobs. Every job pins its mode
// at start (see jobs/probeEnvironment.ts), so a flip cannot corrupt a sweep already
// in flight — it simply does not apply to it. Blocking would be a lie about the
// risk; reporting the count lets the UI say the true thing instead ("3 checks are
// in progress; they will finish in 1.90").

type PutBody = {
  mode?: unknown;
};

// Jobs that are probing RIGHT NOW, and so are pinned to the outgoing mode.
//
// Counted across the two tables that track probe work: maintenance_jobs carries
// the full-population verification runs, verify_triage_runs the stratified
// samples. Pattern sampling lives in BullMQ rather than a table, so it is not
// counted here — the number is an honest "at least this many", which is what the
// UI phrasing has to reflect.
async function runningCheckCount(): Promise<number> {
  try {
    const result = await pool.query<{ count: string }>(
      `
        SELECT (
          (SELECT COUNT(*) FROM maintenance_jobs
            WHERE kind = 'verify-urls' AND status = 'RUNNING')
          +
          (SELECT COUNT(*) FROM verify_triage_runs
            WHERE status = 'RUNNING')
        )::text AS count
      `
    );

    return Number(result.rows[0]?.count ?? 0);
  } catch {
    // Diagnostic only. A failure here must not stop someone changing the mode.
    return 0;
  }
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/api/settings/url-check-mode", async () => {
    const state = await readCheckModeState();

    return { ...state, running_checks: await runningCheckCount() };
  });

  app.put("/api/settings/url-check-mode", async (request, reply) => {
    const body = (request.body ?? {}) as PutBody;
    const raw = typeof body.mode === "string" ? body.mode : "";

    // STRICT, not parseCheckMode's forgiving read. parseCheckMode exists to make
    // sense of whatever is already in the database; this is the WRITE path, where
    // a value that is merely close to "2.0" is a client bug and should be rejected
    // loudly rather than silently stored as 1.90 — which would leave the user
    // staring at a button that refuses to move.
    if (raw !== LEGACY_MODE && raw !== STAGING_MODE) {
      return reply.status(400).send({
        error: `mode must be exactly "${LEGACY_MODE}" or "${STAGING_MODE}"`
      });
    }

    const mode: CheckMode = parseCheckMode(raw);
    // No auth in this deployment, so "who" is best-effort. Its only job is making a
    // screenshot of an unexpected mode attributable to someone; a header the client
    // sets is enough for that and is not trusted for anything else.
    const actor =
      (typeof request.headers["x-actor"] === "string"
        ? request.headers["x-actor"]
        : null) ?? request.ip ?? null;

    await writeCheckMode(mode, actor);

    const state = await readCheckModeState();

    return { ...state, running_checks: await runningCheckCount() };
  });
}
