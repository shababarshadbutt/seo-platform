# Sitemap Cleaner — v1.52: why a large corpus killed the backend

A user cleaned 1,681 files. The UI froze at "Cleaning 566 of 1,680 files / 71%" and the
Migration page began reporting *"Cannot connect to backend — make sure Docker is
running"*, which survived a restart. Both symptoms were one event: **the API process
died**, twice over, for two different reasons.

Everything below is measured on the real corpus (`data/Air Part Shop/`), not estimated.

## The corpus

| | |
|---|---|
| Files | 1,605 XML |
| Total size | 4.3 GB |
| Largest file | 7.1 MB / 40,000 URLs |
| Sampled mean | 21,823 URLs/file |
| Extrapolated | **~35M URL occurrences**, >16.7M of them unique |
| The synthetic benchmark it was compared against | 336,200 URLs — **104× smaller** |

That size gap is the whole story. Every earlier conclusion about the cleaner came from a
fixture two orders of magnitude too small to reach either failure.

## Two distinct walls, both measured

Reproduce with:

```bash
cd backend
node --max-old-space-size=4096 --import tsx bench/cleanerStageTiming.ts \
  --dir "…/data/Air Part Shop" --domain "https://www.airpartshop.com"
```

### Wall 1 — heap exhaustion (4 GB)

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```
peak heap **3,687 MB** / limit 4,288 MB, ~12 minutes in.

This is what hit production. Two properties made it invisible rather than reportable:

- **It is uncatchable.** A V8 heap abort is `abort()`, not a JS exception, so the
  route's `catch` never ran and no `error` frame was ever published.
- **The container survived it.** PID 1 is `tsx watch`, not Node, so the watcher outlived
  its dead child: `docker ps` still said `Up`, port 3001 stayed published with nothing
  behind it, and the healthcheck's `(unhealthy)` verdict triggered nothing because no
  service declares a `restart:` policy.

Note it aborted *below* the ceiling. Growing a `Map` allocates a second table before
freeing the first, so the rehash spike — not the steady state — is what fails.

### Wall 2 — V8's Map entry cap (12 GB)

Given more heap, the same corpus reached a harder limit:

```
RangeError: Map maximum size exceeded
    at Map.set (considerLoc, cleaner.ts:417)
```
peak heap 4,220 MB, ~13 minutes in.

**A single V8 `Map` holds at most 2^24 = 16,777,216 entries.** The dedup index is one
entry per unique URL, so this corpus simply exceeds it. This is a *count* limit:
`--max-old-space-size` does not move it at 12 GB, 32 GB or 128 GB.

This one also killed the process, but for a fixable reason: the throw escaped a readline
`"line"` listener, where a throw becomes an `uncaughtException` rather than rejecting the
enclosing promise.

## What changed

1. **The duplicates report is streamed to disk, not accumulated.** `dupReport` held
   `{url, kept_in, also_in[]}` per distinct duplicated URL at ~370 B each — larger than
   the dedup index itself (~130 B/entry) — purely so the result could carry a
   `duplicate_urls` array to the browser, so the browser could rebuild a CSV already
   written to disk. Now one row per occurrence, written as found, served by
   `GET /api/cleaner/report/:token`.

   This also removed a second, crash-free freeze path: `JSON.stringify` of that array hit
   V8's ~512 MB string cap at ~3–4M rows, and the `RangeError` was silently swallowed by
   `publishFrame`'s bare `catch {}`, leaving the stream open with no `done` and no `error`.

   Side effect: the CSV format changed from grouped rows
   (`url,kept_in_file,duplicate_in_files` with a `"; "`-joined list) to one row per
   occurrence (`url,kept_in_file,duplicate_in_file`). Aggregation is what forced it to be
   held in memory.

2. **The dedup index is sharded across 32 Maps** (`DedupIndex`). Not a memory
   optimisation — it is the only way past the 2^24 cap. Correctness rests on
   `dedupShardOf` being pure in the key, so every occurrence of a URL lands in the same
   shard; comparison inside a shard is still exact-string, and URLs are still fed in
   canonical order, so first-occurrence-wins and the output bytes are unchanged.
   `cleaner.test.ts` pins that.

3. **`BACKEND_HEAP_MB`** (default 12288) on the backend service only. The worker keeps the
   image default of 4096 — it never runs a clean.

4. **Failures are now reportable rather than fatal.** A throw inside the provisional
   readline handler rejects its promise instead of becoming an `uncaughtException`, and
   exceeding capacity raises a named `CleanerCapacityError` naming the limit and telling
   the user to split the corpus.

5. **The frontend can no longer freeze on a dead stream.** `streamCleanerRun` rejects if
   the socket closes without a terminal frame — previously indistinguishable from a clean
   finish — the `.catch(() => undefined)` that swallowed it is gone, and a 60s
   no-activity watchdog probes the run and reports what actually happened. Any stream
   death (crash, redeploy, laptop sleep, proxy blip) used to freeze the page permanently.

## Result — the corpus now completes

Same corpus, sharded index, `--max-old-space-size=12288`:

| | |
|---|---|
| Outcome | **Completed** |
| Peak heap | **5,277 MB** of a 12,480 MB ceiling (~42%) |
| Peak RSS | 6,746 MB |
| Cleaning wall clock | **905 s ≈ 15 min** (538 ms/file) |
| Files | 1,297 kept, 306 dropped |
| Duplicates removed | **12,447,935** |

Two things worth reading off that table. Peak heap of 5,277 MB confirms the 4 GB ceiling
could never have worked *and* that 12 GB is not close to tight. And the unique-URL count
implied by ~35M occurrences minus 12.4M duplicates is ~22M — comfortably past 2^24, which
is why sharding was required rather than merely helpful.

The 15-minute figure is the clean alone. Uploading 4.3 GB is on top of it.

## Method notes, learned the hard way

- **`--dir` requires `--domain`.** The first real-corpus run used the benchmark's default
  `example.com`, so every file was dropped as wrong-domain in Pass 1, nothing reached
  Pass 2, and it "passed" in 3.9 minutes with an 18 MB peak heap — on a corpus that had
  just crashed production. The bench now refuses `--dir` without `--domain`.
- **Run-to-run variance on this box is ±25%.** Take at least 4 repeats per cell for any
  timing claim; never conclude from one pair.
- Peak memory must be *sampled during* the run. An abort leaves no summary behind.
- A span that wraps a phase it does not own will silently double-count it. The first
  version of `stage.report_ms` started before Pass 2 and reported 80% of the run —
  indistinguishable from `stage.pass2_ms`, because it was measuring the same thing. It now
  covers only the flush.

## Still open

- Beyond roughly 60–90M unique URLs the heap becomes binding again. The answer there is
  the disk-spilling sharded dedup on `feature/aws-s3-sftp-deploy` (~1,380 lines), which
  bounds resident memory rather than just the per-Map count.
- **No `restart:` policy on any service.** If the backend dies for any other reason it
  stays dead while still reporting `Up`. One line in compose, deliberately not taken yet.
- `publishFrame`'s bare `catch {}` still swallows subscriber errors; its known trigger is
  gone, the swallow is not.
