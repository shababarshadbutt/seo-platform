import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseCsvUrlList } from "./csvUrlList.js";

function withTempCsv(contents: string, run: (filePath: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "csv-url-list-test-"));
  const filePath = path.join(dir, "urls.csv");
  writeFileSync(filePath, contents, "utf8");

  return run(filePath).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("parses a plain list of URLs, one per line", async () => {
  await withTempCsv(
    "https://example.com/a\nhttps://example.com/b\nhttps://example.com/c\n",
    async (filePath) => {
      const result = await parseCsvUrlList(filePath);

      assert.deepEqual(result.urls, [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c"
      ]);
      assert.equal(result.skippedCount, 0);
    }
  );
});

test("drops a header row without counting it as skipped", async () => {
  await withTempCsv("url\nhttps://example.com/a\nhttps://example.com/b\n", async (filePath) => {
    const result = await parseCsvUrlList(filePath);

    assert.deepEqual(result.urls, [
      "https://example.com/a",
      "https://example.com/b"
    ]);
    assert.equal(result.skippedCount, 0);
  });
});

test("skips blank lines silently but counts a later non-URL row as skipped", async () => {
  await withTempCsv(
    "https://example.com/a\n\nnot a url\nhttps://example.com/b\n",
    async (filePath) => {
      const result = await parseCsvUrlList(filePath);

      assert.deepEqual(result.urls, [
        "https://example.com/a",
        "https://example.com/b"
      ]);
      assert.equal(result.skippedCount, 1);
      assert.equal(result.skippedSample[0]?.value, "not a url");
    }
  );
});

test("tolerates a quoted CSV field and a UTF-8 BOM", async () => {
  await withTempCsv(
    '﻿"https://example.com/a?x=1,2"\nhttps://example.com/b\n',
    async (filePath) => {
      const result = await parseCsvUrlList(filePath);

      assert.deepEqual(result.urls, [
        "https://example.com/a?x=1,2",
        "https://example.com/b"
      ]);
    }
  );
});

test("rejects a non-http(s) scheme even when otherwise well-formed", async () => {
  await withTempCsv("https://example.com/b\nftp://example.com/a\n", async (filePath) => {
    const result = await parseCsvUrlList(filePath);

    assert.deepEqual(result.urls, ["https://example.com/b"]);
    assert.equal(result.skippedCount, 1);
  });
});

test("a bad FIRST row is silently treated as a header, not a skip", async () => {
  // Row 1 failing the URL check is indistinguishable from a header without
  // more context, so it is dropped without counting against skippedCount —
  // only rows AFTER the first can be reported as genuinely bad data.
  await withTempCsv("ftp://example.com/a\nhttps://example.com/b\n", async (filePath) => {
    const result = await parseCsvUrlList(filePath);

    assert.deepEqual(result.urls, ["https://example.com/b"]);
    assert.equal(result.skippedCount, 0);
  });
});
