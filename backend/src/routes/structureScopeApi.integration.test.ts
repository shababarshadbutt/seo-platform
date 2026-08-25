import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// The two API fields the Update Pattern modal's per-position scoping depends
// on, checked through the real routes.
//
// Both are the kind of thing a typecheck cannot catch and a UI bug reports
// late: the modal filters `urls` client-side to show a sample and a count, and
// downloads by `file_id`. If either comes back absent or wrong the modal
// degrades quietly — an empty preview, or a download of the wrong files.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "structure-api-itest-"));

process.env.UPLOAD_DIR = uploadDir;

const BASE = "https://example.com";
const TEMPLATE = "/rfq/{param}/{param}/{param}";

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

test("structures returns the URL pool, and source-files returns file ids", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip(`postgres not reachable at ${process.env.DATABASE_URL} — skipping`);
    return;
  }

  const Fastify = (await import("fastify")).default;
  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { sessionRoutes } = await import("./sessions.js");

  // routes/sessions.ts pulls in FIVE BullMQ queues transitively, every one of
  // which opens a Redis connection at module load. Without closing all of them
  // the test process never exits — the same trap documented in
  // jobs/sampleUrlCheck.ts. Imported here so the after hook can close them.
  const { closeSitemapQueue } = await import("../queue/sitemapQueue.js");
  const { closeBulkReplaceQueue } = await import(
    "../queue/bulkReplaceQueue.js"
  );
  const { closePublishQueue } = await import("../queue/publishQueue.js");
  const { closePreGenerateZipQueue } = await import(
    "../queue/preGenerateZipQueue.js"
  );
  const { closeMaintenanceQueue } = await import(
    "../queue/maintenanceQueue.js"
  );

  const app = Fastify({ logger: false });

  await app.register(sessionRoutes);
  await runMigrations(silentLogger);

  let sessionId: string | null = null;

  t.after(async () => {
    if (sessionId) {
      await pool
        .query("DELETE FROM sessions WHERE id = $1", [sessionId])
        .catch(() => {});
    }

    await app.close().catch(() => {});
    await closeSitemapQueue().catch(() => {});
    await closeBulkReplaceQueue().catch(() => {});
    await closePublishQueue().catch(() => {});
    await closePreGenerateZipQueue().catch(() => {});
    await closeMaintenanceQueue().catch(() => {});
    // v1.83's cache and the lock it uses each hold their own Redis connection.
    const { closeScanResultCache } = await import(
      "../cache/scanResultCache.js"
    );
    const { closeRedisLockClient } = await import("../queue/redisLock.js");

    closeScanResultCache();
    await closeRedisLockClient().catch(() => {});
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('structure scope api', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const patternRow = await pool.query<{ id: string }>(
    "INSERT INTO patterns (session_id, template, total_urls) VALUES ($1, $2, 120) RETURNING id",
    [sessionId, TEMPLATE]
  );
  const patternId = patternRow.rows[0].id;

  // A pool with two independent families per scoped position, so the clusters
  // the modal offers are real and the intersection is a strict subset.
  const A = ["niin-parts", "part-types"];
  const C = ["parts-catalog", "price-list"];

  for (let i = 0; i < 120; i += 1) {
    const a = `${A[i % A.length]}-${i}`;
    const c = `brand${i}-${C[Math.floor(i / A.length) % C.length]}`;
    const url = `${BASE}/rfq/${a}/mid-${i}/${c}`;

    await pool.query(
      "INSERT INTO pattern_urls (session_id, pattern_id, source_url, path) VALUES ($1, $2, $3, $4)",
      [sessionId, patternId, url, new URL(url).pathname]
    );
  }

  // ---- structures: clusters AND the pool they came from --------------------
  const structures = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/structures`
  });
  const body = structures.json();

  assert.equal(structures.statusCode, 200);
  assert.equal(body.url_pool_size, 120);
  assert.equal(body.urls.length, 120);
  assert.ok(body.urls[0].startsWith(`${BASE}/rfq/`));

  // Every structure the dropdowns will offer must be present in the pool the
  // modal filters — that equivalence is the whole reason the pool is returned
  // from THIS endpoint rather than reusing sampled_urls.
  const anchored = body.positions.flatMap(
    (position: { paramIndex: number; clusters: Array<{ anchor: unknown }> }) =>
      position.clusters
        .filter((cluster) => cluster.anchor !== null)
        .map((cluster) => ({ paramIndex: position.paramIndex, cluster }))
  );

  assert.ok(anchored.length >= 2, "expected anchored clusters at 2+ positions");

  const { resolveStructureFilters, urlMatchesStructureFilters } = await import(
    "../sitemaps/structureClusters.js"
  );

  for (const entry of anchored) {
    const anchor = entry.cluster.anchor as {
      direction: "prefix" | "suffix";
      value: string;
    };
    const resolved = resolveStructureFilters(
      [
        {
          param_index: entry.paramIndex,
          anchor: anchor.direction,
          value: anchor.value
        }
      ],
      TEMPLATE
    );

    assert.ok(resolved);
    assert.ok(
      body.urls.some((url: string) =>
        urlMatchesStructureFilters(url, resolved)
      ),
      `no pooled URL matches offered structure ${anchor.value} at param ${entry.paramIndex}`
    );
  }

  // ---- source-files: display name -> file id -------------------------------
  const stored = `${sessionId}-current-part-0.xml`;

  writeFileSync(
    path.join(uploadDir, stored),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset></urlset>\n',
    "utf8"
  );

  const fileRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, 120, now(), true, false)
      RETURNING id
    `,
    [sessionId, stored]
  );

  const { displaySourceFilename } = await import("../sitemaps/filenames.js");
  const display = displaySourceFilename(sessionId, stored);

  await pool.query(
    "INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count) VALUES ($1, $2, 120)",
    [patternId, display]
  );

  const sourceFiles = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files`
  });
  const files = sourceFiles.json().source_files;

  assert.equal(sourceFiles.statusCode, 200);
  assert.equal(files.length, 1);
  assert.equal(files[0].source_file, display);
  // The id the download's ?exclude= addresses. Resolved server-side precisely
  // so the client never derives one from a display name.
  assert.equal(files[0].file_id, fileRow.rows[0].id);

  // ---- source-files, SCOPED: counts must come from the real file, not the
  // whole-pattern rollup -------------------------------------------------
  //
  // The bug this covers: the modal's file list ignored "Limit this edit to"
  // entirely and always showed the whole pattern's rollup (120, the count
  // recorded above) regardless of which structure was selected. A real sitemap
  // file is written here with a KNOWN split across the two `A`-position
  // families (niin-parts vs part-types) so the assertion is on an exact,
  // independently-verifiable number rather than "some smaller number."
  const NIIN_COUNT = 7;
  const PART_TYPES_COUNT = 5;
  const scopedStored = `${sessionId}-current-part-1.xml`;
  const scopedLocs = [
    ...Array.from(
      { length: NIIN_COUNT },
      (_, i) => `${BASE}/rfq/niin-parts-${i}/mid-${i}/brand${i}-parts-catalog`
    ),
    ...Array.from(
      { length: PART_TYPES_COUNT },
      (_, i) => `${BASE}/rfq/part-types-${i}/mid-${i}/brand${i}-price-list`
    )
  ];

  writeFileSync(
    path.join(uploadDir, scopedStored),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${scopedLocs
      .map((loc) => `<url><loc>${loc}</loc></url>`)
      .join("")}</urlset>\n`,
    "utf8"
  );

  const scopedFileRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
      RETURNING id
    `,
    [sessionId, scopedStored, scopedLocs.length]
  );
  const scopedDisplay = displaySourceFilename(sessionId, scopedStored);

  // Recorded rollup deliberately WRONG (the whole pattern's 120, not this
  // file's real 12) — pattern_file_occurrences is a rollup built at extraction
  // time and is exactly what the scoped path must NOT read from.
  await pool.query(
    "INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count) VALUES ($1, $2, 120)",
    [patternId, scopedDisplay]
  );

  const niinFilterParam = encodeURIComponent(
    JSON.stringify([{ param_index: 0, anchor: "prefix", value: "niin-parts" }])
  );

  const scopedSourceFiles = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files?structure_filter=${niinFilterParam}`
  });
  const scopedBody = scopedSourceFiles.json();
  const scopedFile = scopedBody.source_files.find(
    (file: { source_file: string }) => file.source_file === scopedDisplay
  );

  assert.equal(scopedSourceFiles.statusCode, 200);
  assert.ok(scopedFile, "scoped file must appear in the scoped breakdown");
  assert.equal(scopedFile.occurrences, NIIN_COUNT);
  assert.equal(scopedFile.file_id, scopedFileRow.rows[0].id);

  // The unscoped display file (0 real "current" content, no niin-parts) must
  // be excluded entirely rather than showing its stale rollup of 120.
  assert.equal(
    scopedBody.source_files.some(
      (file: { source_file: string }) => file.source_file === display
    ),
    false
  );

  // A structure_filter naming a param_index the template doesn't have is
  // rejected the same way the PATCH .../rename route rejects it — ALL OR
  // NOTHING, never silently widened to unscoped.
  const badFilterParam = encodeURIComponent(
    JSON.stringify([{ param_index: 99, anchor: "prefix", value: "x" }])
  );
  const badFilterResponse = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files?structure_filter=${badFilterParam}`
  });

  assert.equal(badFilterResponse.statusCode, 400);

  const malformedResponse = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files?structure_filter=not-json`
  });

  assert.equal(malformedResponse.statusCode, 400);

  // ---- scope_skipped: WHY a scoped list came back short -------------------
  //
  // THE REPORTED BUG. The scoped scan discards candidate files at four separate
  // points and every one of them was silent, so all four reached the modal as
  // the same empty array and the same sentence, "No source files found for this
  // pattern." On the reported session the dropdown offered quote (885) and
  // manufacturer (115) — read from pattern_urls — while the file list showed 0
  // and Preview was dead, with nothing on screen to say why.
  //
  // The counters are a DIAGNOSTIC only: which files are accepted and what
  // occurrence numbers they carry must not change, which is what the
  // NIIN_COUNT assertion above and the unscoped check below pin down.

  // The empty `display` file is already a no_matches drop — it read fine and
  // contained no niin-parts URL. That is asserted as an exclusion above; here
  // it must also be COUNTED, because "excluded" and "explained" are the whole
  // difference this change makes.
  assert.ok(scopedBody.scope_skipped, "a scoped response must report its drops");
  assert.ok(
    scopedBody.scope_skipped.no_matches >= 1,
    "the file that read fine and matched nothing must be counted"
  );

  // A sitemap fetched from a URL: the row exists, filename is the URL itself
  // (parseSitemapJob inserts index children this way) and no code path ever
  // writes a local copy — so it can never be scanned OR edited. This is the
  // drop the reported session hits, and reporting it as "not found" is what
  // made a read-only file look like a broken tool.
  const remoteUrl = `${BASE}/remote-sitemap.xml`;

  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, 40, now(), true, false)
    `,
    [sessionId, remoteUrl]
  );
  await pool.query(
    "INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count) VALUES ($1, $2, 40)",
    [patternId, displaySourceFilename(sessionId, remoteUrl)]
  );

  // A row whose stored blob is absent from uploadDir — what deleteSessionUploads
  // leaves behind, since it reclaims the blobs and keeps sitemap_files.
  const missingStored = `${sessionId}-current-reclaimed.xml`;

  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, 30, now(), true, false)
    `,
    [sessionId, missingStored]
  );
  await pool.query(
    "INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count) VALUES ($1, $2, 30)",
    [patternId, displaySourceFilename(sessionId, missingStored)]
  );

  // An occurrence recorded at extraction whose sitemap_files row is gone.
  await pool.query(
    "INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count) VALUES ($1, $2, 20)",
    [patternId, "vanished.xml"]
  );

  const diagnosed = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files?structure_filter=${niinFilterParam}`
  });
  const diagnosedBody = diagnosed.json();

  assert.equal(diagnosed.statusCode, 200);
  assert.equal(diagnosedBody.scope_skipped.remote, 1);
  assert.equal(diagnosedBody.scope_skipped.unreadable, 1);
  assert.equal(diagnosedBody.scope_skipped.no_file_row, 1);
  assert.ok(diagnosedBody.scope_skipped.no_matches >= 1);

  // None of the three dropped files may appear, and the one real file's count
  // is still its own — the diagnostic must not have widened what is returned.
  const diagnosedNames = diagnosedBody.source_files.map(
    (file: { source_file: string }) => file.source_file
  );

  assert.deepEqual(diagnosedNames, [scopedDisplay]);
  assert.equal(diagnosedBody.source_files[0].occurrences, NIIN_COUNT);

  // The UNSCOPED rollup opens no files, so it has no drops to report. The key
  // must be ABSENT rather than zeroed: its absence is what tells the client
  // "dropping isn't a thing on this path", as distinct from "nothing was
  // dropped", and the rows themselves must be untouched by this change —
  // including the remote and reclaimed files, which the rollup has always
  // listed with a null file_id.
  const unscopedAfter = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files`
  });
  const unscopedBody = unscopedAfter.json();

  assert.equal(unscopedAfter.statusCode, 200);
  assert.equal(unscopedBody.scope_skipped, undefined);
  assert.equal(unscopedBody.source_files.length, 5);
  assert.ok(
    unscopedBody.source_files.every(
      (file: { occurrences: number }) => file.occurrences > 0
    )
  );
  assert.equal(
    unscopedBody.source_files.find(
      (file: { source_file: string }) => file.source_file === remoteUrl
    ).file_id,
    null
  );

  // ---- v1.83: the scoped scan is cached, and superseded entries are
  // unreachable rather than deleted -------------------------------------------
  //
  // WHY THIS MATTERS. The scan opens every sitemap the pattern spans — ~100s for
  // the widest pattern in the dev data — and the modal re-ran it on every
  // dropdown change. Caching it is only safe if a cached answer can never
  // outlive the files it describes, which is what the second case below checks.

  const cacheFilterParam = niinFilterParam;
  const cacheUrl = `/api/sessions/${sessionId}/patterns/${patternId}/source-files?structure_filter=${cacheFilterParam}`;

  const firstScoped = await app.inject({ method: "GET", url: cacheUrl });
  const secondScoped = await app.inject({ method: "GET", url: cacheUrl });

  assert.equal(firstScoped.statusCode, 200);
  assert.equal(secondScoped.statusCode, 200);

  // Identical answers, and the second one says it did not do the work. The
  // counters have to survive the round trip too: a cached empty list that lost
  // its scope_skipped would be back to the bare "No source files found" that
  // v1.80 removed.
  assert.deepEqual(
    secondScoped.json().source_files,
    firstScoped.json().source_files
  );
  assert.deepEqual(
    secondScoped.json().scope_skipped,
    firstScoped.json().scope_skipped
  );
  assert.ok(secondScoped.json().scope_skipped, "counters must survive a hit");
  assert.equal(secondScoped.json().cached, true);

  // THE INVALIDATION TEST. Repoint a file the way every real edit does
  // (copy-on-write to a new stored name) and the next request must MISS. If this
  // ever passes while still reporting cached:true, the modal would keep serving
  // a file list describing sitemaps that no longer exist — the exact class of
  // bug v1.80 and v1.81 were both spent chasing.
  // Mirrors buildRenamedStoredFilename: the marker goes BEFORE the display
  // label, so displaySourceFilename still maps this back to
  // "current-part-1.xml" and the occurrence row still matches. Dropping the
  // role segment here would change the display name and test nothing real.
  const movedStored = `${sessionId}-renamed-abcd1234-current-part-1.xml`;

  writeFileSync(
    path.join(uploadDir, movedStored),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset>${scopedLocs
      .slice(0, 3)
      .map((loc) => `<url><loc>${loc}</loc></url>`)
      .join("")}</urlset>
`,
    "utf8"
  );
  await pool.query("UPDATE sitemap_files SET filename = $1 WHERE id = $2", [
    movedStored,
    scopedFileRow.rows[0].id
  ]);

  const afterRepoint = await app.inject({ method: "GET", url: cacheUrl });

  assert.equal(afterRepoint.statusCode, 200);
  assert.notEqual(
    afterRepoint.json().cached,
    true,
    "a changed file set must make the old entry unreachable"
  );
  // And it reflects the NEW file: 3 of the niin-parts URLs, not the original 7.
  assert.equal(
    afterRepoint.json().source_files.find(
      (file: { source_file: string }) => file.source_file === scopedDisplay
    ).occurrences,
    3
  );

  // The UNSCOPED path is a DB rollup that opens no files, so it is never cached
  // and must never claim to be.
  const unscopedCacheCheck = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/patterns/${patternId}/source-files`
  });

  assert.equal(unscopedCacheCheck.statusCode, 200);
  assert.equal(unscopedCacheCheck.json().cached, undefined);
  assert.equal(unscopedCacheCheck.json().scope_skipped, undefined);
});
