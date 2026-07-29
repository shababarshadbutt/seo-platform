import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { config } from "../config.js";
import {
  allSessionUploadUsage,
  sessionUploadUsage
} from "./uploadStorage.js";

// Real files on a real temp directory — the accounting these functions do is
// filesystem behaviour, and the number they produce is what the cleanup dialog
// promises to free, so a mocked fs would test nothing worth testing.
//
// deleteSessionUploads is deliberately NOT covered here: it writes to the
// sessions table, so it needs a database. It is exercised end-to-end against a
// live stack instead.

const SESSION_A = "9215a7e0-c0cf-45d0-9742-84e0de2fe1b2";
const SESSION_B = "7a335602-b04d-499d-9aba-12bf282efe83";

let uploadDir: string;
let savedUploadDir: string;

before(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "upload-storage-test-"));
  savedUploadDir = config.uploadDir;
  config.uploadDir = uploadDir;

  // Two sessions' files side by side, plus files that must be ignored.
  await writeFile(
    path.join(uploadDir, `${SESSION_A}-current-manufacturers.xml`),
    "a".repeat(100)
  );
  await writeFile(
    path.join(uploadDir, `${SESSION_A}-fixed-9f2ab31c-current-products-1.xml`),
    "b".repeat(250)
  );
  await writeFile(
    path.join(uploadDir, `${SESSION_B}-current-manufacturers.xml`),
    "c".repeat(40)
  );
  // Not a session file: no UUID prefix. Must never be counted or deleted —
  // grouping is a prefix read, so this is the case that would break it.
  await writeFile(path.join(uploadDir, "sitemap-index.xml"), "d".repeat(999));
  // UUID-shaped but not followed by the separator.
  await writeFile(path.join(uploadDir, `${SESSION_A}.xml`), "e".repeat(999));
});

after(async () => {
  config.uploadDir = savedUploadDir;
  await rm(uploadDir, { recursive: true, force: true });
});

test("sessionUploadUsage sums only the requested session's files", async () => {
  const usageA = await sessionUploadUsage(SESSION_A);

  assert.equal(usageA.file_count, 2, "must not pick up session B or the strays");
  assert.equal(usageA.bytes, 350);

  const usageB = await sessionUploadUsage(SESSION_B);

  assert.equal(usageB.file_count, 1);
  assert.equal(usageB.bytes, 40);
});

test("a session with nothing on disk reports zero, not an error", async () => {
  const usage = await sessionUploadUsage(
    "00000000-0000-4000-8000-000000000000"
  );

  assert.deepEqual(usage, { bytes: 0, file_count: 0 });
});

test("allSessionUploadUsage groups by session and ignores non-session files", async () => {
  const usage = await allSessionUploadUsage();

  assert.deepEqual(usage.get(SESSION_A), { bytes: 350, file_count: 2 });
  assert.deepEqual(usage.get(SESSION_B), { bytes: 40, file_count: 1 });
  // The 999-byte strays belong to no session and must not inflate any total.
  assert.equal(usage.size, 2, `unexpected groups: ${[...usage.keys()].join()}`);

  const total = [...usage.values()].reduce((sum, item) => sum + item.bytes, 0);

  assert.equal(total, 390);
});

test("a missing upload directory reports no usage rather than throwing", async () => {
  const saved = config.uploadDir;

  config.uploadDir = path.join(uploadDir, "does-not-exist");

  try {
    assert.equal((await allSessionUploadUsage()).size, 0);
    assert.deepEqual(await sessionUploadUsage(SESSION_A), {
      bytes: 0,
      file_count: 0
    });
  } finally {
    config.uploadDir = saved;
  }
});
