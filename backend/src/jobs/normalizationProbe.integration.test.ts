import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";

const { pool } = await import("../db/pool.js");
const { processNormalizationProbeJob } = await import(
  "./normalizationProbeJob.js"
);
const { resetCheckModeCache } = await import("../settings/checkMode.js");

// The probe ladder against REAL sockets.
//
// Two servers stand in for production and staging, because the claim under test is
// which spelling of a URL actually answers — and a stub cannot fail the way this
// must be able to fail. The production server records every request it receives,
// so "did a 2.0 run touch production?" is an assertion rather than a reading of
// the code.
//
// No BullMQ: the job function is called directly, so this file never opens a queue
// connection and cannot pass and then hang the process.

const silentLogger: any = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return silentLogger;
  }
};

type Recorder = { origin: string; requests: string[]; close: () => void };

async function startServer(
  handler: (url: string, res: import("node:http").ServerResponse) => void
): Promise<Recorder> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req.url ?? "/", res);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => server.close()
  };
}

async function reachable() {
  try {
    await pool.query("SELECT 1");

    return true;
  } catch {
    return false;
  }
}

async function seed(baseUrl: string, stagingBaseUrl: string | null, locs: string[]) {
  const session = await pool.query<{ id: string }>(
    `INSERT INTO sessions (name, base_url, sample_size, concurrency, user_agent, staging_base_url)
     VALUES ('normalization-probe-itest', $1, 10, 5, 'itest-agent', $2)
     RETURNING id`,
    [baseUrl, stagingBaseUrl]
  );
  const sessionId = session.rows[0].id;
  const pattern = await pool.query<{ id: string }>(
    `INSERT INTO patterns (session_id, template, total_urls, coverage_pct, confidence_pct)
     VALUES ($1, '/page-{param}/', $2, 100, 0)
     RETURNING id`,
    [sessionId, locs.length]
  );
  const patternId = pattern.rows[0].id;

  for (const loc of locs) {
    await pool.query(
      `INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, patternId, loc, new URL(loc).pathname]
    );
  }

  const run = await pool.query<{ id: string }>(
    `INSERT INTO normalization_probe_runs (session_id, pattern_id)
     VALUES ($1, $2) RETURNING id`,
    [sessionId, patternId]
  );

  return { sessionId, patternId, runId: run.rows[0].id };
}

async function readRun(runId: string) {
  const result = await pool.query(
    `SELECT status, candidates_total, sampled_total, probes_total,
            checked_on_staging, result, error
     FROM normalization_probe_runs WHERE id = $1`,
    [runId]
  );

  return result.rows[0];
}

async function setMode(mode: "1.90" | "2.0") {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('url_check_mode', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [mode]
  );
  resetCheckModeCache();
}

test("the probe ladder resolves, flags ambiguity, and never touches production in 2.0", async (t) => {
  if (!(await reachable())) {
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  // A body over SOFT_404_SHORT_BODY_BYTES (1000). An empty 200 is classified as a
  // soft 404 by design, so a realistic page body is what makes these fixtures
  // behave like a real site rather than passing for the wrong reason.
  const PAGE = `<html><body>${"content ".repeat(200)}</body></html>`;
  // Long enough not to trip the short-body rule, so the SIGNAL is what marks it.
  const SOFT_404_PAGE = `<html><body>Page not found. ${"sorry ".repeat(200)}</body></html>`;

  // Production answers everything, so if a 2.0 run leaked to it every variant
  // would look alive — which is exactly the failure this must be able to catch.
  const prod = await startServer((_url, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });

  // Staging serves ONLY the normalized spellings, which is the real migration
  // situation.
  const staging = await startServer((url, res) => {
    const live = new Set([
      "/page-1-3/", // the one reading of page-1-003
      "/page-3-0/", // BOTH readings of page-3-00 are live here...
      "/page-3/" // ...which is the human-decision case
    ]);

    if (live.has(url)) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);

      return;
    }

    // A 200 that is really a not-found page. Without the soft-404 sniff this
    // would score as live and could get a whole pattern rewritten onto it.
    if (url === "/page-5-0/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SOFT_404_PAGE);

      return;
    }

    res.writeHead(404, { "content-type": "text/html" });
    res.end(SOFT_404_PAGE);
  });

  let sessionId = "";

  try {
    await setMode("2.0");

    const seeded = await seed(prod.origin, staging.origin, [
      `${prod.origin}/page-1-003/`, // broken, one reading works  -> resolved
      `${prod.origin}/page-3-00/`, // broken, BOTH readings work -> ambiguous
      `${prod.origin}/page-2-004/`, // broken, nothing works      -> unresolved
      `${prod.origin}/page-5-00/`, // a variant 200s but is a SOFT 404 -> unresolved
      `${prod.origin}/page-4-17/` // no padding at all -> never probed
    ]);

    sessionId = seeded.sessionId;

    await processNormalizationProbeJob(
      {
        session_id: seeded.sessionId,
        pattern_id: seeded.patternId,
        run_id: seeded.runId
      },
      silentLogger
    );

    const run = await readRun(seeded.runId);
    const seen = JSON.stringify(run.result);

    assert.equal(run.status, "COMPLETE", run.error ?? "");
    assert.equal(run.checked_on_staging, true);

    // The unpadded URL is not a candidate and costs no request.
    assert.equal(Number(run.candidates_total), 4, seen);
    assert.equal(Number(run.sampled_total), 4, seen);

    assert.equal(run.result.totals.resolved, 1, seen);
    assert.equal(run.result.totals.ambiguous, 1, seen);
    assert.equal(run.result.totals.unresolved, 2, seen);

    // THE SOFT-404 GUARD, asserted directly: the variant answered 200 and is still
    // not treated as a live destination.
    const softCase = run.result.urls.find((u: any) =>
      u.source.includes("page-5-00")
    );

    assert.ok(softCase, seen);
    const softVariant = softCase.variants.find((v: any) =>
      v.url.includes("/page-5-0/")
    );

    assert.equal(softVariant.status, 200, seen);
    assert.equal(softVariant.healthy, false, seen);

    // PRODUCTION WAS NEVER CONTACTED, even though it would have answered 200 with
    // a real body to everything.
    assert.deepEqual(prod.requests, [], prod.requests.join(", "));
    assert.ok(staging.requests.length > 0);
    // ...and nothing asked about the unpadded URL.
    assert.ok(
      !staging.requests.some((r) => r.includes("page-4-17")),
      staging.requests.join(", ")
    );

    // The single resolved pair supports the narrow reading. The ambiguous URL
    // contributed nothing, so the wider dropping reading is NOT recommended off
    // the back of it.
    assert.deepEqual(
      run.result.recommended,
      { kind: "normalizeDigits", dropZeroTokens: false },
      seen
    );
  } finally {
    await setMode("1.90");

    if (sessionId) {
      await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    }

    prod.close();
    staging.close();
    await pool.end();
  }
});
