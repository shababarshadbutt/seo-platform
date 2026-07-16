import assert from "node:assert/strict";
import { test } from "node:test";

import { fsErrorResponse } from "./fsErrors.js";

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test("ENOSPC maps to 507 with a disk-full message", () => {
  const result = fsErrorResponse(errnoError("ENOSPC"));
  assert.ok(result);
  assert.equal(result?.status, 507);
  assert.match(result?.body.message ?? "", /storage is full/i);
});

test("ENOENT maps to 404 with a file-not-found message", () => {
  const result = fsErrorResponse(errnoError("ENOENT"));
  assert.ok(result);
  assert.equal(result?.status, 404);
  assert.match(result?.body.message ?? "", /not found/i);
});

test("unrelated errno codes are not mapped", () => {
  assert.equal(fsErrorResponse(errnoError("EACCES")), null);
});

test("non-errno values are not mapped", () => {
  assert.equal(fsErrorResponse(new Error("plain")), null);
  assert.equal(fsErrorResponse(null), null);
  assert.equal(fsErrorResponse("boom"), null);
});
