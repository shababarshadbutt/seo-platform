// Shared by the categorizer's batch-write jobs (categorizerCategorizeJob.ts,
// categorizerStatusCheckJob.ts, categorizerStatusSampleJob.ts): each of them
// writes a batch of rows in ONE multi-row SQL statement for throughput at
// tens-of-millions-of-URLs scale, but that means a single row with a bad
// bound value (e.g. an id that fails a `::bigint` cast) used to throw the
// WHOLE statement out, aborting the entire batch — and from there, the whole
// phase, with no way to skip past the offending row.
//
// This bisects a FAILING batch instead of giving up on it or falling back to
// one-row-at-a-time: the common case (a healthy batch) costs exactly one call
// to runBatch, identical to before this existed — recursion only happens once
// runBatch has already thrown, so correctness here never costs the hot path
// anything. A batch of N rows with one bad row costs ~2*log2(N) extra calls
// to isolate it, not N individual round trips.
export async function writeBatchWithFaultIsolation<T>(
  rows: T[],
  runBatch: (rows: T[]) => Promise<void>,
  onRowFailed: (row: T, error: unknown) => Promise<void>
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  try {
    await runBatch(rows);
    return;
  } catch (error) {
    if (rows.length === 1) {
      await onRowFailed(rows[0], error);
      return;
    }

    const mid = Math.ceil(rows.length / 2);

    await writeBatchWithFaultIsolation(rows.slice(0, mid), runBatch, onRowFailed);
    await writeBatchWithFaultIsolation(rows.slice(mid), runBatch, onRowFailed);
  }
}
