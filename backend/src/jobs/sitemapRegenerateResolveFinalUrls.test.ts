import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// resolveFinalUrls itself never touches postgres — it only reads a sitemap
// file off disk (streamSitemapUrlLocs) and applies each pattern's decision in
// memory. Importing sitemapRegenerateJob.ts still opens a BullMQ queue at
// module load transitively (via sessionCompletion.ts, see the
// node-test-hang-not-redis / integration-test-must-close-queues lessons for
// this codebase), so this test still needs redis reachable and still closes
// that queue in t.after — it just skips the postgres/migrations setup the
// other sitemapRegenerateJob integration test needs.
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "regen-exclude-test-"));

process.env.UPLOAD_DIR = uploadDir;

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

test("resolveFinalUrls drops every URL matching an 'exclude' decision, and keeps as_is/unmatched URLs", async (t) => {
  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`redis not reachable at ${process.env.REDIS_URL} — skipping`);
    return;
  }

  const { resolveFinalUrls } = await import("./sitemapRegenerateJob.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeRedisLockClient } = await import("../queue/redisLock.js");

  t.after(async () => {
    await closePreGenerateZipQueue().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closeRedisLockClient().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const csvStoredFilename = "exclude-test-source.xml";

  writeFileSync(
    path.join(uploadDir, csvStoredFilename),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.test/niin-parts/1</loc></url>
  <url><loc>https://example.test/niin-parts/2</loc></url>
  <url><loc>https://example.test/other/1</loc></url>
</urlset>
`
  );

  const patternTemplates = new Map([
    ["excluded-pattern", "/niin-parts/{id}"],
    ["kept-pattern", "/other/{id}"]
  ]);

  const result = await resolveFinalUrls(
    csvStoredFilename,
    [
      { pattern_id: "excluded-pattern", mode: "exclude" },
      { pattern_id: "kept-pattern", mode: "as_is" }
    ],
    patternTemplates,
    silentLogger
  );

  assert.equal(
    result.excludedCount,
    2,
    "both niin-parts URLs were dropped by the exclude decision"
  );
  assert.equal(result.unclassifiedCount, 0);
  assert.deepEqual(
    result.urls.map((url) => url.loc),
    ["https://example.test/other/1"],
    "only the as_is-decided URL survives; excluded URLs are gone entirely"
  );
});
