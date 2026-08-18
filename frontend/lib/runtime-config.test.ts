import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  BACKEND_URL_MISSING,
  readBackendUrl,
  readRuntimeConfig
} from "./runtime-config";

// THE REGRESSION THIS GUARDS.
//
// v1.63-Live served a frontend that had received none of its runtime env: the
// Cleaner's "From SFTP" tab vanished, the SEO Desk navbar link vanished, and
// every backend call answered 502 — while /api/health still reported ok:true and
// the navbar still showed a version, so the deploy looked fine. The cause was the
// dev docker-compose.yml, which passes only the NEXT_PUBLIC_* variables this code
// no longer reads. These tests pin the parsing; the compose files supply it.

test("an empty environment is the deployed failure, and it fails CLOSED", () => {
  const config = readRuntimeConfig({});

  assert.deepEqual(config, {
    seoDeskUrl: "",
    appVersion: "",
    awsPublishEnabled: false
  });
  assert.equal(readBackendUrl({}).ok, false);
});

test("a fully configured environment turns everything on", () => {
  assert.deepEqual(
    readRuntimeConfig({
      SEO_DESK_URL: "http://example.com:4000",
      APP_VERSION: "v1.63-Live",
      AWS_PUBLISH_ENABLED: "true"
    }),
    {
      seoDeskUrl: "http://example.com:4000",
      appVersion: "v1.63-Live",
      awsPublishEnabled: true
    }
  );
});

// Mirrors the backend's rule (backend/src/publish/s3Publish.test.ts) on purpose:
// the UI hiding the controls and the endpoints refusing them must agree exactly,
// or a user sees a button that answers 503.
test("only the exact string 'true' enables the AWS paths", () => {
  for (const value of ["TRUE", "True", "1", "yes", "on", " true", "true ", ""]) {
    assert.equal(
      readRuntimeConfig({ AWS_PUBLISH_ENABLED: value }).awsPublishEnabled,
      false,
      `${JSON.stringify(value)} must not enable the AWS paths`
    );
  }

  assert.equal(
    readRuntimeConfig({ AWS_PUBLISH_ENABLED: "true" }).awsPublishEnabled,
    true
  );
});

// The runtime var must win, or an image re-run after a version bump in .env keeps
// reporting the version frozen into it at build time — the drift the pill exists
// to expose.
test("APP_VERSION beats the build-time NEXT_PUBLIC_APP_VERSION", () => {
  assert.equal(
    readRuntimeConfig({
      APP_VERSION: "v1.64-Live",
      NEXT_PUBLIC_APP_VERSION: "v1.63-Live"
    }).appVersion,
    "v1.64-Live"
  );
});

test("the build-time version is still the fallback when the runtime one is absent", () => {
  assert.equal(
    readRuntimeConfig({ NEXT_PUBLIC_APP_VERSION: "v1.63-Live" }).appVersion,
    "v1.63-Live"
  );
});

test("a backend URL is accepted and its trailing slashes stripped", () => {
  assert.deepEqual(readBackendUrl({ BACKEND_URL: "http://backend:3001" }), {
    ok: true,
    url: "http://backend:3001"
  });
  assert.deepEqual(readBackendUrl({ BACKEND_URL: "http://backend:3001///" }), {
    ok: true,
    url: "http://backend:3001"
  });
  // Surrounding whitespace is a copy-paste artefact from an .env file, not a URL.
  assert.deepEqual(readBackendUrl({ BACKEND_URL: "  http://backend:3001  " }), {
    ok: true,
    url: "http://backend:3001"
  });
});

// A variable that is PRESENT but empty is the compose-file case: `BACKEND_URL:`
// with nothing after it, or ${BACKEND_URL} expanding to nothing. It must be
// treated as absent, not as a valid base that proxies to "/api/...".
test("a blank or whitespace-only backend URL counts as unset", () => {
  for (const value of ["", "   ", "\t\n"]) {
    const result = readBackendUrl({ BACKEND_URL: value });

    assert.equal(result.ok, false, `${JSON.stringify(value)} must not be a URL`);
    assert.equal(result.ok === false && result.message, BACKEND_URL_MISSING);
  }
});

// The proxy's 502 body, the health endpoint's failure reason and this assertion
// are the same sentence. It is what let the live outage be diagnosed over HTTP.
test("the missing-backend message names the variable and the compose value", () => {
  assert.match(BACKEND_URL_MISSING, /BACKEND_URL is not set/);
  assert.match(BACKEND_URL_MISSING, /http:\/\/backend:3001/);
});
