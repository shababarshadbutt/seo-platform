# A budget refusal raised inside a readline/sax handler kills the API

**Status:** open, NOT fixed. Found while writing the bucket-release regression test
(`a sharded run that THROWS mid-bucket still releases that bucket's charge`).

**Severity:** high — it is a process-death path, and it fires precisely when the dedup
budget is doing its job. It defeats the purpose of `dedupBudget.ts`.

**Not merge-introduced.** It arrived with the process-wide ledger in `2598f787` and affects
BOTH Pass 2 engines. `81763364` (sharding) had no ledger and so nothing that threw from
inside a handler. The merge inherited it; it did not cause it.

## What happens

`syncDedupLedger` → `chargeDedupBytes` throws `CleanerCapacityError` on the batch boundary,
every `LEDGER_SYNC_INTERVAL` (4096) entries. On both engines that call sits inside a
**synchronous event handler**:

| Engine | Call site | Handler |
| --- | --- | --- |
| Sharded | `writeCandidatesSharded` Phase A2 (`cleaner.ts` bucket loop) | `readSpillLines`' `rl.on("line")` |
| Single-Map, parallel | `considerLoc` via `writeCandidatesParallel` | `readProvisionalPairs`' `rl.on("line")` |
| Single-Map, sequential | `considerLoc` via `writeCandidateFile` | `streamUrlsetLocs`' sax callback |

A throw inside `rl.on("line")` (or a sax callback) does **not** reject the promise those
helpers return. It propagates out through `EventEmitter.emit` → the read stream's `data`
handler → the I/O callback, and becomes an **uncaughtException**. So:

- `cleanSitemaps`' `try/finally` never runs — the route's `catch (error instanceof
  CleanerCapacityError)` never sees it, the user gets no "too large" message, and the
  bucket's ledger charge leaks (the `finally` added for that is bypassed entirely).
- `server.ts` exits 1, Docker restarts the API, and **every concurrent Cleaner run dies** —
  reported to users as the misleading "the server restarted while this run was in
  progress". This is the exact outage `dedupBudget.ts` was written to prevent.

## Proof

Probe driving `cleanSitemaps` with a budget that admits sync #1 (4096 entries) and refuses
sync #2 (8192) — so the refusal lands mid-handler rather than on a bucket-end tail sync:

```
PROBE2 sharded:    caught=NOTHING (escaped as uncaughtException)
PROBE2 single-map: caught=NOTHING (escaped as uncaughtException)
```

Both engines. The caller's `try/catch` around `await cleanSitemaps(...)` never fires.

## Why the existing tests miss it

- `dedupBudget.test.ts` calls `chargeDedupBytes` directly, so propagation is never exercised.
- The bucket-release regression test deliberately sizes buckets to between one and two
  syncs' worth, putting the refusal on the **tail** sync — which is outside the handler and
  therefore catchable. That isolation is intentional (it keeps that test failing for one
  reason only) and is asserted, not incidental.

## Fix sketch

Make handler throws reject the promise instead of escaping, in all three helpers:

```ts
let failed = false;
rl.on("line", (line) => {
  if (failed) return;
  try {
    /* existing body */
  } catch (error) {
    failed = true;
    rl.close();
    input.destroy();
    reject(error);
  }
});
```

`streamUrlsetLocs` needs the equivalent around its sax callback. Then add the mid-handler
case (budget refused on sync #2) as a test on **both** engines, asserting the caller
receives a `CleanerCapacityError` and the ledger returns to its pre-run state.

Worth checking at the same time whether any other synchronous handler in the Cleaner can
throw — the `openDuplicateReport` sink's `writeRow` is called from the same callbacks.
