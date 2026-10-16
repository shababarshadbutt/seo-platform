import assert from "node:assert/strict";
import { test } from "node:test";

import { writeBatchWithFaultIsolation } from "./batchWriteFaultIsolation.js";

type Row = { id: number };

test("a healthy batch is written in exactly one call", async () => {
  const batchCalls: Row[][] = [];
  const failed: Row[] = [];

  await writeBatchWithFaultIsolation<Row>(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    async (rows) => {
      batchCalls.push(rows);
    },
    async (row) => {
      failed.push(row);
    }
  );

  assert.equal(batchCalls.length, 1);
  assert.deepEqual(
    batchCalls[0].map((row) => row.id),
    [1, 2, 3]
  );
  assert.deepEqual(failed, []);
});

test("bisects a failing batch down to the single bad row, writing every good row", async () => {
  const rows: Row[] = Array.from({ length: 17 }, (_, index) => ({ id: index }));
  const BAD_ID = 13;
  const written = new Set<number>();
  const failed: Row[] = [];

  await writeBatchWithFaultIsolation<Row>(
    rows,
    async (batch) => {
      if (batch.some((row) => row.id === BAD_ID)) {
        throw new Error("value out of range");
      }
      for (const row of batch) {
        written.add(row.id);
      }
    },
    async (row) => {
      failed.push(row);
    }
  );

  assert.deepEqual(failed.map((row) => row.id), [BAD_ID]);
  assert.equal(written.size, rows.length - 1);
  assert.ok(!written.has(BAD_ID));
  for (const row of rows) {
    if (row.id !== BAD_ID) {
      assert.ok(written.has(row.id), `row ${row.id} should have been written`);
    }
  }
});

test("isolates multiple bad rows independently in the same batch", async () => {
  const rows: Row[] = Array.from({ length: 10 }, (_, index) => ({ id: index }));
  const BAD_IDS = new Set([2, 7]);
  const written = new Set<number>();
  const failed: Row[] = [];

  await writeBatchWithFaultIsolation<Row>(
    rows,
    async (batch) => {
      if (batch.some((row) => BAD_IDS.has(row.id))) {
        throw new Error("value out of range");
      }
      for (const row of batch) {
        written.add(row.id);
      }
    },
    async (row) => {
      failed.push(row);
    }
  );

  assert.deepEqual(
    failed.map((row) => row.id).sort(),
    [...BAD_IDS].sort()
  );
  assert.equal(written.size, rows.length - BAD_IDS.size);
});

test("a row that fails alone is reported via onRowFailed, not thrown", async () => {
  const failed: { row: Row; error: unknown }[] = [];

  await writeBatchWithFaultIsolation<Row>(
    [{ id: 1 }],
    async () => {
      throw new Error("boom");
    },
    async (row, error) => {
      failed.push({ row, error });
    }
  );

  assert.equal(failed.length, 1);
  assert.equal(failed[0].row.id, 1);
  assert.equal((failed[0].error as Error).message, "boom");
});

test("an empty batch never calls runBatch", async () => {
  let calls = 0;

  await writeBatchWithFaultIsolation<Row>(
    [],
    async () => {
      calls += 1;
    },
    async () => {}
  );

  assert.equal(calls, 0);
});
