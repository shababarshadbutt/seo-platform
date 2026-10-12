import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_URLS_PER_FILE,
  MAX_URLS_PER_FILE,
  MIN_URLS_PER_FILE,
  URLS_PER_FILE_STEP,
  validateMaxUrlsPerFile
} from "./categorizerMaxUrlsPerFile.js";

test("validateMaxUrlsPerFile accepts the default and every valid step", () => {
  assert.deepEqual(validateMaxUrlsPerFile(DEFAULT_URLS_PER_FILE), {
    ok: true,
    value: DEFAULT_URLS_PER_FILE
  });

  for (
    let value = MIN_URLS_PER_FILE;
    value <= MAX_URLS_PER_FILE;
    value += URLS_PER_FILE_STEP
  ) {
    assert.deepEqual(validateMaxUrlsPerFile(value), { ok: true, value });
  }
});

test("validateMaxUrlsPerFile rejects values outside the range", () => {
  assert.equal(validateMaxUrlsPerFile(MIN_URLS_PER_FILE - URLS_PER_FILE_STEP).ok, false);
  assert.equal(validateMaxUrlsPerFile(MAX_URLS_PER_FILE + URLS_PER_FILE_STEP).ok, false);
  assert.equal(validateMaxUrlsPerFile(0).ok, false);
});

test("validateMaxUrlsPerFile rejects values that aren't a multiple of the step", () => {
  assert.equal(validateMaxUrlsPerFile(12_000).ok, false);
});

test("validateMaxUrlsPerFile rejects non-integer input", () => {
  assert.equal(validateMaxUrlsPerFile("45000").ok, false);
  assert.equal(validateMaxUrlsPerFile(null).ok, false);
});
