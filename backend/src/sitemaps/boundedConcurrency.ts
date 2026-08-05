// Run a task over every item with at most N running at once.
//
// The same shared-cursor worker pool downloadSftpFiles uses, extracted so the
// Cleaner handoff ingest does not reimplement it, and so the part that is genuinely
// easy to get wrong (the concurrency ceiling, the completion counter, index
// alignment) is testable without a database, an SFTP server or a disk full of
// sitemaps.
//
// downloadSftpFiles deliberately keeps its own copy for now: it also honours an
// AbortSignal between files and back-fills the files it never reached as explicit
// failures, neither of which belongs in a general scheduler. Folding it in would
// mean changing live SFTP abort behaviour to remove a duplication that is costing
// nothing.
//
// Contract, all three of which callers depend on:
//   * NEVER more than `concurrency` tasks in flight.
//   * Results are INDEX-ALIGNED with `items`, so a caller can pair an outcome with
//     the input that produced it. Workers finish out of order; the array does not.
//   * onSettled receives a COMPLETION COUNT, not an index. With parallel workers
//     the indexes complete out of order, and a progress bar driven by them jumps
//     around and goes backwards.
//
// A task must not throw: settle failures into the result value instead. That keeps
// one bad item from tearing down the batch, which is what every current caller
// wants (a file that fails to copy is a reported failure, not an aborted ingest).

export async function runWithBoundedConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  task: (item: TItem, index: number) => Promise<TResult>,
  onSettled?: (
    result: TResult,
    completed: number,
    total: number
  ) => void | Promise<void>
): Promise<TResult[]> {
  const total = items.length;
  const results: TResult[] = new Array(total);

  if (total === 0) {
    return results;
  }

  const workers = Math.max(1, Math.min(concurrency, total));
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;

      if (index >= total) {
        return;
      }

      // Claimed BEFORE the first await, so two workers can never take the same
      // index — there is no yield point between reading and incrementing.
      nextIndex += 1;
      results[index] = await task(items[index], index);
      completed += 1;
      // Awaited, not fire-and-forget: an unordered progress write can land after
      // the terminal one and clobber it (a defect already found on the publish
      // path).
      await onSettled?.(results[index], completed, total);
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));

  return results;
}
