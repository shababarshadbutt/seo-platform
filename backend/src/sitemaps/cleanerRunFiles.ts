// Slot registration and canonical ordering for a batched Cleaner upload.
//
// Deliberately pure: no Fastify, no disk, no worker pools, no clock. Everything
// here is a function of its arguments, which is what makes the ordering
// guarantees testable at all. If this logic lived inline in the route handler
// the tests in cleanerBatchOrder.test.ts could not exist.
//
// ---- Why ordering is a correctness concern, not a tidiness one -------------
//
// Cleaner output is ORDER-DEFINED. `considerLoc` in cleaner.ts implements
// "first occurrence across files wins", so which file keeps a shared URL — and
// therefore `kept_in`, `also_in`, and which file ends up empty and dropped — is
// decided by the position of a file in the candidate list.
//
// Batched upload sends 3 requests concurrently, so ARRIVAL ORDER IS NOT
// SELECTION ORDER. Registering files as they land would make the output
// nondeterministic: the same 1,681 files uploaded twice would produce different
// duplicates reports. That is the single biggest hazard in the batched design.
//
// ---- The key: a tuple, not a flattened integer -----------------------------
//
// A file's identity is the lexicographic tuple (batchIndex, positionWithinBatch).
// The obvious alternative, `globalIndex = batchIndex * BATCH_SIZE + position`,
// works but requires the client and the server to agree on an integer that lives
// in two files. Set the client's batch size to 100 while the server still
// multiplies by 50 and every batch after the first collides into the previous
// batch's range — with no crash, no failing test, and the only symptom being
// silently wrong attribution in the duplicates report.
//
// The tuple has no shared constant to drift. It also makes gaps harmless: the
// server rejects non-XML parts, so positions within a batch can be sparse, and a
// tuple is structurally impossible to mistake for a dense array index the way a
// flattened integer invites.
//
// `positionWithinBatch` is the server's own iteration index over the multipart
// parts — never client-supplied — so it cannot disagree with the bytes that
// actually arrived.

export type RegisteredFile = {
  batchIndex: number;
  position: number;
  attempt: number;
  /** Original base name as uploaded. May collide across batches — see assignOutputNames. */
  filename: string;
  /** On-disk spool path, already attempt-qualified by the caller. */
  path: string;
};

export type OrderedFile = RegisteredFile & {
  /** Dense 0..n-1 index, materialised only after the canonical sort. */
  orderIndex: number;
  /** Collision-free name to write into out/ and the ZIP. */
  outputName: string;
};

export type BatchState = {
  attempt: number;
  state: "receiving" | "received" | "partial" | "failed";
  expectedCount: number;
  files: RegisteredFile[];
};

export type RunFilesState = {
  batchSize: number;
  batchCount: number;
  expectedTotal: number;
  batches: Map<number, BatchState>;
};

export function createRunFilesState(options: {
  batchSize: number;
  expectedTotal: number;
}): RunFilesState {
  const { batchSize, expectedTotal } = options;

  return {
    batchSize,
    expectedTotal,
    batchCount: Math.ceil(expectedTotal / batchSize),
    batches: new Map()
  };
}

/** How many files batch `i` should contain — the last batch is short. */
export function expectedCountForBatch(
  state: RunFilesState,
  batchIndex: number
): number {
  const remaining = state.expectedTotal - batchIndex * state.batchSize;

  return Math.max(0, Math.min(state.batchSize, remaining));
}

/**
 * Record one batch's files, replacing any previous attempt wholesale.
 *
 * Replacement rather than merge is what makes a retry idempotent: re-POSTing
 * batch 7 cannot append a second copy of its files or double-count them, no
 * matter how far the failed attempt got. The returned attempt number is stamped
 * onto every file so a late classify result from a superseded attempt can be
 * recognised and discarded.
 */
export function registerBatch(
  state: RunFilesState,
  batchIndex: number,
  files: Omit<RegisteredFile, "batchIndex" | "attempt">[]
): { attempt: number; batch: BatchState } {
  const previous = state.batches.get(batchIndex);
  const attempt = (previous?.attempt ?? 0) + 1;
  const expectedCount = expectedCountForBatch(state, batchIndex);

  const batch: BatchState = {
    attempt,
    expectedCount,
    state: files.length === expectedCount ? "received" : "partial",
    files: files.map((file) => ({ ...file, batchIndex, attempt }))
  };

  state.batches.set(batchIndex, batch);

  return { attempt, batch };
}

/** Distinct files currently held, recomputed rather than incremented. */
export function receivedFileCount(state: RunFilesState): number {
  let count = 0;

  for (const batch of state.batches.values()) {
    count += batch.files.length;
  }

  return count;
}

/**
 * Batches that have not arrived at all, and batches that arrived short.
 *
 * The cleaner reports these on `complete` rather than quietly cleaning what it
 * has: cleaner output is a whole-corpus artifact, so a missing batch does not
 * mean a smaller ZIP — it means wrong `kept_in` attributions and a wrong
 * sitemap-index.xml. Naming the exact batches lets the client re-send only those.
 */
export function missingBatches(state: RunFilesState): {
  missing: number[];
  partial: number[];
} {
  const missing: number[] = [];
  const partial: number[] = [];

  for (let index = 0; index < state.batchCount; index += 1) {
    const batch = state.batches.get(index);

    if (!batch || batch.state === "failed") {
      missing.push(index);
      continue;
    }

    if (batch.files.length < batch.expectedCount) {
      partial.push(index);
    }
  }

  return { missing, partial };
}

/**
 * The canonical order: sort every registered file by (batchIndex, position).
 *
 * This is the single point at which arrival order stops mattering. Everything
 * downstream — the candidate list, provisional paths, survivor order, the index
 * — consumes the dense `orderIndex` produced here, exactly as the one-shot path
 * consumes the selection order.
 */
export function orderedFiles(state: RunFilesState): OrderedFile[] {
  const flat: RegisteredFile[] = [];

  for (const batch of state.batches.values()) {
    flat.push(...batch.files);
  }

  flat.sort((a, b) =>
    a.batchIndex !== b.batchIndex
      ? a.batchIndex - b.batchIndex
      : a.position - b.position
  );

  return assignOutputNames(flat);
}

/**
 * Give every file a collision-free output name.
 *
 * Two selected files can share a base name — `sitemap.xml` per subdirectory is
 * the norm in folder uploads, which is exactly the shape a batched upload makes
 * practical. Before this, the second one silently truncated the first in out/,
 * the index listed the same <loc> twice, and the duplicates report said
 * `kept_in: "sitemap.xml"` without saying which.
 *
 * The walk runs over the ALREADY-SORTED list, so the assignment is a function of
 * canonical order alone and is identical under every arrival permutation.
 */
export function assignOutputNames(files: RegisteredFile[]): OrderedFile[] {
  const taken = new Set<string>();

  return files.map((file, orderIndex) => {
    let outputName = file.filename;

    if (taken.has(outputName)) {
      const dot = file.filename.lastIndexOf(".");
      const stem = dot > 0 ? file.filename.slice(0, dot) : file.filename;
      const ext = dot > 0 ? file.filename.slice(dot) : "";
      let suffix = 2;

      // Skip names already claimed, so a selection containing both `a.xml` and
      // a genuine `a-2.xml` cannot be made to collide by the renaming itself.
      while (taken.has(`${stem}-${suffix}${ext}`)) {
        suffix += 1;
      }

      outputName = `${stem}-${suffix}${ext}`;
    }

    taken.add(outputName);

    return { ...file, orderIndex, outputName };
  });
}

/** Renames worth surfacing in the summary, so disambiguation is never silent. */
export function renamedFiles(
  files: OrderedFile[]
): { from: string; to: string }[] {
  return files
    .filter((file) => file.outputName !== file.filename)
    .map((file) => ({ from: file.filename, to: file.outputName }));
}
