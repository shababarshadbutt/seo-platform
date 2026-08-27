import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import pg from "pg";

// A RE-VERIFICATION MUST NOT UNDO WHAT A HUMAN SAID (v1.87).
//
// THE TWO BUGS THIS PINS, both live before this release. verifyUrlsJob's upsert
// into pattern_shape_rules set rule/sample_size/population/agreed and NOT source.
// So re-verifying a pattern that carried an operator's answer:
//
//   1) SILENTLY REPLACED IT with measured values while the row still read
//      source = 'operator' — the loop v1.86 exists to break, reopened from the
//      other end. The operator's rule vanished and the group came back looking as
//      though nobody had ever answered it.
//
//   2) COULD FAIL THE WHOLE VERIFICATION JOB. An unagreed stratum writes
//      rule = NULL, agreed = false (migration 051), and migration 053 constrains
//      "source <> 'operator' OR (rule IS NOT NULL AND agreed = true)". That write
//      violated the CHECK and threw — a crash reachable by re-checking any pattern
//      somebody had answered by hand, and the reason this is a test and not a
//      note: it is a real 500 on a long job, not a cosmetic provenance slip.
//
// Run against a real database and against the REAL statement (upsertSampledShapeRule
// is what the job's loop calls) rather than a copy of the SQL, so the assertion
// cannot pass while the job does something else.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://sitemap:sitemap@localhost:5434/sitemap_health";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const uploadDir = mkdtempSync(path.join(os.tmpdir(), "shaperule-itest-"));

process.env.UPLOAD_DIR = uploadDir;

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

test("a probe never overwrites an answer a human gave", async (t) => {
  if (!(await postgresReachable())) {
    rmSync(uploadDir, { recursive: true, force: true });
    t.skip("postgres not reachable — skipping");
    return;
  }

  const { pool, closePool } = await import("../db/pool.js");
  const { runMigrations } = await import("../db/migrate.js");
  const { upsertSampledShapeRule } = await import("./verifyUrlsJob.js");

  const sessionId = randomUUID();
  const patternId = randomUUID();

  t.after(async () => {
    await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    await closePool();
    rmSync(uploadDir, { recursive: true, force: true });
  });

  await runMigrations(silentLogger);

  await pool.query(
    "INSERT INTO sessions (id, name, base_url, sample_size, concurrency, status) VALUES ($1, 'shape rule provenance', 'https://example.com', 5, 2, 'COMPLETED')",
    [sessionId]
  );
  await pool.query(
    "INSERT INTO patterns (id, session_id, template, total_urls) VALUES ($1, $2, '/nsn/{param}/', 100)",
    [patternId, sessionId]
  );

  const operatorShape = "/a/a-9999/";
  const markedShape = "/b/b-99/";
  const sampledShape = "/c/c-9/";

  // An operator's RULE, exactly as the Review unfixed groups dialog writes it.
  await pool.query(
    `
      INSERT INTO pattern_shape_rules
        (pattern_id, shape, rule, sample_size, population, agreed, source,
         authored_at)
      VALUES ($1, $2, $3::jsonb, 0, 0, true, 'operator', now())
    `,
    [
      patternId,
      operatorShape,
      JSON.stringify({ kind: "replace", find: "-", replace: "/" })
    ]
  );

  // An operator's "these are already correct — leave them" mark (v1.87).
  await pool.query(
    `
      INSERT INTO pattern_shape_rules
        (pattern_id, shape, rule, sample_size, population, agreed, source,
         authored_at)
      VALUES ($1, $2, NULL, 0, 0, false, 'no_change', now())
    `,
    [patternId, markedShape]
  );

  // And an ordinary measured row, which a probe IS allowed to replace.
  await upsertSampledShapeRule(patternId, {
    shape: sampledShape,
    rule: { kind: "replace", find: "x", replace: "y" },
    sampleSize: 10,
    population: 100,
    agreed: true
  });

  // THE CRASH. An unagreed verdict against the operator's shape writes
  // rule = NULL / agreed = false, which migration 053 forbids on a source =
  // 'operator' row. Before the fix this threw and took the whole job with it.
  await assert.doesNotReject(
    () =>
      upsertSampledShapeRule(patternId, {
        shape: operatorShape,
        rule: null,
        sampleSize: 8,
        population: 400,
        agreed: false
      }),
    "an unagreed verdict over an operator row must not throw"
  );

  // …and the same against the mark, which has the same shape of conflict.
  await assert.doesNotReject(() =>
    upsertSampledShapeRule(patternId, {
      shape: markedShape,
      rule: { kind: "replace", find: "q", replace: "z" },
      sampleSize: 5,
      population: 30,
      agreed: true
    })
  );

  const rows = await pool.query<{
    shape: string;
    source: string;
    rule: { find?: string } | null;
    agreed: boolean;
    sample_size: number;
  }>(
    `
      SELECT shape, source, rule, agreed, sample_size
      FROM pattern_shape_rules
      WHERE pattern_id = $1
      ORDER BY shape
    `,
    [patternId]
  );
  const byShape = new Map(rows.rows.map((row) => [row.shape, row]));

  // THE OPERATOR'S RULE SURVIVED, untouched — not merely re-labelled.
  const operatorRow = byShape.get(operatorShape);

  assert.equal(operatorRow?.source, "operator");
  assert.equal(operatorRow?.agreed, true);
  assert.equal(operatorRow?.rule?.find, "-", "the operator's rule is unchanged");
  assert.equal(
    Number(operatorRow?.sample_size),
    0,
    "and it was not given a sample size it never had"
  );

  // THE MARK SURVIVED. Without this, a re-verification would quietly turn "these
  // are already correct" back into an outstanding group carrying a probe's rule.
  const markedRow = byShape.get(markedShape);

  assert.equal(markedRow?.source, "no_change");
  assert.equal(markedRow?.rule, null);
  assert.equal(markedRow?.agreed, false);

  // AND A MEASURED ROW IS STILL REPLACEABLE. The clause must not freeze the
  // table — re-probing is how a sampled verdict gets corrected, and breaking that
  // would trade one bug for another.
  await upsertSampledShapeRule(patternId, {
    shape: sampledShape,
    rule: { kind: "replace", find: "updated", replace: "z" },
    sampleSize: 20,
    population: 200,
    agreed: true
  });

  const resampled = await pool.query<{
    rule: { find?: string } | null;
    sample_size: number;
  }>(
    "SELECT rule, sample_size FROM pattern_shape_rules WHERE pattern_id = $1 AND shape = $2",
    [patternId, sampledShape]
  );

  assert.equal(resampled.rows[0].rule?.find, "updated");
  assert.equal(Number(resampled.rows[0].sample_size), 20);
});
