import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import pg from "pg";

// A CLEANED SITEMAP MUST OUTLIVE THE TAB THAT MADE IT (v1.86).
//
// THE REPORTED BEHAVIOUR. An operator cleans a site, hands off to Migration, and
// the tab loses its connection — or is simply reloaded. The form comes back empty
// and the only way forward is to clean the whole site again. On an 11.5M-URL site
// that is a long job to repeat for a dropped connection, and the cleaned files were
// never the thing that went missing: they were still on the uploads volume.
//
// WHAT WENT MISSING WAS THE HANDLE. The Cleaner was stateless by design, so a
// finished run existed only as a random token in a process-local Map with a
// setTimeout behind it, plus a query parameter the Migration page deliberately
// strips from the URL as soon as it loads. Nothing persisted it, nothing could list
// it, and an API restart invalidated every outstanding token at once.
//
// This asserts the index that closes that gap, against a real database, because
// each part of it is somewhere a unit test cannot reach: the migration's table, the
// listing route's on-disk verification, and the token lookup's fallback — which is
// tested by clearing the in-process cache, the closest thing to a restart that can
// be staged inside one process.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "cleanerruns-itest-"));
const exportDir = mkdtempSync(path.join(os.tmpdir(), "cleanerruns-itest-exp-"));

process.env.UPLOAD_DIR = uploadDir;
process.env.EXPORT_DIR = exportDir;

async function postgresReachable(): Promise<boolean> {
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

// A run as it exists on disk once a clean has finished: <root>/<runId>/out/ with
// the cleaned XML in it and the ZIP beside it. Written directly rather than by
// running a clean, because what is under test is the INDEX and the lookup, not the
// cleaner — and a real clean would make this a slow test of something else.
function stageRun(root: string, runId: string) {
  const runDir = path.join(root, runId);
  const outDir = path.join(runDir, "out");

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "sitemap-1.xml"),
    '<?xml version="1.0"?><urlset><url><loc>https://example.com/a/</loc></url></urlset>',
    "utf8"
  );
  writeFileSync(
    path.join(outDir, "sitemap-index.xml"),
    '<?xml version="1.0"?><sitemapindex></sitemapindex>',
    "utf8"
  );
  writeFileSync(path.join(outDir, "duplicates-report.csv"), "url\n", "utf8");
  writeFileSync(path.join(runDir, "cleaned-sitemaps-2026-08-27.zip"), "PK", "utf8");

  return { runDir, outDir };
}

test("a finished cleaner run survives the process that made it", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip("postgres not reachable — skipping");
    return;
  }

  const Fastify = (await import("fastify")).default;
  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { cleanerRoutes, getCleanerRun } = await import("./cleaner.js");

  const app = Fastify({ logger: false });

  t.after(async () => {
    await app.close();
    await pool.query("DELETE FROM cleaner_runs");
    await closePool();
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);
  await app.register(cleanerRoutes);
  await app.ready();

  await pool.query("DELETE FROM cleaner_runs");

  const root = path.join(uploadDir, "cleaner");
  const liveId = randomUUID();
  const liveToken = randomUUID();
  const live = stageRun(root, liveId);

  // Indexed exactly as cleanPackageAndFinish does it, including run_id being the
  // DIRECTORY NAME — the property that lets staleArtifactSweep, which walks the
  // filesystem and knows nothing but directory names, delete the row alongside the
  // tree it removes.
  await pool.query(
    `
      INSERT INTO cleaner_runs
        (run_id, download_token, domain, subfolder, zip_filename, out_dir,
         file_count, url_count, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '2 hours')
    `,
    [
      liveId,
      liveToken,
      "https://example.com",
      "sitemaps",
      "cleaned-sitemaps-2026-08-27.zip",
      live.outDir,
      2,
      11507768
    ]
  );

  // ---- it is offered, with the counts the picker shows --------------------
  const listed = await app.inject({ method: "GET", url: "/api/cleaner/runs" });

  assert.equal(listed.statusCode, 200, listed.body);

  const body = listed.json() as {
    runs: Array<{
      download_token: string;
      domain: string;
      file_count: number;
      url_count: number;
    }>;
    retention_ms: number;
  };

  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].download_token, liveToken);
  assert.equal(body.runs[0].domain, "https://example.com");
  assert.equal(body.runs[0].file_count, 2);
  // bigint must arrive as a NUMBER, not the string pg hands back for int8 — the
  // picker formats it, and "11507768" would render with no separators.
  assert.equal(body.runs[0].url_count, 11507768);
  assert.equal(typeof body.runs[0].url_count, "number");
  // Stated by the server so the UI does not keep a second copy of the retention.
  assert.ok(body.retention_ms > 0);

  // ---- THE RESTART CASE, which is the whole point ------------------------
  //
  // The token cache is process-local. Before the index, a restart turned every
  // outstanding token into a 404 with the bytes still on disk. Nothing in-process
  // has populated the cache here — the row was inserted directly — so this lookup
  // can only succeed by falling back to the index and rebuilding from out_dir,
  // which is exactly what a restarted API does.
  const rehydrated = await getCleanerRun(liveToken);

  assert.ok(rehydrated, "a token with no cache entry must still resolve");
  assert.equal(rehydrated?.domain, "https://example.com");
  assert.equal(rehydrated?.filename, "cleaned-sitemaps-2026-08-27.zip");
  // The run directory is the PARENT of out/, because that is what the TTL removes.
  assert.equal(rehydrated?.dir, live.runDir);
  assert.ok(
    rehydrated?.files.some((file) => file.filename === "sitemap-1.xml"),
    "the cleaned outputs are found again from the directory"
  );

  // The handoff routes must agree with it, and must offer XML ONLY — the run also
  // holds duplicates-report.csv, and ingesting that as a sitemap is the mistake
  // cleanerHandoffFiles exists to prevent.
  const handoff = await app.inject({
    method: "GET",
    url: "/api/cleaner/handoff/" + liveToken
  });

  assert.equal(handoff.statusCode, 200, handoff.body);

  const handoffFiles = handoff.json().files as Array<{ filename: string }>;

  assert.deepEqual(
    handoffFiles.map((file) => file.filename).sort(),
    ["sitemap-1.xml", "sitemap-index.xml"],
    "the CSV must not be handed off as a sitemap"
  );

  // ---- a row whose bytes are gone is not offered, and is forgotten -------
  //
  // staleArtifactSweep removes trees by age and consults no table, so a row CAN
  // outlive its directory. Offering such a run would produce a picker entry that
  // 404s the moment it is chosen, which reads as a broken feature rather than as
  // an expired run.
  const sweptId = randomUUID();
  const sweptToken = randomUUID();
  const swept = stageRun(root, sweptId);

  await pool.query(
    `
      INSERT INTO cleaner_runs
        (run_id, download_token, domain, zip_filename, out_dir,
         file_count, url_count, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '2 hours')
    `,
    [
      sweptId,
      sweptToken,
      "https://swept.example",
      "cleaned-sitemaps-2026-08-27.zip",
      swept.outDir,
      1,
      10
    ]
  );

  rmSync(swept.runDir, { recursive: true, force: true });

  const afterSweep = await app.inject({
    method: "GET",
    url: "/api/cleaner/runs"
  });
  const remaining = (afterSweep.json().runs as Array<{ domain: string }>).map(
    (run) => run.domain
  );

  assert.deepEqual(
    remaining,
    ["https://example.com"],
    "a run whose output directory is gone must not be offered"
  );

  const forgotten = await pool.query(
    "SELECT 1 FROM cleaner_runs WHERE download_token = $1",
    [sweptToken]
  );

  assert.equal(
    forgotten.rowCount,
    0,
    "and its row is dropped so the next listing does not re-stat it"
  );

  // A token whose row is gone resolves to nothing rather than to a broken entry.
  assert.equal(await getCleanerRun(sweptToken), undefined);

  // ---- an expired row is not offered, even with its bytes still present --
  //
  // expires_at is the deadline; the directory lingering until the 6-hour backstop
  // sweep must not extend a run's advertised life.
  const staleId = randomUUID();
  const staleToken = randomUUID();
  const stale = stageRun(root, staleId);

  await pool.query(
    `
      INSERT INTO cleaner_runs
        (run_id, download_token, domain, zip_filename, out_dir,
         file_count, url_count, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '1 minute')
    `,
    [
      staleId,
      staleToken,
      "https://stale.example",
      "cleaned-sitemaps-2026-08-27.zip",
      stale.outDir,
      1,
      10
    ]
  );

  const afterExpiry = await app.inject({
    method: "GET",
    url: "/api/cleaner/runs"
  });

  assert.deepEqual(
    (afterExpiry.json().runs as Array<{ domain: string }>).map(
      (run) => run.domain
    ),
    ["https://example.com"],
    "an expired run is not offered even though its files are still there"
  );

  assert.equal(
    await getCleanerRun(staleToken),
    undefined,
    "and its token no longer resolves"
  );
});
