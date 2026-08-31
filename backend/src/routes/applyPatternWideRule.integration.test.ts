import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import pg from "pg";

// ONE ANSWER THAT FINISHES A PATTERN (v1.90).
//
// THE REPORTED BEHAVIOUR. On /aviation/{param}/{param}/{param} the SEO team
// ticked all 25 unfixed groups, gave them ONE answer — strip "aviation/" — and
// pressed Fix. The run reported 149,745 of 8,184,592 URLs updated across 653 of
// 653 files. Reopening showed 25 fresh groups and 8,034,847 still unfixed. Repeat
// forever.
//
// WHY, AND WHY IT WAS NOT A REWRITE BUG. A group here is a valueShape, which keeps
// digit-run LENGTH, so /rfq/textron-inc/95-23218/ and
// /rfq/bell-industries-inc/t103228-101/ are DIFFERENT groups needing separate
// rules. That pattern holds thousands of them; a coverage report names 25 per
// pass; the dialog can only save rules for the groups it can see. Every pass paid
// a full 653-file scan to teach the rewriter 25 shapes. No list of groups anybody
// can be handed finishes that pattern.
//
// The operator's answer was never shape-specific. This asserts the scope it
// actually has, end to end against a real database, because every link is
// somewhere a unit test cannot reach — the route's SQL, migration 056's CHECKs,
// resolveApplyInputs' two queries, and the on-disk rewrite:
//
//   * a first apply leaves the whole pattern alone and says so, the reported
//     dead end reproduced;
//   * one pattern-wide answer, derived from ONE group's examples by the same
//     deriveRedirectRule a probe would use, rewrites EVERY group — including the
//     ones no report ever listed;
//   * a URL of a DIFFERENT pattern in the same file comes through byte-identical,
//     even though the rule's find string occurs in it. That guard is the whole
//     reason the fallback is template-gated;
//   * a group with its own answer keeps it — the catch-all is consulted last;
//   * the row is stored as its own provenance, never as a fetched URL;
//   * the undo removes it.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "patternwide-itest-"));
const exportDir = mkdtempSync(path.join(os.tmpdir(), "patternwide-itest-exp-"));

process.env.UPLOAD_DIR = uploadDir;
process.env.EXPORT_DIR = exportDir;

const BASE = "https://www.nsnfulfillment.com";
const TEMPLATE = "/aviation/{param}/{param}/{param}";

// THE POPULATION, and every URL here is doing a job.
//
// Eight distinct valueShapes over four segments — vendor names differing in hyphen
// count crossed with part numbers differing in letter/digit layout. That is the
// real mechanism behind "thousands of groups", reproduced small: no two of these
// share a shape, so under the old design each needed its own saved rule.
const PATTERN_URLS = [
  BASE + "/aviation/rfq/national-semiconductor-corp/am27c32qe45/",
  BASE + "/aviation/rfq/eurocopter-france/365a2160202001/",
  BASE + "/aviation/rfq/hartzell-propeller-inc/j3f20500afm/",
  BASE + "/aviation/rfq/textron-inc/95-23218/",
  BASE + "/aviation/rfq/bell-industries-inc/t103228-101/",
  BASE + "/aviation/rfq/zodiac-in-lhc/1024-931-0/",
  BASE + "/aviation/rfq/avx-corp/1210zd106kata/",
  BASE + "/aviation/rfq/smiths-aerospace-inc/d55342k07b20d0m/"
];

// ONE CONFIRMED DESTINATION, and it is not decoration.
//
// An apply with nothing to rewrite does not open a file, so it cannot report a
// shortfall either — correctly, since it has established nothing about what was
// missed (v1.74). The reported session had confirmed pairs, which is exactly why
// it produced "149,745 of 8,184,592 updated" rather than silence. One measured
// URL is what puts this test in the state the screenshots were taken in.
const FIXABLE = BASE + "/aviation/rfq/apex-tool-group/at9-1234/";

// A NEIGHBOUR THAT MUST NOT MOVE. Same sitemap file, contains "aviation/", and the
// rule the operator types would transform it happily — only the template stops it.
// Three segments, so it is not a member of TEMPLATE.
const OTHER_PATTERN_URL = BASE + "/aviation/rfq/curtiss-wright-corp/";

// Strip the /aviation prefix — the change the operator actually asked for.
const stripAviation = (url: string) => url.replace("/aviation/", "/");

async function postgresReachable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 1500
  });

  try {
    await client.connect();
    await client.end();

    return true;
  } catch {
    return false;
  }
}

function redisReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(process.env.REDIS_URL as string);
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 6379)
    });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };

    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

const silentLogger: any = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger
};

test("one pattern-wide answer fixes every group, and only this pattern", async (t) => {
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
      VALUES ('pattern wide rule', $1, 5, 10)
      RETURNING id
    `,
    [BASE]
  );

  sessionId = sessionRow.rows[0].id;

  const display = "aviation-rfq-1.xml";
  const stored = sessionId + "-" + display;
  const allUrls = [FIXABLE, ...PATTERN_URLS, OTHER_PATTERN_URL];

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
      VALUES ($1, $2, $3, 'BAD')
      RETURNING id
    `,
    [sessionId, TEMPLATE, PATTERN_URLS.length + 1]
  );
  const patternId = patternRow.rows[0].id;

  await pool.query(
    `
      INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count)
      VALUES ($1, $2, $3)
    `,
    [patternId, display, PATTERN_URLS.length + 1]
  );

  await pool.query(
    `
      INSERT INTO sampled_urls
        (pattern_id, url, http_status, response_ms, is_hit, checked_at,
         final_url, redirect_count, http_status_category, source_file)
      VALUES ($1, $2, 308, 140, true, now(), $3, 1, 'redirect', $4)
    `,
    [patternId, FIXABLE, stripAviation(FIXABLE), display]
  );

  const applyUrl =
    "/api/sessions/" +
    sessionId +
    "/patterns/" +
    patternId +
    "/apply-redirects";
  const shapeRuleUrl =
    "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rule";

  // ---- 1. THE DEAD END, reproduced ---------------------------------------
  //
  // No confirmed destination, no derivable rule, no per-shape rule: the apply
  // correctly declines every URL (v1.68) and reports what it left. This is the
  // state the screenshots were taken in.
  const first = await app.inject({
    method: "POST",
    url: applyUrl,
    payload: {}
  });

  assert.equal(first.statusCode, 200, first.body);
  assert.equal(
    first.json().rewritten_loc_count,
    1,
    "only the one measured URL — the reported shortfall, in miniature"
  );
  assert.equal(first.json().outcome, "partially-applied");
  assert.equal(
    first.json().skipped_in_scope,
    PATTERN_URLS.length,
    "every other pattern URL is reported unfixed, and the neighbour is not counted"
  );

  const groups = first.json().skipped_shapes as Array<{
    shape: string;
    count: number;
    example: string;
    examples: string[];
  }>;

  // EIGHT GROUPS FOR EIGHT URLS. This is the fragmentation, asserted: one URL per
  // valueShape means answering group by group is answering URL by URL, which is
  // why 25 rows per pass cannot finish 8.2M URLs.
  assert.equal(
    groups.length,
    PATTERN_URLS.length,
    "every URL landed in a group of its own — this is the fragmentation"
  );

  // ---- 2. ONE ANSWER, AT PATTERN SCOPE -----------------------------------
  //
  // Derived from ONE group's examples, exactly as the dialog sends it: the
  // operator edits real URLs and the server distils the rule. `shapes` is not
  // sent, because the whole point is that no list of shapes would do.
  const chosen = groups[0];
  const saved = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: {
      scope: "pattern",
      pairs: chosen.examples.map((url: string) => ({
        source: url,
        dest: stripAviation(url)
      }))
    }
  });

  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().source, "operator_pattern");
  assert.equal(saved.json().scope, "pattern");
  assert.deepEqual(
    saved.json().shapes,
    [],
    "no GROUP was answered individually, so none is claimed"
  );
  assert.deepEqual(saved.json().rule, {
    kind: "replace",
    find: "aviation/",
    replace: ""
  });

  // Stored under the sentinel shape, as ASSERTED at pattern scope — a fourth
  // provenance, not 'operator' with a magic shape. resolveApplyInputs filters on
  // exactly this column, because a "*" row in the per-shape map could never match.
  const storedRule = await pool.query<{
    shape: string;
    source: string;
    agreed: boolean;
    sample_size: number;
    rule: unknown;
  }>(
    "SELECT shape, source, agreed, sample_size, rule FROM pattern_shape_rules WHERE pattern_id = $1",
    [patternId]
  );

  assert.equal(storedRule.rowCount, 1, "one row for the whole pattern");
  assert.equal(storedRule.rows[0].shape, "*");
  assert.equal(storedRule.rows[0].source, "operator_pattern");
  assert.equal(storedRule.rows[0].agreed, true);
  assert.equal(
    storedRule.rows[0].sample_size,
    0,
    "nothing was sampled, so no number sits next to the word sample"
  );

  // Never a fetched URL. The distinction migration 051 spent two releases
  // restoring, asserted again at the new scope.
  const leaked = await pool.query(
    "SELECT 1 FROM verified_urls WHERE pattern_id = $1",
    [patternId]
  );

  assert.equal(leaked.rowCount, 0, "nothing was written to verified_urls");

  // ---- 3. ONE APPLY FINISHES THE PATTERN ---------------------------------
  const second = await app.inject({
    method: "POST",
    url: applyUrl,
    payload: {}
  });

  assert.equal(second.statusCode, 200, second.body);
  assert.equal(
    second.json().rewritten_loc_count,
    PATTERN_URLS.length,
    "every URL of the pattern, not 25 groups' worth"
  );
  assert.equal(
    second.json().skipped_in_scope,
    0,
    "and nothing is left behind to report"
  );

  const afterFiles = await pool.query<{ filename: string }>(
    "SELECT filename FROM sitemap_files WHERE session_id = $1",
    [sessionId]
  );
  const after = readFileSync(
    path.join(uploadDir, afterFiles.rows[0].filename),
    "utf8"
  );

  for (const url of PATTERN_URLS) {
    assert.ok(
      after.includes(stripAviation(url)),
      url + " should have been rewritten by the pattern-wide rule"
    );
    assert.ok(!after.includes(url), url + " should no longer be present");
  }

  // THE GUARD, and the reason the fallback carries a template. The rule's find
  // string occurs in this URL and the rule would transform it — it is only
  // untouched because it is not a member of TEMPLATE. Without this, a
  // pattern-wide answer would silently edit the neighbouring patterns that share
  // these 653 files, which is the v1.68 overreach wearing a success message.
  assert.ok(
    after.includes(OTHER_PATTERN_URL),
    OTHER_PATTERN_URL + " belongs to another pattern and must be byte-identical"
  );

  // ---- 4. READ BACK, so the dialog can see the answer is in force ---------
  const readBack = await app.inject({
    method: "GET",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rules"
  });

  assert.equal(readBack.statusCode, 200, readBack.body);
  assert.deepEqual(
    readBack.json().rules,
    [],
    "the sentinel row is NOT a group — nothing in a coverage report matches '*'"
  );
  assert.equal(readBack.json().pattern_rule.source, "operator_pattern");
  assert.deepEqual(readBack.json().pattern_rule.rule, {
    kind: "replace",
    find: "aviation/",
    replace: ""
  });
  assert.ok(
    readBack.json().pattern_rule.authored_at,
    "and WHEN, so a group rule saved before it can be told apart"
  );

  // ---- 5. A GROUP'S OWN ANSWER STILL WINS --------------------------------
  //
  // PRECEDENCE, on real files. The catch-all is consulted last, so a group with a
  // measured or asserted rule of its own keeps it. Folding the two would let one
  // pattern-wide save overwrite work that was already correct — the opposite of
  // what a second pass is for.
  // FOUND BY ITS EXAMPLES, not by index. Every group here holds one URL, so the
  // report is sorted by shape string and groups[1] is whichever shape sorts
  // second — not the second URL of the fixture. Looking it up is the only way the
  // assertion below is about the URL it names.
  const revert = PATTERN_URLS[1];
  const revertGroup = groups.find((group) => group.examples.includes(revert));

  assert.ok(revertGroup, "the fixture URL must appear in one of the groups");

  writeFileSync(
    path.join(uploadDir, afterFiles.rows[0].filename),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
      "  <url><loc>" + revert + "</loc></url>\n" +
      "</urlset>\n",
    "utf8"
  );

  const specific = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: {
      shapes: [revertGroup.shape],
      rule: { kind: "replace", find: "/aviation/", replace: "/specific/" }
    }
  });

  assert.equal(specific.statusCode, 200, specific.body);

  const third = await app.inject({
    method: "POST",
    url: applyUrl,
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

  assert.ok(
    finalContents.includes(revert.replace("/aviation/", "/specific/")),
    "the group's own rule wins over the pattern-wide one"
  );
  assert.ok(
    !finalContents.includes(stripAviation(revert)),
    "so the pattern-wide rule did not get there first"
  );

  // ---- 6. THE UNDO -------------------------------------------------------
  //
  // DELETEs the row, matching how a "leave as it is" mark undoes itself: the
  // absence of a row is already how "nobody has asserted anything at this scope"
  // is spelled, and a second spelling would leave the dialog two states to treat
  // as one.
  const cleared = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: { scope: "pattern", clear: true }
  });

  assert.equal(cleared.statusCode, 200, cleared.body);

  const gone = await pool.query(
    "SELECT 1 FROM pattern_shape_rules WHERE pattern_id = $1 AND source = 'operator_pattern'",
    [patternId]
  );

  assert.equal(gone.rowCount, 0, "undo removes the row entirely");

  const afterClear = await app.inject({
    method: "GET",
    url:
      "/api/sessions/" + sessionId + "/patterns/" + patternId + "/shape-rules"
  });

  assert.equal(
    afterClear.json().pattern_rule,
    null,
    "and the dialog reads back that nothing is in force"
  );
  assert.equal(
    afterClear.json().rules.length,
    1,
    "while the group's own rule is untouched by clearing the pattern one"
  );

  // ---- 7. REFUSALS ------------------------------------------------------
  //
  // The refusal that matters most is unchanged and shared: edits that describe
  // more than one change cannot distil to a rule, and saying so is better than
  // storing something the rewriter would decline to honour. At pattern scope the
  // consequence of guessing would be 8M URLs wide.
  const inconsistent = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: {
      scope: "pattern",
      pairs: [
        { source: PATTERN_URLS[0], dest: stripAviation(PATTERN_URLS[0]) },
        { source: PATTERN_URLS[1], dest: PATTERN_URLS[1] + "?utm=1" }
      ]
    }
  });

  assert.equal(inconsistent.statusCode, 400, inconsistent.body);
  assert.match(inconsistent.json().message, /one consistent change/);

  const badScope = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: { scope: "everything", pairs: [] }
  });

  assert.equal(badScope.statusCode, 400, "an unknown scope is refused");

  // "The whole pattern is already correct" is not a thing this dialog can mean —
  // the coverage report has just counted the URLs it left behind — and migration
  // 056's CHECK would reject the row as a 500 rather than as an answer.
  const patternNoChange = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: { scope: "pattern", no_change: true }
  });

  assert.equal(patternNoChange.statusCode, 400, patternNoChange.body);

  // `clear` without the scope it belongs to is a caller mistake worth naming
  // rather than silently ignoring — it reads as "remove this" and would do
  // nothing at all.
  const strayClear = await app.inject({
    method: "POST",
    url: shapeRuleUrl,
    payload: { shapes: ["/a/"], clear: true }
  });

  assert.equal(strayClear.statusCode, 400, strayClear.body);

  // ---- 8. MIGRATION 056's INVARIANTS ARE ENFORCED BY THE DATABASE --------
  //
  // The write path assigns these itself, so this asserts the CHECKs rather than
  // the route: no future caller can produce a pattern-wide row that carries no
  // rewrite, or one filed against a real shape where it would read as covering
  // that group alone.
  await assert.rejects(
    () =>
      pool.query(
        `
          INSERT INTO pattern_shape_rules
            (pattern_id, shape, rule, sample_size, population, agreed, source)
          VALUES ($1, '*', NULL, 0, 0, true, 'operator_pattern')
        `,
        [patternId]
      ),
    /pattern_wide_has_rule/,
    "a pattern-wide row with nothing to apply must be rejected"
  );

  await assert.rejects(
    () =>
      pool.query(
        `
          INSERT INTO pattern_shape_rules
            (pattern_id, shape, rule, sample_size, population, agreed, source)
          VALUES ($1, '/a/a-9999/', $2::jsonb, 0, 0, true, 'operator_pattern')
        `,
        [patternId, JSON.stringify({ kind: "replace", find: "a", replace: "b" })]
      ),
    /pattern_wide_has_rule/,
    "a pattern-wide row must use the sentinel shape, not a real one"
  );
});
