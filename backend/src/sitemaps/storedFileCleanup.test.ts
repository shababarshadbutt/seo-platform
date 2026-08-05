import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { removeStoredFiles } from "./storedFileCleanup.js";

// Regression tests for the transform-undo storage leak. The broken code passed
// stored FILENAMES to unlink() directly, so every removal resolved against the
// process CWD, failed ENOENT, and left the post-transform copies on disk forever.
//
// These assert against the REAL FILESYSTEM — files are written to a temp dir and
// existsSync is checked after the call. A test that only asserted "did not throw"
// would have passed against the broken code, because the broken code swallowed
// every ENOENT and returned normally. That is exactly how the bug survived.

let uploadDir: string;

beforeEach(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "stored-cleanup-"));
});

afterEach(async () => {
  await rm(uploadDir, { recursive: true, force: true });
});

async function seed(filename: string, body = "<urlset/>") {
  const full = path.join(uploadDir, filename);

  await writeFile(full, body, "utf8");
  // Guard the guard: if the fixture didn't land, the deletion assertion below
  // would pass for the wrong reason.
  assert.equal(existsSync(full), true, `fixture ${filename} was not created`);

  return full;
}

describe("removeStoredFiles", () => {
  it("DELETES the file named by a bare stored filename", async () => {
    // The exact shape of a pattern_transforms.new_file_paths entry.
    const filename =
      "d94fa31c-d10e-45c8-b42c-4cbb24bf585e-transformed-bcbf5858-sitemap-0000.xml";
    const full = await seed(filename);

    const result = await removeStoredFiles(uploadDir, [filename]);

    assert.equal(
      existsSync(full),
      false,
      "the superseded copy is still on disk — the leak is back"
    );
    assert.deepEqual(result.removed, [filename]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.missing, []);
  });

  it("removes every entry of a multi-file undo", async () => {
    const names = Array.from(
      { length: 5 },
      (_, index) => `sess-transformed-abc${index}-sitemap-${index}.xml`
    );
    const paths = [];

    for (const name of names) {
      paths.push(await seed(name));
    }

    const result = await removeStoredFiles(uploadDir, names);

    for (const full of paths) {
      assert.equal(existsSync(full), false, `${full} survived`);
    }

    assert.equal(result.removed.length, 5);
    assert.equal(result.failed.length, 0);
  });

  it("leaves files it was not asked to remove completely alone", async () => {
    // The pre-transform ORIGINAL must survive — undo repoints sitemap_files at it,
    // so deleting it would destroy the restored sitemap.
    const doomed = await seed("sess-transformed-dead-sitemap-1.xml", "<new/>");
    const survivor = await seed("sess-sitemap-1.xml", "<original/>");

    await removeStoredFiles(uploadDir, [
      "sess-transformed-dead-sitemap-1.xml"
    ]);

    assert.equal(existsSync(doomed), false);
    assert.equal(existsSync(survivor), true, "the restored original was deleted");
    assert.equal(
      await readFile(survivor, "utf8"),
      "<original/>",
      "the surviving original's contents changed"
    );
  });

  it("reports an already-absent file as missing, not failed", async () => {
    // Idempotent: a re-run, or a copy already reaped by upload cleanup, is fine.
    const result = await removeStoredFiles(uploadDir, ["never-existed.xml"]);

    assert.deepEqual(result.missing, ["never-existed.xml"]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.removed, []);
  });

  it("keeps going after one entry fails", async () => {
    const good = await seed("sess-transformed-ok-sitemap.xml");

    const result = await removeStoredFiles(uploadDir, [
      "missing-one.xml",
      "sess-transformed-ok-sitemap.xml"
    ]);

    assert.equal(
      existsSync(good),
      false,
      "a missing earlier entry stopped later removals"
    );
    assert.deepEqual(result.removed, ["sess-transformed-ok-sitemap.xml"]);
  });

  it("refuses to escape the uploads directory", async () => {
    // Nothing should ever put a traversal in that column, but this function
    // deletes what it is handed, so it must not be the thing that trusts it.
    const outside = path.join(uploadDir, "..", "escapee.xml");

    await writeFile(outside, "keep me", "utf8");

    try {
      const result = await removeStoredFiles(uploadDir, ["../escapee.xml"]);

      assert.equal(existsSync(outside), true, "a traversal deleted a file");
      assert.deepEqual(result.failed, ["../escapee.xml"]);
      assert.deepEqual(result.removed, []);
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("refuses an absolute path", async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), "stored-cleanup-other-"));
    const victim = path.join(elsewhere, "victim.xml");

    await writeFile(victim, "keep me", "utf8");

    try {
      const result = await removeStoredFiles(uploadDir, [victim]);

      assert.equal(existsSync(victim), true, "an absolute path was deleted");
      assert.deepEqual(result.failed, [victim]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("surfaces a real failure as failed rather than swallowing it", async () => {
    // A directory where a file is expected: unlink fails with EPERM/EISDIR, which
    // is neither "removed" nor "already gone" and must be reported.
    const asDirectory = path.join(uploadDir, "sess-transformed-dir.xml");

    await mkdir(asDirectory);

    const warnings: string[] = [];
    const result = await removeStoredFiles(
      uploadDir,
      ["sess-transformed-dir.xml"],
      { warn: (_details, message) => warnings.push(message) }
    );

    assert.deepEqual(result.failed, ["sess-transformed-dir.xml"]);
    assert.deepEqual(result.removed, []);
    assert.equal(warnings.length, 1);
  });

  it("does nothing, successfully, for an empty list", async () => {
    const result = await removeStoredFiles(uploadDir, []);

    assert.deepEqual(result, { removed: [], failed: [], missing: [] });
  });
});
