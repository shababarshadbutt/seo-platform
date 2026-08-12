import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Its own file and its own process, because config.ts reads process.env at module load —
// the same reason hostStrategyPinnedUa.test.ts is separate. tlsDispatcher.test.ts
// deliberately runs with private routing OFF, and its assertions about the public
// dispatchers must keep passing in that state.
const MAP_DIR = mkdtempSync(path.join(tmpdir(), "private-dispatcher-"));
const MAP_FILE = path.join(MAP_DIR, "private-hosts.conf");

// Includes the IPv6 loopback line every real /etc/hosts carries, because the map is
// allowed to BE an /etc/hosts derived on the box.
writeFileSync(
  MAP_FILE,
  ["10.0.61.203 www.aeropartshub.com", "::1 ip6-loopback"].join("\n"),
  "utf8"
);

process.env.PRIVATE_ROUTE_ENABLED = "true";
process.env.PRIVATE_HOST_MAP_FILE = MAP_FILE;

const {
  dispatcherFor,
  privateAwareLookup,
  privateDispatcherFor,
  tlsAwareDispatcher
} = await import("./tlsDispatcher.js");

// ---- The DNS override -------------------------------------------------------
//
// BOTH CALLBACK SHAPES MATTER. net.connect calls `lookup` with options.all unset
// (expecting cb(null, address, family)) or true (expecting cb(null, [{address, family}])).
// Answering the wrong shape does not degrade gracefully — it breaks the connect for
// every request on this dispatcher, and there is no way to reach that from an Agent
// without a live socket.

test("a mapped hostname resolves to its private IP — options.all unset", async () => {
  const answer = await new Promise<unknown[]>((resolve) => {
    privateAwareLookup("www.aeropartshub.com", {}, (...args) => resolve(args));
  });

  assert.deepEqual(answer, [null, "10.0.61.203", 4]);
});

test("a mapped hostname resolves to its private IP — options.all true", async () => {
  const answer = await new Promise<unknown[]>((resolve) => {
    privateAwareLookup("www.aeropartshub.com", { all: true }, (...args) =>
      resolve(args)
    );
  });

  // IPv4 always: the map holds no IPv6 addresses.
  assert.deepEqual(answer, [null, [{ address: "10.0.61.203", family: 4 }]]);
});

test("the family comes from the address, not assumed to be 4", async () => {
  const answer = await new Promise<unknown[]>((resolve) => {
    privateAwareLookup("ip6-loopback", { all: true }, (...args) => resolve(args));
  });

  // Answering a v6 address with family 4 fails the connect in a way that looks like a
  // dead route rather than a bad answer.
  assert.deepEqual(answer, [null, [{ address: "::1", family: 6 }]]);
});

test("the www fallback applies to the lookup too", async () => {
  const answer = await new Promise<unknown[]>((resolve) => {
    // Mapped as www.aeropartshub.com; asked for the bare form.
    privateAwareLookup("aeropartshub.com", {}, (...args) => resolve(args));
  });

  assert.deepEqual(answer, [null, "10.0.61.203", 4]);
});

// THE SCOPE GUARANTEE, behaviourally: an unmapped host must reach the real resolver, so
// leaving this override installed cannot change where anything else connects.
test("an unmapped hostname delegates to the real DNS resolver", async () => {
  const answer = await new Promise<{ error: unknown; address: unknown }>(
    (resolve) => {
      privateAwareLookup("localhost", {}, (error, address) =>
        resolve({ error, address })
      );
    }
  );

  // localhost resolves through node's resolver (127.0.0.1 or ::1 depending on the
  // host's configuration) — the point is that it answered from DNS, not from the map.
  assert.equal(answer.error, null);
  assert.notEqual(answer.address, "10.0.61.203");
  assert.equal(typeof answer.address, "string");
});

test("a hostname that resolves nowhere still reports a DNS error, not a private IP", async () => {
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    privateAwareLookup(
      "this-host-does-not-exist.invalid",
      {},
      (err) => resolve(err)
    );
  });

  // Delegation passes the resolver's own failure through untouched, so a genuine DNS
  // problem still looks like one.
  assert.notEqual(error, null);
});

// ---- The dispatcher pairs ---------------------------------------------------

test("all four dispatchers are cached — the same instance every call", () => {
  // An accidental `new Agent()` per call would look correct and quietly throw away
  // connection pooling, TLS session reuse and h2 session reuse.
  assert.equal(dispatcherFor(false), dispatcherFor(false));
  assert.equal(dispatcherFor(true), dispatcherFor(true));
  assert.equal(privateDispatcherFor(false), privateDispatcherFor(false));
  assert.equal(privateDispatcherFor(true), privateDispatcherFor(true));
});

// THE SCOPE GUARANTEE, structurally. The public h1 agent is also the GLOBAL dispatcher,
// which serves remote sitemap fetches and the Cleaner — traffic deliberately excluded
// from private routing. If the two pairs were ever the same object, that exclusion would
// silently stop being true.
test("the private pair is SEPARATE from the public pair and from the global dispatcher", () => {
  assert.notEqual(privateDispatcherFor(false), dispatcherFor(false));
  assert.notEqual(privateDispatcherFor(true), dispatcherFor(true));
  assert.notEqual(privateDispatcherFor(false), tlsAwareDispatcher);
  assert.notEqual(privateDispatcherFor(true), tlsAwareDispatcher);
  // And the public default is still exactly what it was before this feature existed.
  assert.equal(dispatcherFor(false), tlsAwareDispatcher);
  assert.equal(dispatcherFor(undefined), tlsAwareDispatcher);
});

test("h1 and h2 stay distinct within each pair", () => {
  // allowH2 is a property of the Agent's connector, so it cannot be chosen per
  // request — two variants is the only way to offer both.
  assert.notEqual(dispatcherFor(true), dispatcherFor(false));
  assert.notEqual(privateDispatcherFor(true), privateDispatcherFor(false));
});
