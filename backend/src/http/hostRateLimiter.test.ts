import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acquireHostSlot,
  rateLimitHostKey,
  resetHostRateLimiter,
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
