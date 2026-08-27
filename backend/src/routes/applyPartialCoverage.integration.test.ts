import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// A FIX THAT REACHES PART OF A PATTERN MUST SAY SO (v1.81).
//
// THE REPORTED BEHAVIOUR. Several patterns showed a "Fixed" chip; the sitemap
// downloaded afterwards still contained the old URLs. Nothing had gone wrong in
// the rewrite: apply-redirects changes a <loc> only when a confirmed destination
// or an AGREED per-shape rule covers it, and on a pattern mixing several URL
// families that is a small minority of the population. Every non-zero rewrite
// count was reported as plain "applied", so twelve of 579,034 read exactly like
// a complete fix.
//
// This asserts the whole chain end to end against a real database, because every
// link in it is somewhere a unit test cannot reach: the route's SQL, the on-disk
// rewrite, the outcome classification, and the coverage columns migration 052
// added. Specifically:
//
//   * the file really is rewritten for the ONE URL that has a destination;
//   * the OTHER pattern URLs really are still in the file afterwards — the whole
//     point, and the thing the operator saw;
//   * the response says "partially-applied" and counts what it left;
//   * the skipped URLs come back grouped by shape with a REAL example, so the
//     modal can name them;
//   * patterns.redirects_skipped_locs is written, which is what turns the chip
//     amber on the next page load rather than only in this one toast.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "partial-itest-"));
const exportDir = mkdtempSync(path.join(os.tmpdir(), "partial-itest-exp-"));

process.env.UPLOAD_DIR = uploadDir;
process.env.EXPORT_DIR = exportDir;

const BASE = "https://example.com";

// One URL with a confirmed destination, and four without. Deliberately spread
// over two digit-run lengths so the skipped report has to group them the way
// valueShape does — which is the mechanism behind the second reported symptom, a
// fixed URL sitting next to an untouched sibling that looks identical to it.
const FIXABLE = BASE + "/nsn/nsn-parts-9558/";
const SKIPPED = [
  BASE + "/nsn/nsn-parts-3345/",
  BASE + "/nsn/nsn-parts-9541/",
  BASE + "/nsn/nsn-parts-12191/",
  BASE + "/nsn/nsn-parts-88123/"
];
const DESTINATION = BASE + "/nsn/nsn-parts/page-2-9558/";

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

test("an apply that reaches part of a pattern reports the remainder", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip("postgres not reachable — skipping");
    return;
  }

  if (!(await redisReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
    t.skip("redis not reachable — skipping");
    return;
  }

  const Fastify = (await import("fastify")).default;
  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { sessionRoutes } = await import("./sessions.js");
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
    await closePool().catch(() => {});
    rmSync(uploadDir, { recursive: true, force: true });
    rmSync(exportDir, { recursive: true, force: true });
  });

  const sessionRow = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, concurrency)
      VALUES ('partial coverage', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const display = "nsn-pagination-1.xml";
  const stored = sessionId + "-" + display;
  const allUrls = [FIXABLE, ...SKIPPED];

  writeFileSync(
    path.join(uploadDir, stored),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
      allUrls.map((url) => "  <url><loc>" + url + "</loc></url>").join("\n") +
      "\n</urlset>\n",
    "utf8"
  );

  await pool.query(
    `
      INSERT INTO sitemap_files (session_id, filename, total_urls, parsed_at, is_valid, is_index)
      VALUES ($1, $2, $3, now(), true, false)
    `,
    [sessionId, stored, allUrls.length]
  );

  const patternRow = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns (session_id, template, total_urls, status)
      VALUES ($1, '/nsn/{param}', $2, 'BAD')
      RETURNING id
    `,
    [sessionId, allUrls.length]
  );
  const patternId = patternRow.rows[0].id;

  await pool.query(
    `
      INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count)
      VALUES ($1, $2, $3)
    `,
    [patternId, display, allUrls.length]
  );

  // EXACTLY ONE confirmed destination. The other four redirect to nowhere anyone
  // measured, which is the ordinary state of a wide pattern rather than a
  // contrived one.
  await pool.query(
    `
      INSERT INTO sampled_urls
        (pattern_id, url, http_status, response_ms, is_hit, checked_at,
         final_url, redirect_count, http_status_category, source_file)
      VALUES ($1, $2, 308, 140, true, now(), $3, 1, 'redirect', $4)
    `,
    [patternId, FIXABLE, DESTINATION, display]
  );

  const response = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/" +
      patternId +
      "/apply-redirects",
    payload: {}
  });

  assert.equal(response.statusCode, 200);

  const body = response.json();

  // 1. The work that landed.
  assert.equal(body.rewritten_loc_count, 1);

  // 2. THE SYMPTOM, asserted directly: the other four URLs are still in the file
  // exactly as they were. This is what the operator downloaded and reported.
  const rewritten = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const contents = readFileSync(
    path.join(uploadDir, rewritten.rows[0].filename),
    "utf8"
  );

  assert.ok(contents.includes(DESTINATION), "the fixable URL was rewritten");

  for (const url of SKIPPED) {
    assert.ok(contents.includes(url), url + " was left in the file");
  }

  // 3. And now the report says so, instead of calling it done.
  assert.equal(body.outcome, "partially-applied");
  assert.equal(body.skipped_in_scope, SKIPPED.length);
  assert.match(body.outcome_message, /1 of 5 URLs/);

  // 4. Grouped by shape, with real URLs — 3345/9541 share a four-digit run,
  // 12191/88123 share a five-digit one. A reviewer reads the examples, never the
  // shape keys.
  const shapes: Array<{
    shape: string;
    count: number;
    example: string;
    examples: string[];
    files: number;
  }> = body.skipped_shapes;

  assert.equal(shapes.length, 2);
  assert.equal(shapes[0].count, 2, "biggest group first");
  assert.ok(
    SKIPPED.includes(shapes[0].example),
    "the example is one of the URLs actually skipped"
  );
  assert.equal(body.skipped_shapes_truncated, false);

  // 5. Persisted, so the table's chip reads "Partly fixed" on the next load and
  // not only in the toast this request produced.
  const coverage = await pool.query<{
    redirects_applied_at: string | null;
    redirects_applied_locs: string | null;
    redirects_skipped_locs: string | null;
  }>(
    `
      SELECT redirects_applied_at, redirects_applied_locs, redirects_skipped_locs
      FROM patterns WHERE id = $1
    `,
    [patternId]
  );

  assert.ok(coverage.rows[0].redirects_applied_at, "the fix is stamped");
  assert.equal(Number(coverage.rows[0].redirects_applied_locs), 1);
  assert.equal(
    Number(coverage.rows[0].redirects_skipped_locs),
    SKIPPED.length,
    "the shortfall is stored beside the timestamp, not only returned"
  );

  // ---- v1.84: the operator resolves one group, and ONLY that group ---------
  //
  // Everything above is the reported dead end: the report names the groups it
  // could not fix and stops. This is the way out. The operator edits real URLs
  // of one group into what they should be, the server distils a rule from those
  // pairs, and the next apply covers that group.
  //
  // The second half of the assertion matters more than the first: the OTHER
  // group must come through byte-identical. A rule saved for one shape that
  // quietly rewrote its neighbours would be the v1.68 overreach wearing a new
  // hat, and on a 10M-URL pattern nobody would notice until the sitemap shipped.

  // Per-shape examples are what the dialog puts in front of the operator to
  // edit, so the test uses them rather than reaching for the fixture — if the
  // tally ever stopped populating them, the editor would have nothing to show.
  assert.ok(
    shapes[0].examples.length >= 2,
    "the group must offer several real URLs to edit"
  );
  assert.ok(shapes[0].files >= 1, "and say how many files it spans");

  const chosen = shapes[0];
  const other = shapes[1];
  const asDestination = (url: string) =>
    url.replace("/nsn/nsn-parts-", "/nsn/nsn-parts/page-2-");

  const saved = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: {
      shape: chosen.shape,
      pairs: chosen.examples.map((url: string) => ({
        source: url,
        dest: asDestination(url)
      }))
    }
  });

  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().source, "operator");

  // Stored as ASSERTED, never as measured: sample_size 0 means nothing was
  // probed, and source distinguishes it from a stratum that agreed.
  const storedRule = await pool.query<{
    source: string;
    agreed: boolean;
    sample_size: number;
    rule: unknown;
  }>(
    "SELECT source, agreed, sample_size, rule FROM pattern_shape_rules WHERE pattern_id = $1",
    [patternId]
  );

  assert.equal(storedRule.rowCount, 1);
  assert.equal(storedRule.rows[0].source, "operator");
  assert.equal(storedRule.rows[0].agreed, true);
  assert.equal(storedRule.rows[0].sample_size, 0);
  assert.ok(storedRule.rows[0].rule, "an operator row must carry a rule");

  // An operator rule must never masquerade as a fetched URL — the distinction
  // migration 051 spent two releases restoring.
  const leaked = await pool.query(
    "SELECT 1 FROM verified_urls WHERE pattern_id = $1",
    [patternId]
  );

  assert.equal(leaked.rowCount, 0, "nothing was written to verified_urls");

  const second = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/" +
      patternId +
      "/apply-redirects",
    payload: {}
  });

  assert.equal(second.statusCode, 200, second.body);

  const afterFiles = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const after = readFileSync(
    path.join(uploadDir, afterFiles.rows[0].filename),
    "utf8"
  );

  for (const url of chosen.examples) {
    assert.ok(
      after.includes(asDestination(url)),
      url + " should have been rewritten by the rule the operator supplied"
    );
    assert.ok(!after.includes(url), url + " should no longer be present");
  }

  // THE GUARD. The other shape shares a prefix with the one that was fixed, so a
  // rule applied pattern-wide instead of shape-wide would have taken it too.
  assert.ok(
    after.includes(other.example),
    other.example + " must be untouched — its group has no rule"
  );

  // ---- v1.85: one edit resolves MANY groups -------------------------------
  //
  // The reported case was 24 groups sharing /cage-code-lookup/ with one correct
  // change between them, resolved one at a time. This is the bulk path: one set
  // of pairs, several shapes, one request.
  const bulk = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: {
      shapes: [chosen.shape, other.shape],
      pairs: chosen.examples.map((url: string) => ({
        source: url,
        dest: asDestination(url)
      }))
    }
  });

  assert.equal(bulk.statusCode, 200, bulk.body);
  assert.deepEqual(bulk.json().shapes, [chosen.shape, other.shape]);

  const bulkRows = await pool.query<{ shape: string; source: string }>(
    "SELECT shape, source FROM pattern_shape_rules WHERE pattern_id = $1 ORDER BY shape",
    [patternId]
  );

  assert.equal(bulkRows.rowCount, 2, "a row per shape, from one request");
  assert.ok(bulkRows.rows.every((row) => row.source === "operator"));

  const third = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/" +
      patternId +
      "/apply-redirects",
    payload: {}
  });

  assert.equal(third.statusCode, 200, third.body);

  const finalFiles = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const finalContents = readFileSync(
    path.join(uploadDir, finalFiles.rows[0].filename),
    "utf8"
  );

  // ONE apply now covers BOTH groups — the second group's URLs were untouched
  // by the previous apply and are rewritten by this one.
  assert.ok(
    finalContents.includes(asDestination(other.example)),
    other.example + " should be rewritten once its group has a rule too"
  );
  assert.ok(!finalContents.includes(other.example));

  // AND THE DOCUMENTED CONSEQUENCE of saving for every selected shape without
  // checking that the rule matches each one: a shape the rule cannot transform
  // still gets its row. It is not silent — the apply's own coverage report is
  // computed from what the rewriter actually declined, so such a group keeps
  // being reported as unfixed instead of vanishing into a false "resolved".
  const unmatchable = "/nsn/nothing-of-this-shape-9999/";

  const saved2 = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: {
      shapes: [unmatchable],
      rule: { kind: "replace", find: "zzz-not-present", replace: "qqq" }
    }
  });

  assert.equal(saved2.statusCode, 200, "it saves regardless, by design");

  const stored2 = await pool.query(
    "SELECT 1 FROM pattern_shape_rules WHERE pattern_id = $1 AND shape = $2",
    [patternId, unmatchable]
  );

  assert.equal(stored2.rowCount, 1, "the row exists even though it matches nothing");

  // ---- v1.86: the dialog can READ BACK what it has already been told -------
  //
  // The trade-off just asserted above is exactly why this endpoint had to exist.
  // A group whose rule cannot transform it keeps reappearing in the coverage
  // report — correct, and indistinguishable from a group nobody has answered
  // unless the saved rules can be read back. Without that, the operator retypes
  // the rule that already failed, applies, sees the group again, and loops.
  const readBack = await app.inject({
    method: "GET",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rules"
  });

  assert.equal(readBack.statusCode, 200, readBack.body);

  const rules = readBack.json().rules as Array<{
    shape: string;
    rule: unknown;
    source: string;
    agreed: boolean;
    sample_size: number;
  }>;

  // Every rule saved above comes back, including the unmatchable one — which is
  // the whole point: that group is the one the dialog has to be able to flag.
  const byShape = new Map(rules.map((row) => [row.shape, row]));

  assert.ok(byShape.has(chosen.shape), "the resolved group's rule is readable");
  assert.ok(byShape.has(other.shape), "and the bulk-saved group's");
  assert.ok(
    byShape.has(unmatchable),
    "and the one whose rule matches nothing, so the dialog can say so"
  );

  // PROVENANCE SURVIVES THE ROUND TRIP. A read path that flattened these to
  // "has a rule" would undo what migrations 051 and 053 spent two releases
  // establishing, so the columns come through unchanged.
  assert.equal(byShape.get(chosen.shape)?.source, "operator");
  assert.equal(byShape.get(chosen.shape)?.agreed, true);
  assert.equal(Number(byShape.get(chosen.shape)?.sample_size), 0);
  assert.ok(byShape.get(chosen.shape)?.rule, "the rule itself is returned");

  const missingPattern = await app.inject({
    method: "GET",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/00000000-0000-0000-0000-000000000000/shape-rules"
  });

  assert.equal(missingPattern.statusCode, 404, "an unknown pattern is a 404");

  // ---- v1.86: a re-apply that changes nothing still refreshes the residue --
  //
  // WHAT WAS WRONG. The coverage columns were written only when a <loc> actually
  // changed, so the numbers and the group list on the row were whatever the LAST
  // apply that rewrote something had left there. That is now read back — the
  // Partly fixed chip reopens the unfixed-groups dialog from
  // redirects_skipped_shapes — so a stale list puts groups that have already been
  // resolved back in front of the operator.
  const before = await pool.query<{
    redirects_applied_at: Date;
    redirects_applied_locs: number;
  }>(
    "SELECT redirects_applied_at, redirects_applied_locs FROM patterns WHERE id = $1",
    [patternId]
  );

  // Everything this pattern can reach has now been rewritten, so this apply
  // changes nothing — the exact case that used to leave the columns untouched.
  const noop = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/" +
      patternId +
      "/apply-redirects",
    payload: {}
  });

  assert.equal(noop.statusCode, 200, noop.body);
  assert.equal(
    noop.json().rewritten_loc_count,
    0,
    "this apply must rewrite nothing for the assertion below to mean anything"
  );

  const afterNoop = await pool.query<{
    redirects_applied_at: Date;
    redirects_applied_locs: number;
    redirects_skipped_locs: number;
  }>(
    `
      SELECT redirects_applied_at, redirects_applied_locs, redirects_skipped_locs
      FROM patterns WHERE id = $1
    `,
    [patternId]
  );

  // THE TIMESTAMP IS UNTOUCHED. "A pattern is fixed when a URL changed, and not
  // otherwise" (v1.74) still holds — this run changed nothing and must not
  // re-stamp the pattern as freshly fixed.
  assert.equal(
    afterNoop.rows[0].redirects_applied_at.getTime(),
    before.rows[0].redirects_applied_at.getTime(),
    "a no-op apply must not re-stamp redirects_applied_at"
  );

  // AND THE APPLIED COUNT IS UNTOUCHED. Writing this run's zero would report
  // that a pattern which was demonstrably fixed had never been applied to.
  assert.equal(
    Number(afterNoop.rows[0].redirects_applied_locs),
    Number(before.rows[0].redirects_applied_locs),
    "a no-op apply must not overwrite the applied count with its own zero"
  );

  // BUT THE SHORTFALL IS NOW CURRENT. It was SKIPPED.length when only one URL
  // had a destination; those groups have since been rewritten, so what is left
  // is smaller than it was.
  assert.ok(
    Number(afterNoop.rows[0].redirects_skipped_locs) < SKIPPED.length,
    "the persisted shortfall must reflect this run, not the first one"
  );

  // ---- v1.87: "these URLs are already correct — leave them" ----------------
  //
  // The third answer. v1.86 gave a group two states — it has a rule, or nobody
  // has said anything — and a group that needs NO rewrite fitted neither, so it
  // sat under "still needs an answer" for ever and every pass re-examined it.
  //
  // The apply already left such a group alone; what is asserted here is that the
  // DECISION is recorded, that it cannot reach the rewriter, and that it is
  // mutually exclusive with a rule.
  const marked = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: { shapes: [unmatchable], no_change: true }
  });

  assert.equal(marked.statusCode, 200, marked.body);
  assert.equal(marked.json().source, "no_change");
  assert.equal(marked.json().rule, null, "a mark carries no rewrite");

  // MUTUAL EXCLUSIVITY, and it is the reason this shares one row with the rule
  // rather than living in a table of its own. `unmatchable` was carrying an
  // operator rule from the section above; marking it must REPLACE that, not sit
  // beside it, or something would later have to decide which of two contradictory
  // answers wins.
  const markedRow = await pool.query<{
    source: string;
    rule: unknown;
    agreed: boolean;
    sample_size: number;
  }>(
    `
      SELECT source, rule, agreed, sample_size
      FROM pattern_shape_rules
      WHERE pattern_id = $1 AND shape = $2
    `,
    [patternId, unmatchable]
  );

  assert.equal(markedRow.rowCount, 1, "one row, not two");
  assert.equal(markedRow.rows[0].source, "no_change");
  assert.equal(markedRow.rows[0].rule, null, "the old rule is gone, not kept");
  assert.equal(
    markedRow.rows[0].agreed,
    false,
    "a mark agrees to nothing — this is what keeps it away from the rewriter"
  );
  assert.equal(Number(markedRow.rows[0].sample_size), 0);

  // AND THE DIALOG CAN READ IT BACK. The v1.86 GET filtered on rule IS NOT NULL,
  // which would have hidden every one of these rows and put the group straight
  // back under "still needs an answer" — losing the only thing this records.
  const withMarks = await app.inject({
    method: "GET",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rules"
  });

  assert.equal(withMarks.statusCode, 200, withMarks.body);

  const markedRead = (
    withMarks.json().rules as Array<{ shape: string; source: string }>
  ).find((row) => row.shape === unmatchable);

  assert.ok(markedRead, "a no_change row must survive the read filter");
  assert.equal(markedRead?.source, "no_change");

  // ---- the mark cannot rewrite anything -----------------------------------
  //
  // Mark a group that DOES have matchable URLs, then apply, and assert its URLs
  // are byte-identical afterwards. `chosen` was already rewritten earlier, so the
  // subject here is `other`, whose destination form is what a rule would produce.
  const markedOther = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: { shapes: [other.shape], no_change: true }
  });

  assert.equal(markedOther.statusCode, 200, markedOther.body);

  const beforeMarkApply = readFileSync(
    path.join(uploadDir, finalFiles.rows[0].filename),
    "utf8"
  );

  const afterMark = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" +
      sessionId +
      "/patterns/" +
      patternId +
      "/apply-redirects",
    payload: {}
  });

  assert.equal(afterMark.statusCode, 200, afterMark.body);

  const markFiles = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const afterMarkContents = readFileSync(
    path.join(uploadDir, markFiles.rows[0].filename),
    "utf8"
  );

  assert.equal(
    afterMarkContents,
    beforeMarkApply,
    "an apply over marked groups must not change a single byte"
  );

  // ---- the undo returns the group to unanswered ---------------------------
  //
  // The mark is persisted, so it has to be reversible from the same place — and
  // it DELETES the row rather than writing a "not marked" one, because the
  // absence of a row is already how this table spells "nobody has said anything".
  const undone = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: { shapes: [other.shape], no_change: false }
  });

  assert.equal(undone.statusCode, 200, undone.body);

  const goneRow = await pool.query(
    "SELECT 1 FROM pattern_shape_rules WHERE pattern_id = $1 AND shape = $2",
    [patternId, other.shape]
  );

  assert.equal(goneRow.rowCount, 0, "undo removes the row entirely");

  const badFlag = await app.inject({
    method: "POST",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule",
    payload: { shapes: [other.shape], no_change: "yes" }
  });

  assert.equal(badFlag.statusCode, 400, "no_change must be a boolean");

  // ---- migration 055's invariant is enforced by the DATABASE --------------
  //
  // The write path assigns rule = NULL itself, so this asserts the constraint
  // rather than the route: no future caller can produce a "leave these alone" row
  // that secretly carries a rewrite the apply would honour.
  await assert.rejects(
    () =>
      pool.query(
        `
          INSERT INTO pattern_shape_rules
            (pattern_id, shape, rule, sample_size, population, agreed, source)
          VALUES ($1, $2, $3::jsonb, 0, 0, true, 'no_change')
        `,
        [
          patternId,
          "/some/other-shape-9999/",
          JSON.stringify({ kind: "replace", find: "a", replace: "b" })
        ]
      ),
    /no_change_has_no_rule/,
    "a no_change row carrying a rule must be rejected by the CHECK"
  );
});
