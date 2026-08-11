import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dispatcherFor,
  rejectUnauthorized,
  tlsAwareDispatcher
} from "./tlsDispatcher.js";

// The transport variants exist so a per-host strategy can advertise HTTP/2 in the
// TLS ALPN extension for hosts that need it. What this file guards is the CACHING,
// because a per-call `new Agent()` looks correct in every functional test and
// silently discards the connection pool — a fresh TCP + TLS handshake per request,
// which on a 1.3M-URL sweep is strictly slower than the single-Agent code it
// replaced.
//
// Real h2 NEGOTIATION is not asserted here: it needs a TLS server with an ALPN
// certificate, and this suite has no cert fixture. It is verified against a live
// origin from the box (see verify-405-client-vs-curl.txt, test D).

test("dispatcherFor returns the SAME instance for repeated calls", () => {
  assert.strictEqual(dispatcherFor(false), dispatcherFor(false));
  assert.strictEqual(dispatcherFor(true), dispatcherFor(true));
  // undefined is the "profile didn't say" case and must land on the h1 default,
  // not build a third Agent.
  assert.strictEqual(dispatcherFor(undefined), dispatcherFor(false));
});

test("the two transports are DIFFERENT instances", () => {
  // allowH2 is a property of the Agent's TLS connector, so it cannot be chosen
  // per request on one shared Agent. If these are ever the same object, one of the
  // two transports is not being honoured.
  assert.notStrictEqual(dispatcherFor(true), dispatcherFor(false));
});

test("the default export is the HTTP/1.1 variant", () => {
  // Every existing caller (sitemap fetches, the cleaner, the global dispatcher)
  // keeps exactly the behaviour it had before h2 existed.
  assert.strictEqual(tlsAwareDispatcher, dispatcherFor(false));
});

test("TLS verification is ON unless explicitly disabled", () => {
  // Guards the v1.39 default: an unset NODE_TLS_REJECT_UNAUTHORIZED must mean
  // "verify", so a production box with no env var does not silently ship with
  // certificate checking off.
  assert.equal(rejectUnauthorized, process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0");
});
