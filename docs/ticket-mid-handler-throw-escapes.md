# A budget refusal raised inside a readline/sax handler kills the API

**Status: RESOLVED.** Fixed and covered by tests. Kept as the written record of the
failure modes, because two of them were invisible on the straight-line path.

**Was:** high — a process-death path on two engines and a silent-data-loss path on the
third, all firing precisely when the dedup budget did its job.

**Not merge-introduced.** It arrived with the process-wide ledger in `2598f787` and affected
BOTH Pass 2 engines. `81763364` (sharding) had no ledger and so nothing that threw from
inside a handler. Merge `abf1a0c3` inherited it; it did not cause it.

## What happened

`syncDedupLedger` → `chargeDedupBytes` throws `CleanerCapacityError` on the batch boundary,
every `LEDGER_SYNC_INTERVAL` (4096) entries. On all three engines that call sits inside a
**synchronous event handler** — and the outcome differed by handler, which is why the
straight-line path looked fine:

| Engine | Handler | Behaviour BEFORE fix |
| --- | --- | --- |
| Sharded (`writeCandidatesSharded` Phase A2) | `readSpillLines`' `rl.on("line")` | throw escapes via `EventEmitter.emit` → **uncaughtException** → API exits, all concurrent runs die |
| Single-Map parallel (`writeCandidatesParallel`) | `readProvisionalPairs`' `rl.on("line")` | same — **uncaughtException** |
| Single-Map sequential (`writeCandidateFile`) | `streamUrlsetLocs`' sax `onclosetag` | **SWALLOWED.** `parser.write` is wrapped in a try that treats any escape as a malformed document, so the run resolved as SUCCESS with partial output |

The sequential case was the worst of the three: measured **12,286 of 32,768 URLs written,
`caught=NOTHING`, no error, no dropped file**. A user would publish a truncated sitemap
believing it complete. A crash is at least visible; this was not.

## Proof (before → after)

Probe driving each site with a budget that admits sync #1 (4096 entries) and refuses sync #2,
so the refusal lands mid-handler rather than on a catchable tail sync:

```
BEFORE
  site1 sharded    → caught=NOTHING   (uncaughtException, stack via cleaner.ts rl.on("line"))
  site2 parallel   → caught=NOTHING   (uncaughtException, considerLoc → emit → rl.on("line"))
  site3 sequential → caught=NOTHING   RESULT kept=2 clean_urls=12286 of 32768 dropped=[]

AFTER
  site1 sharded    → caught=CleanerCapacityError  ledger.totalBytes=0 runs=0
  site2 parallel   → caught=CleanerCapacityError
  site3 sequential → caught=CleanerCapacityError
```

## The fix

**`readSpillLines` + `readProvisionalPairs`** — invoke the callback under a `try`, and on
throw: set a re-entry guard, `rl.close()`, `input.destroy()`, `reject(error)`. The guard
matters because readline can emit buffered lines after `close()`, so without it the callback
keeps running after the run has already failed. Also bound `input.on("error")`, since read
errors reach the interface inconsistently and could otherwise hang the promise forever.

**`streamUrlsetLocs`** — the promise had no `reject` at all. Added one, plus a `callbackError`
slot so a caller failure is told apart from a parse failure: `onclosetag` records the error
and rethrows (unwinding sax is the only way out of the callback), and `fail()` checks
`callbackError` first and routes to `failHard()` → `reject` instead of resolving
`isValid: false`. Parse errors still resolve as before — that contract is unchanged.

**`writeCandidateFile`** — newly reachable fd leak, since `produce()` can now reject with the
cleaned sink already open. Wrapped so the sink is closed and the partial output unlinked
before rethrowing. Same class as the report-fd leak fixed in `7f7d046c`.

## The flagged open question, answered

*Can `openDuplicateReport`'s `writeRow` throw synchronously from inside the same handlers?*

**No.** Verified: `WriteStream.write()` on a doomed stream returns normally and reports the
failure as an asynchronous `'error'` event (`write() returned normally`, then `EISDIR`
arrived as an event). So the handler-catch fix does not apply to it.

**But it had the same crash, by the opposite mechanism.** Until `close()` ran `finishStream`,
the report stream had **no `'error'` listener at all** — and an unhandled `'error'` on a
stream IS an uncaughtException. A full disk during Pass 2 therefore took the API down exactly
like the budget refusal did. Fixed by holding the first error in a persistent listener and
surfacing it at `close()`: on the cleanup path the caller already swallows it (the run is
failing anyway), and on the success path it correctly turns a half-written report into a
failed run rather than a silently truncated CSV.

The same hazard existed in two siblings in the same write path, fixed identically:
`createBatchedWriter` (spill files — the multi-GB part of a sharded run, so ENOSPC here is
the likeliest version) which bound an error listener only while actively awaiting drain, and
`openCleanedSink`'s non-gzip branch, which had none between `sink.write()` and `done()`. The
gzip branch already bound one for the whole window.

## Coverage

Three tests in `cleaner.test.ts`, each verified to FAIL with its own fix reverted and pass
with it:

- `SHARDED engine: an in-handler budget refusal rejects instead of killing the process`
- `SINGLE-MAP engine: an in-handler budget refusal rejects instead of truncating silently`
- `PARALLEL provisional reader: an in-handler budget refusal rejects instead of killing the process`

The first two assert the caller receives a `CleanerCapacityError` **and** that the ledger
returns to its pre-run `totalBytes`/`runs`. The third asserts the rejection reaches the
caller; ledger release is `cleanSitemaps`' job, not that function's. It is driven through the
exported `writeCandidatesParallel` because reaching that reader via `cleanSitemaps` would
need `CLEANER_PARALLEL_THRESHOLD` (200) real files and a live worker pool, and the threshold
is read once at module load so a test cannot move it.

Sizing is asserted, not assumed: the corpus is 8 syncs' worth and the budget admits one, so
the refusal is always in-handler. The separate bucket-release test deliberately keeps its
refusal on the tail sync so the two concerns fail independently.
