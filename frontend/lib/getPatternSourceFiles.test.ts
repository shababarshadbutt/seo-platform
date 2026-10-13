import assert from "node:assert/strict";
import { test } from "node:test";

import { getPatternSourceFiles } from "./api";

// getPatternSourceFiles retries its own AbortError rather than surfacing it
// immediately — see the comment above it in api.ts for why that is safe: the
// backend scan it calls is designed to outlive the client's timeout and lands
// in a shared cache under the same key, so a retry is a cheap re-read rather
// than a second scan. These tests fake `fetch` directly (not the backend)
// because the whole point is the CLIENT-side retry loop, independent of what
// the server actually does.

function abortError(): Error {
  const error = new Error("The operation was aborted");

  error.name = "AbortError";

  return error;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("retries once on AbortError and returns the eventual success", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;

    if (calls === 1) {
      throw abortError();
    }

    return jsonResponse({
      source_files: [{ source_file: "a.xml", occurrences: 5 }],
      cached: true
    });
  }) as typeof fetch;

  try {
    const result = await getPatternSourceFiles("session-1", "pattern-1");

    assert.equal(calls, 2);
    assert.equal(result.cached, true);
    assert.deepEqual(result.files, [{ source_file: "a.xml", occurrences: 5 }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gives up and throws after exhausting retries, all still AbortError", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    throw abortError();
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => getPatternSourceFiles("session-1", "pattern-1"),
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    // One initial attempt + two retries, matching SOURCE_FILES_MAX_ATTEMPTS.
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a non-abort failure is not retried", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;

    return new Response(JSON.stringify({ message: "pattern not found" }), {
      status: 404,
      headers: { "content-type": "application/json" }
    });
  }) as typeof fetch;

  try {
    await assert.rejects(() => getPatternSourceFiles("session-1", "pattern-1"));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
