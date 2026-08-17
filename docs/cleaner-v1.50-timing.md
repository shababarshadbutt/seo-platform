# Sitemap Cleaner — v1.50 timing baseline

First measured numbers for the cleaner. Until this release there was **zero timing
instrumentation** in the whole cleaner path — the only log statement was the error
handler — so "it takes too long on 1,681 files" could not be attributed to anything.

Reproduce with:

```bash
cd backend
node --import tsx bench/cleanerStageTiming.ts [files] [urlsPerFile]
CLEANER_PARALLEL_THRESHOLD=99999 node --import tsx bench/cleanerStageTiming.ts   # force sequential
CLEANER_MAX_WORKERS=8            node --import tsx bench/cleanerStageTiming.ts
```

## Test conditions

| | |
|---|---|
| Fixture | 1,681 files × 200 URLs = 336,200 URLs, 10% cross-file duplicates |
| Host | win32, 12 logical CPUs, run natively (not in Docker) |
| Scope | **Cleaning only.** Does NOT include the multipart upload spool, which is a separate and serial cost. |
| Defaults | `CLEANER_PARALLEL_THRESHOLD=200`, `CLEANER_MAX_WORKERS=4` |

⚠️ Per-file URL count matters as much as file count. This fixture is 200 URLs/file;
real sitemaps run to 50k. Do not size a repro by file count alone.

## Headline: the main-thread merge is the ceiling

Representative parallel run (29.9s total):

| Span | ms | % of run |
|---|---|---|
| `stage.pass2_ms` (wall) | 23,614 | 79.1% |
| `pass2.read_provisional_ms` | 9,630 | 32.3% |
| `pass2.dedup_and_write_ms` | 8,725 | 29.2% |
| `pass2.unlink_provisional_ms` | 2,630 | 8.8% |
| **`pass2.worker_wait_ms`** | **1,971** | **6.6%** |
| `stage.pass1_ms` (wall) | 6,207 | 20.8% |
| `stage.select_ms` / `index_ms` / `report_ms` | 3 / 12 / 18 | ~0% |

`worker_wait_ms` is the diagnostic number: the main thread spends only **6.6%** of the
run blocked waiting for a worker. The pool is not the bottleneck — it is starved by the
strictly-serial merge that consumes provisional files in candidate order.

Of Pass 2's 23.6s wall clock, ~20.9s is main-thread work: read the provisional back
(9.6s) + dedup and write the final XML (8.7s) + unlink (2.6s).

## Matrix 1 — parallel vs sequential (4 repeats each)

| Mode | Runs (ms) | Min | Mean |
|---|---|---|---|
| Parallel (4 workers) | 22,987 / 23,837 / 22,449 / 23,376 | **22,449** | 23,162 |
| Sequential (no pool, no provisional hop) | 29,384 / 26,728 / 26,578 / 23,750 | 23,750 | 26,610 |

Parallel wins by ~13% on the mean, and every parallel run beat every sequential run.

**Caution, learned the hard way:** an earlier single pair showed the opposite
(parallel 29.9s vs sequential 24.0s) and briefly looked like a finding. Run-to-run
variance on this box is ±25%, comparable to the effect being measured. **Never conclude
from one pair — take at least 4 repeats per cell.**

So the provisional hop is *not* a net loss: it costs 12.3s of main-thread time but the
worker parallelism more than pays for it. It is, however, where the remaining time is.

## Matrix 2 — worker count (same fixture, one batch)

| `CLEANER_MAX_WORKERS` | Total |
|---|---|
| 1 | 30,318ms |
| 2 | 25,714ms |
| 4 | 26,860ms |
| 8 | 27,069ms |

The curve **flattens at 2**. Going 2 → 4 → 8 buys nothing measurable, exactly as
`worker_wait_ms ≈ 6.6%` predicts.

**Raising `CLEANER_MAX_WORKERS` is not the fix.** This rules out an entire class of
change. (Absolute values in this batch run higher than Matrix 1 — background load drifted
between batches. Compare within a batch, never across.)

## CPU vs I/O

Summed across threads: sax **20.7s** vs io_wait **9.2s**. The work is CPU-dominant, not
disk-starved — consistent with `uploads` being a Docker *named volume* (ext4 inside the
WSL2 VM), not a slow host bind mount.

`pass1.sax_ms` is **8.7s spent parsing every file in full to extract two integers**
(total and on-domain `<loc>` counts), which Pass 2 then throws away and re-parses.

## What to do next, in value order

1. **Remove the provisional hop** (~41% of the run is read+unlink+merge). Have the Pass-2
   worker write the final XML directly, or stream pairs without an intermediate file. The
   constraint to preserve is byte-identical output regardless of worker completion order —
   `cleaner.test.ts` is the guard.
2. **Eliminate the double parse** (~8.7s of summed sax). Pass 1 could return the on-domain
   URLs it already streamed, or the keep/drop decision could move into Pass 2.
3. **Consider lowering the default `CLEANER_MAX_WORKERS` to 2** — 4 buys nothing here and
   each thread carries its own V8 heap plus a `tsx` bootstrap.
4. **Measure the upload spool separately.** It is not in these numbers and is serial by
   protocol (1,681 sequential `createWriteStream` + `pipeline` cycles).

## Not measured yet

- The multipart upload spool, and the Windows→WSL2 port proxy.
- Inside Docker (these are native runs).
- Real sitemaps with 10k–50k URLs per file.
- `tsx` worker bootstrap cost (`--import tsx` per thread, `idleTimeout: 30_000`).
