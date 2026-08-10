import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acquireHostSlot,
  rateLimitHostKey,
  resetHostRateLimiter,
  verificationRateLimit,
  type RateLimiterClock
} from "./hostRateLimiter.js";

// The clock is injected so these run in microseconds instead of actually
// waiting seconds of wall time. A virtual clock also makes the assertions
// EXACT: with real timers "roughly 40ms apart" is all you can check, and a
// limiter that is roughly right is exactly the kind of thing that turns out to
// be issuing double the intended rate under load.
function virtualClock() {
  let current = 1_000_000;
  const waits: number[] = [];

  const clock: RateLimiterClock = {
    now: () => current,
    async sleep(ms: number) {
      waits.push(ms);
      current += ms;
    }
  };

  return {
    clock,
    waits,
    advance(ms: number) {
      current += ms;
    },
    get now() {
      return current;
    }
  };
}

test("paces sequential requests at exactly the configured rate", async () => {
  resetHostRateLimiter();

  const { clock, waits } = virtualClock();
  const options = { requestsPerSecond: 25, burst: 1 };

  for (let index = 0; index < 5; index += 1) {
    await acquireHostSlot("example.com", options, clock);
  }

  // 25/s is one every 40ms. The first goes immediately; the rest each wait a
  // full interval.
  assert.deepEqual(waits, [40, 40, 40, 40]);
});

test("burst credit lets an idle host absorb a short run immediately", async () => {
  resetHostRateLimiter();

  const { clock, waits } = virtualClock();
  const options = { requestsPerSecond: 25, burst: 10 };

  for (let index = 0; index < 10; index += 1) {
    await acquireHostSlot("example.com", options, clock);
  }

  // All ten fit inside the burst allowance, so nothing waits.
  assert.deepEqual(
    waits.filter((wait) => wait > 0),
    []
  );

  // The eleventh is past the credit and gets paced.
  await acquireHostSlot("example.com", options, clock);
  assert.equal(waits.at(-1), 40);
});

test("idle credit is capped — an hour of silence does not license a flood", async () => {
  resetHostRateLimiter();

  const state = virtualClock();
  const options = { requestsPerSecond: 25, burst: 10 };

  await acquireHostSlot("example.com", options, state.clock);
  // An hour passes with no traffic.
  state.advance(60 * 60 * 1000);

  const before = state.waits.length;

  for (let index = 0; index < 15; index += 1) {
    await acquireHostSlot("example.com", options, state.clock);
  }

  const paced = state.waits.slice(before).filter((wait) => wait > 0);

  // Exactly 5 of the 15 are paced: 10 burst slots, then the rate applies. If
  // credit accumulated with idle time, all 15 would have gone out at once.
  assert.equal(paced.length, 5);
});

test("concurrent callers cannot claim the same slot", async () => {
  resetHostRateLimiter();

  const state = virtualClock();
  const startedAt = state.now;
  const options = { requestsPerSecond: 25, burst: 1 };

  // Eight workers hitting the limiter at once — the real shape, since
  // verification runs at concurrency 8.
  await Promise.all(
    Array.from({ length: 8 }, () =>
      acquireHostSlot("example.com", options, state.clock)
    )
  );

  // The invariant is TOTAL ELAPSED, not the individual wait values: 8 requests
  // at 25/s must span exactly 7 intervals of 40ms. If two callers were handed
  // the same slot — the read-then-write race this claim shape prevents — the
  // span would come out short, which is the same thing as exceeding the rate.
  assert.equal(state.now - startedAt, 280);
  assert.equal(state.waits.filter((wait) => wait > 0).length, 7);
});

// NOT UNIT-TESTED HERE: the trailing-window backstop against an event-loop
// stall. This virtual clock advances only inside sleep(), so every concurrent
// caller's continuation runs after the whole batch has already been scheduled
// and every observation lands on the same final timestamp — it cannot represent
// "the loop was blocked and then many due slots fired at once". Faking it well
// enough would mean writing a real timer scheduler, and the result would prove
// the fake, not the limiter.
//
// That case is covered where it actually occurs: verifyRateLimit.integration
// .test.ts measures arrival times at a real socket, and it is what caught the
// spike in the first place — clean in isolation, 37 requests in a one-second
// window under full-suite load, against a 35 ceiling.

test("hosts have independent budgets", async () => {
  resetHostRateLimiter();

  const { clock, waits } = virtualClock();
  const options = { requestsPerSecond: 25, burst: 1 };

  await acquireHostSlot("a.example.com", options, clock);
  await acquireHostSlot("b.example.com", options, clock);
  await acquireHostSlot("c.example.com", options, clock);

  // Verifying three different clients in parallel must not serialise them —
  // the thing being protected is one origin server, not our outbound socket.
  assert.deepEqual(waits, []);
});

test("the same host is one budget regardless of caller", async () => {
  resetHostRateLimiter();

  const { clock, waits } = virtualClock();
  const options = { requestsPerSecond: 25, burst: 1 };

  // Stands in for a triage sample and a full verification running at once on
  // separate queues. They must share the budget, not get one each.
  await acquireHostSlot("shop.example.com", options, clock);
  await acquireHostSlot("shop.example.com", options, clock);

  assert.deepEqual(waits, [40]);
});

test("host key normalises case and ignores path", () => {
  assert.equal(
    rateLimitHostKey("https://Shop.Example.COM/a/b?c=d"),
    "shop.example.com"
  );
  // Port is part of the key: two origins on one machine are two servers.
  assert.equal(rateLimitHostKey("http://example.com:8080/x"), "example.com:8080");
  // An unparseable URL still gets paced rather than escaping the limiter.
  assert.equal(rateLimitHostKey("not a url"), "unparseable");
});

// The MECHANISM was already covered above (exact pacing, shared per-host
// budget, independent hosts). What actually caused the WAF block was the
// shipped NUMBER, so the default itself is pinned here.
//
// Job 0779ff01 ran 27+ minutes against one host at the old default of 50 req/s
// — ~15,000 requests per 5-minute window from one IP, roughly 7.5x a typical
// AWS WAF rate-based rule (2,000 / 5 min) — and earned a 405 +
// x-amzn-waf-action: captcha. The guard is the per-5-minute figure, not the
// per-second one, because that is the window WAF rules are written against.
test("the shipped per-host default stays under a typical WAF rate rule", () => {
  const { requestsPerSecond, burst } = verificationRateLimit();
  const perFiveMinutes = requestsPerSecond * 300;

  assert.ok(
    perFiveMinutes <= 2000,
    `default ${requestsPerSecond} req/s = ${perFiveMinutes} per 5 min, over the 2000 a WAF rate rule commonly allows`
  );

  // Burst is idle credit, not sustained rate, but it still sets the momentary
  // ceiling the limiter will release (ceil(rps) + burst inside one window) —
  // and a WAF reacts to the spike, not the average.
  assert.ok(
    Math.ceil(requestsPerSecond) + burst <= 20,
    `momentary ceiling ${Math.ceil(requestsPerSecond) + burst} is too spiky for one origin`
  );
});

// Lowering the per-host rate must NOT serialise unrelated clients: N hosts each
// get their own budget, so aggregate throughput across hosts still scales.
// ("hosts have independent budgets" proves independence for 2 requests; this
// proves the aggregate at the shipped default over a sustained run.)
test("the per-host cap does not throttle the aggregate across many hosts", async () => {
  resetHostRateLimiter();

  const { clock, waits } = virtualClock();
  const { requestsPerSecond } = verificationRateLimit();
  const options = { requestsPerSecond, burst: 1 };
  const hosts = Array.from({ length: 12 }, (_, i) => `client-${i}.example.com`);

  // One request to each of 12 different hosts: none should wait, because each
  // host's schedule starts idle. Aggregate = 12 requests with zero pacing.
  for (const host of hosts) {
    await acquireHostSlot(host, options, clock);
  }

  assert.deepEqual(waits, [], "different hosts must not pace each other");

  // A SECOND request to one of them does wait — the per-host cap still binds.
  await acquireHostSlot(hosts[0], options, clock);

  assert.deepEqual(waits, [1000 / requestsPerSecond]);
});
