# TICKET: move the Cleaner's `keptBy` dedup index off the heap

**Status:** open — deliberately NOT done in the v1.48 change that added the budget guard.
**Estimate:** 2-3 days.
**Priority:** near-term. See "Why this must not be shelved" below.

## What v1.48 did and did not do

v1.48 stopped the Cleaner from aborting the API process at the heap limit. It did **not** remove
the ceiling:

- `keptBy` (`backend/src/sitemaps/cleaner.ts`) is still an in-memory `Map<normalizedUrl, filename>`,
  one entry per unique URL for the whole run.
- It is now byte-accounted against a process-wide budget derived from the live heap limit
  (`backend/src/sitemaps/dedupBudget.ts`), so crossing it **fails the run with an actionable
  message** instead of taking every concurrent run down with an uncatchable
  `FATAL ERROR: Reached heap limit`.
- The duplicates report was already fixed: it streams to its CSV instead of accumulating a Map plus
  a second full array copy. That part of the follow-up was pulled forward into v1.48 because it was
  low-risk and a large win.

So today a genuinely large run is **refused**, politely. The work still cannot be done. That is a
stopgap, not a fix.

## The change

1. `keptBy` → a disk-backed key store. Two shapes worth considering:
   - **External sort / run-merge**: Pass 2 writes `<key>\t<file>` per loc to spill files, sorts and
     merges them, and resolves first-occurrence-wins from the merged order. No new dependency,
     predictable I/O, but a bigger rewrite of the Pass 2 control flow.
   - **Embedded KV** (LMDB or SQLite): a `has`/`set` per loc against an on-disk B-tree. Much smaller
     diff, adds a dependency, and per-URL lookup latency is the risk (see risk 3).
2. Delete the residual per-run byte accounting for `keptBy` once it is no longer heap-resident, but
   **keep the process-wide ledger** — it should then govern whatever the new store's in-memory
   working set is (page cache, write buffers), which is bounded but not free.

## Risks, named

1. **`considerLoc` becomes async.** It is deliberately the single implementation of the dedup rule so
   the sequential and parallel Pass 2 paths stay byte-identical, and it is currently called from
   inside a sax callback that cannot await. Making it async changes **both** call paths and the
   `writeCandidateFile` / `writeCandidatesParallel` signatures. Batching lookups (resolve a whole
   provisional file's keys in one round trip) is probably how to keep it synchronous at the call
   site — worth designing before writing code.
2. **Ordering guarantees.** "First occurrence across files wins" must survive the store swap
   exactly. The existing test
   (`cleaner.test.ts` → "Pass 2 dedup + output is identical whatever order the workers finish in")
   asserts byte-identical output across scrambled worker completion orders and is the gate for this
   work. It must keep passing unmodified.
3. **I/O regression.** Dedup becomes I/O-bound. The baseline to beat is the measured 2,264-file run
   at **8.4 min** total (of which the SFTP pull was 96.4%, so there is very little slack in the clean
   stages to hide new latency). A per-URL disk lookup without batching could plausibly regress this
   badly. Measure against that same file set before merging; do not merge on unit tests alone.

## Why this must not be shelved

The failure it addresses stops being *visible* the moment the guard lands — a run that used to crash
the API now returns a clear refusal, so the crash reports disappear and the ceiling looks solved. It
isn't. Users with 1000+ file sitemap sets still cannot clean them in one pass, and the workaround
(split into smaller batches) is manual and easy to get wrong. The guard bought correctness and a
readable error; it did not buy the capability.
