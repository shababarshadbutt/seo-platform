import v8 from "node:v8";

// Heap budget for the Cleaner's cross-file dedup index.
//
// WHY THIS EXISTS. Pass 2's dedup state holds one entry per unique URL for the
// whole run (sitemaps/cleaner.ts). Nothing bounded it, and nothing capped the
// heap except NODE_OPTIONS=--max-old-space-size. Past ~25-30M unique URLs the
// process hit V8's heap limit and ABORTED — not a catchable exception, not a
// cgroup OOM kill (`docker inspect .State.OOMKilled` reports false for it), just
// `FATAL ERROR: Reached heap limit` and a restart. Because live runs and the
// finished-run download cache are both process-local Maps, that restart lost
// EVERY concurrent run and the next reconnect told the user their healthy run
// "is no longer available".
//
// There was no guard to fix — there was no guard at all.
//
// ---- The cost model -----------------------------------------------------
// Measured against V8 on x64 official Node builds (no pointer compression, so
// 8-byte pointers). Per unique URL in `Map<normalizedUrl, filename>`:
//
//   key string (SeqOneByteString): 16 B header + 1 B/char ASCII, 8-aligned
//   value:                          pointer to an already-interned filename
//                                   string (one of ~N filenames, shared) — no
//                                   new allocation, it lives in the table slot
//   OrderedHashMap backing store:   3 slots/entry (key, value, bucket chain)
//                                   = 24 B, + bucket array ~8 B = 32 B at load
//                                   factor 1. V8 doubles capacity, so average
//                                   occupancy is ~75% → 32 / 0.75 ≈ 43 B
//
// For a typical ~80-char sitemap URL that is 96 + 43 ≈ 140 B steady state.
//
// REHASH PEAK is 1.6x, not 1.5x. While growing, V8 allocates the new backing
// store with the old one still live, but ONLY THE TABLE DOUBLES — the key
// strings are not copied, their pointers are. Peak per entry is therefore
// 96 (strings) + 43 (old table) + 86 (new table) ≈ 225 B ≈ 1.6x of 140. A flat
// 1.5x applied to the whole entry would under-provision precisely at the moment
// of peak use, which is the only moment that matters.
const STRING_HEADER_BYTES = 16;
const MAP_ENTRY_OVERHEAD_BYTES = 43;
const REHASH_PEAK_FACTOR = 1.6;

// Share of the heap the dedup index may claim. The other 45% is not slack: the
// same heap serves every concurrent SSE response, in-flight parse streams, the
// duplicates-report writer, and every other user's requests. Dedup taking the
// whole heap would abort the process just as surely as having no ceiling.
const DEDUP_HEAP_SHARE = 0.55;

// A NEW run is refused once the shared total is already this far into the
// budget. Deliberately below 1.0: admitting a run when 95% is gone lets it do
// minutes of SFTP pulling and parsing before dying on the first dedup entry,
// which wastes the work and an SFTP slot. Refusing up front is honest and fast.
const ADMISSION_WATERMARK = 0.8;

// Peak heap cost of holding one normalized URL of `keyLength` chars in the
// dedup index. Charged per entry, so a set of long URLs correctly costs more
// than the same count of short ones — a plain URL COUNT ceiling cannot express
// that, and would be wrong by ~1.7x between a 60-char and a 100-char corpus.
export function dedupEntryCost(keyLength: number): number {
  return Math.ceil(
    (STRING_HEADER_BYTES + keyLength + MAP_ENTRY_OVERHEAD_BYTES) *
      REHASH_PEAK_FACTOR
  );
}

// Derived from the LIVE heap limit, never hardcoded.
//
// This is the whole point of reading v8.getHeapStatistics() rather than shipping
// a CLEANER_MAX_UNIQUE_URLS constant next to NODE_OPTIONS: two hand-maintained
// numbers drift the moment someone tunes one of them, and the failure mode of
// that drift is the silent OOM this module exists to prevent. Raising
// --max-old-space-size now moves the ceiling automatically, in the same
// direction, by construction.
export function dedupBudgetBytes(): number {
  if (budgetOverrideForTest !== null) {
    return budgetOverrideForTest;
  }

  return Math.floor(v8.getHeapStatistics().heap_size_limit * DEDUP_HEAP_SHARE);
}

// Test seam. The real budget is gigabytes, so the only way to exercise the
// over-budget paths in a unit test is to shrink it — filling several GB of heap
// to prove a guard works would be a test nobody runs.
let budgetOverrideForTest: number | null = null;

export function setDedupBudgetForTest(bytes: number | null): void {
  budgetOverrideForTest = bytes;
}

// Approximate URL ceiling at the current heap limit, for messages and logs
// only. Never used as the enforcement mechanism — bytes are. Assumes the
// ~80-char average the cost model is calibrated on.
const NOMINAL_URL_LENGTH = 80;

export function approxUrlCeiling(): number {
  return Math.floor(dedupBudgetBytes() / dedupEntryCost(NOMINAL_URL_LENGTH));
}

// Thrown when a run cannot proceed without risking the process. Carries the
// numbers so the message can name the ACTUAL count and the ceiling rather than
// saying "too large".
export class CleanerCapacityError extends Error {
  readonly uniqueUrls: number;
  readonly bytes: number;
  readonly budgetBytes: number;
  readonly concurrentRuns: number;

  constructor(options: {
    message: string;
    uniqueUrls: number;
    bytes: number;
    budgetBytes: number;
    concurrentRuns: number;
  }) {
    super(options.message);
    this.name = "CleanerCapacityError";
    this.uniqueUrls = options.uniqueUrls;
    this.bytes = options.bytes;
    this.budgetBytes = options.budgetBytes;
    this.concurrentRuns = options.concurrentRuns;
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

// ---- The SHARED, process-wide ledger ------------------------------------
//
// This is the part a per-run ceiling cannot do, no matter how it is sized. This
// is a single Node process serving every user's Cleaner run; the heap is shared
// but a per-run check only ever sees its own run. Two runs of 20M URLs each are
// individually legal under any 30M per-run ceiling and together abort the
// process, taking both of them plus everyone else's with it.
//
// So the budget is charged against a PROCESS-WIDE total. A run is admitted only
// if the shared total leaves room, and the run that would push the total over
// the line is the one that fails — the runs already invested in their work are
// not punished for a latecomer. That ordering is a deliberate choice: it favours
// completing work over fairness between runs, because the alternative (killing
// the largest) discards the most progress.
const charged = new Map<string, number>();
let totalBytes = 0;

export function dedupLedger(): {
  totalBytes: number;
  budgetBytes: number;
  runs: number;
} {
  return { totalBytes, budgetBytes: dedupBudgetBytes(), runs: charged.size };
}

// Gate a run BEFORE it starts pulling and parsing. Throws when the runs already
// in flight have consumed too much of the shared budget for another to be safe.
export function admitDedupRun(runId: string): void {
  const budgetBytes = dedupBudgetBytes();
  const ceiling = Math.floor(budgetBytes * ADMISSION_WATERMARK);

  if (totalBytes >= ceiling) {
    throw new CleanerCapacityError({
      message:
        `Server is at its Cleaner memory limit: ${charged.size} run(s) already in ` +
        `progress are using ${formatGiB(totalBytes)} of the ${formatGiB(budgetBytes)} ` +
        `dedup budget. Wait for one to finish and try again.`,
      uniqueUrls: 0,
      bytes: totalBytes,
      budgetBytes,
      concurrentRuns: charged.size
    });
  }

  charged.set(runId, charged.get(runId) ?? 0);
}

// Add this run's newly accumulated dedup bytes to the shared total.
//
// Called in batches by the dedup state (not once per URL) so the hot path stays
// a local counter increment; the shared total therefore trails reality by at
// most one batch, which is why the budget keeps a 45% margin rather than being
// enforced to the last byte.
export function chargeDedupBytes(
  runId: string,
  deltaBytes: number,
  uniqueUrls: number
): void {
  const budgetBytes = dedupBudgetBytes();
  const next = totalBytes + deltaBytes;

  if (next > budgetBytes) {
    throw new CleanerCapacityError({
      message:
        `This file set is too large to deduplicate in memory: ${uniqueUrls.toLocaleString()} ` +
        `unique URLs need about ${formatGiB(next)}, over the ${formatGiB(budgetBytes)} ` +
        `dedup budget` +
        (charged.size > 1
          ? ` shared with ${charged.size - 1} other run(s) in progress`
          : "") +
        `. Split the sitemaps into smaller batches, or raise the API's ` +
        `--max-old-space-size (currently ${formatGiB(
          v8.getHeapStatistics().heap_size_limit
        )} of heap).`,
      uniqueUrls,
      bytes: next,
      budgetBytes,
      concurrentRuns: charged.size
    });
  }

  totalBytes = next;
  charged.set(runId, (charged.get(runId) ?? 0) + deltaBytes);
}

// Release a finished (or failed, or abandoned) run's charge. MUST run on every
// exit path — a leaked charge permanently shrinks the budget for everyone and
// the process has to be restarted to recover it, which is the failure this
// module exists to avoid.
export function releaseDedupRun(runId: string): void {
  const held = charged.get(runId);

  if (held === undefined) {
    return;
  }

  totalBytes = Math.max(0, totalBytes - held);
  charged.delete(runId);
}

// Test seam only.
export function resetDedupLedgerForTest(): void {
  charged.clear();
  totalBytes = 0;
}
