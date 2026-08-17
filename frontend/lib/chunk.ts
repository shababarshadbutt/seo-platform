// Fixed-window slicing for batched uploads.
//
// Extracted from app/page.tsx so the Migration and Cleaner pages share one
// implementation. That matters more for the Cleaner than it looks: cleaner
// output is order-defined, so the batch a file lands in — and its position
// within that batch — is part of its identity, not just a transport detail.

export function chunkFiles<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, batchSize);
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}
