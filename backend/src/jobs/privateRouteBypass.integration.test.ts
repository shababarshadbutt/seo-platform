import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import pg from "pg";

// DOES A STALE PUBLIC-PATH VERDICT STOP A PRIVATELY-ROUTED HOST FROM BEING MEASURED?
//
// It must not, and this is the case that proves it against a real database.
//
// THE SCENARIO IS NOT HYPOTHETICAL. host_probe_profiles already holds
// verdict = REFUSED for stackedindustrials.com, learned over the public path where an
// awselb/2.0 load balancer refuses this box's egress IP. That row is TRUE and it stays —
// it is the evidence for the allowlist request to devops. But once the host is reached at
// its private VPC address, the WAF is not in the path at all, and obeying that verdict
// would skip a site that now answers perfectly well. The engine must therefore never
// consult the store for a privately-routed host.
//
// The fixture hostname resolves NOWHERE in real DNS, so if a request arrives it arrived
// because of the private-host map and by no other route.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
// This file measures WHICH requests go out, not how they are spaced
// (verifyRateLimit.integration.test.ts owns that), so the shipped 5/s would add minutes
// of sleeping for nothing. Both budgets are raised because a privately-routed host is
// charged to the PRIVATE one.
process.env.VERIFY_MAX_REQUESTS_PER_SECOND = "100";
process.env.VERIFY_RATE_LIMIT_BURST = "50";
process.env.PRIVATE_MAX_REQUESTS_PER_SECOND = "100";
process.env.PRIVATE_RATE_LIMIT_BURST = "50";

const HOST = "www.privatebypass.local";
const PRIVATE_IP = "127.0.0.1";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "private-bypass-itest-"));
const mapFile = path.join(uploadDir, "private-hosts.conf");

writeFileSync(mapFile, `${PRIVATE_IP} ${HOST}\n`, "utf8");

process.env.UPLOAD_DIR = uploadDir;
process.env.PRIVATE_ROUTE_ENABLED = "true";
process.env.PRIVATE_HOST_MAP_FILE = mapFile;

const LONG_BODY = "healthy fixture product page content. ".repeat(60);

async function postgresReachable() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000
  });

  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

function redisReachable(): Promise<boolean> {
  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");

  return new Promise((resolve) => {
    const socket = net.connect({
      host: url.hostname,
      port: url.port ? Number.parseInt(url.port, 10) : 6379,
      timeout: 3000
    });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

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

type Hit = { method: string; url: string; host: string | undefined; browser: boolean };

async function startFixture() {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      host: req.headers.host,
      browser: req.headers["sec-fetch-mode"] === "navigate"
    });

    res.writeHead(200, { "content-type": "text/html", server: "nginx/1.28.3" });
    res.end(req.method === "HEAD" ? undefined : LONG_BODY);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, PRIVATE_IP, () => resolve())
  );

  const port = (server.address() as { port: number }).port;

  return { hits, server, port, baseUrl: `https://${HOST}:${port}` };
}

test("a REFUSED verdict from the public path does not skip a privately-routed host", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const fixture = await startFixture();
  const host = `${HOST}:${fixture.port}`;

  const { pool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { processSamplePatternsJob } = await import("./samplePatternsJob.js");
  const { resetHostRateLimiter } = await import("../http/hostRateLimiter.js");
  const { resetHostStrategyMemory } = await import("../http/hostStrategy.js");
  const { resetPrivateHostMap } = await import("../http/privateHostMap.js");
  const { resetPrivateRouteHealth } = await import(
    "../http/privateRouteHealth.js"
  );
  // samplePatternsJob reaches sessionCompletion -> preGenerateZipQueue, so importing it
  // opens BullMQ/Redis connections at MODULE load. They keep the event loop alive
  // forever if left open, and `node --test` runs with --test-timeout=0 — so the file
  // passes every assertion and then hangs instead of exiting. Closing them is not
  // tidiness, it is what makes this file terminate.
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeRedisLockClient } = await import("../queue/redisLock.js");
  const { closePool } = await import("../db/pool.js");

  let sessionId: string | null = null;

  t.after(async () => {
    fixture.server.close();

    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await pool
      .query("DELETE FROM host_probe_profiles WHERE host = $1", [host])
      .catch(() => {});
    await closePreGenerateZipQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);
  resetHostRateLimiter();
  resetHostStrategyMemory();
  resetPrivateHostMap();
  resetPrivateRouteHealth();

  // THE STALE VERDICT. Exactly the stackedindustrials.com row: refused by a load
  // balancer, decided a week ago.
  await pool.query(
    `
      INSERT INTO host_probe_profiles (host, verdict, winning_rung, edge_server, last_status, decided_at)
      VALUES ($1, 'REFUSED', NULL, 'awselb/2.0', 405, now() - interval '2 days')
      ON CONFLICT (host) DO UPDATE SET
        verdict = 'REFUSED', winning_rung = NULL, edge_server = 'awselb/2.0',
        last_status = 405, decided_at = now() - interval '2 days'
    `,
    [host]
  );

  const before = await pool.query<{ decided_at: string }>(
    "SELECT decided_at::text AS decided_at FROM host_probe_profiles WHERE host = $1",
    [host]
  );

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency, status)
      VALUES ('private route bypass', $1, 5, 4, 'PROCESSING')
      RETURNING id
    `,
    [fixture.baseUrl]
  );

  sessionId = sessionRow.rows[0].id;

  const pattern = await pool.query<{ id: string }>(
    "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, '/part/{param}', 5) RETURNING id",
    [sessionId]
  );
  const patternId = pattern.rows[0].id;

  for (let index = 0; index < 5; index += 1) {
    const urlPath = `/part/item-${index}`;

    await pool.query(
      "INSERT INTO pattern_urls (session_id, pattern_id, source_url, path) VALUES ($1, $2, $3, $4)",
      [sessionId, patternId, `https://${HOST}:${fixture.port}${urlPath}`, urlPath]
    );
  }

  await processSamplePatternsJob({ session_id: sessionId }, silentLogger);

  // 1. THE HOST WAS MEASURED. Under the stale verdict the circuit breaker would have
  //    issued zero requests and left the pattern unscored.
  assert.ok(
    fixture.hits.length > 0,
    "the private server received no request — the stale REFUSED verdict was obeyed"
  );

  // 2. EVERY REQUEST CARRIED THE PUBLIC HOSTNAME, which is what selects the site on a
  //    box shared by ~93 vhosts.
  assert.deepEqual([...new Set(fixture.hits.map((hit) => hit.host))], [host]);

  // 3. NO BROWSER-PROFILE REQUESTS. A private origin has no WAF, so the ladder is a
  //    single rung and R1's Sec-Fetch-* retry is never paid for.
  assert.equal(
    fixture.hits.filter((hit) => hit.browser).length,
    0,
    "the browser profile was used against a private origin — the ladder is not single-rung"
  );

  // 4. THE PATTERN IS SCORED, from real measurements.
  const scored = await pool.query<{ status: string | null; confidence_pct: number | null }>(
    "SELECT status, confidence_pct FROM patterns WHERE id = $1",
    [patternId]
  );

  assert.equal(scored.rows[0].status, "GOOD");

  // 5. THE ROWS RECORD THE TRANSPORT (mig 045) and keep the PUBLIC url.
  const samples = await pool.query<{
    n: number;
    private_n: number;
    any_http_scheme: number;
  }>(
    `
      SELECT count(*)::int AS n,
             count(*) FILTER (WHERE via_private_route)::int AS private_n,
             count(*) FILTER (WHERE url LIKE 'http://%')::int AS any_http_scheme
      FROM sampled_urls WHERE pattern_id = $1
    `,
    [patternId]
  );

  assert.equal(samples.rows[0].n, 5);
  assert.equal(samples.rows[0].private_n, 5);
  // The private transport must never leak into the stored identity: these URLs are
  // compared against sitemap <loc> values and shown to users.
  assert.equal(samples.rows[0].any_http_scheme, 0);

  // 6. THE STALE ROW IS UNTOUCHED. It is a true statement about the public path and the
  //    substance of the allowlist request to devops — the bypass ignores it rather than
  //    rewriting or deleting it.
  const after = await pool.query<{ verdict: string; decided_at: string }>(
    "SELECT verdict, decided_at::text AS decided_at FROM host_probe_profiles WHERE host = $1",
    [host]
  );

  assert.equal(after.rowCount, 1);
  assert.equal(after.rows[0].verdict, "REFUSED");
  assert.equal(after.rows[0].decided_at, before.rows[0].decided_at);
});
