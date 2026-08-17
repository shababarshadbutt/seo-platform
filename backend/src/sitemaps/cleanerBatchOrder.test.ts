import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cleanSitemaps } from "./cleaner.js";

import {
  assignOutputNames,
  createRunFilesState,
  expectedCountForBatch,
  missingBatches,
  orderedFiles,
  receivedFileCount,
  registerBatch,
  renamedFiles,
  type RegisteredFile
} from "./cleanerRunFiles.js";

// Tier 1: the pure ordering guarantees behind batched upload.
//
// Why these are worth their weight: cleaner output is order-defined
// ("first occurrence across files wins"), and batched upload sends 3 requests
// CONCURRENTLY, so arrival order is not selection order. If registration were
// arrival-ordered, the same 1,681 files uploaded twice would produce different
// `kept_in` attributions — silently, with no crash.
//
// The existing cleaner.test.ts cannot catch that: it scrambles WORKER COMPLETION
// over a fixed, pre-sorted module-constant array. The bug class here corrupts the
// CONSTRUCTION of that array, which that test never exercises.

const BATCH_SIZE = 3;

function filesFor(batchIndex: number, count: number, offset = 0) {
  return Array.from({ length: count }, (_, position) => ({
    position: position + offset,
    filename: `b${batchIndex}-f${position + offset}.xml`,
    path: `/in/b${batchIndex}-p${position + offset}__b${batchIndex}-f${position + offset}.xml`
  }));
}

function names(files: { filename: string }[]) {
  return files.map((file) => file.filename);
}

test("scrambled batch arrival still yields selection order", () => {
  const expected = createRunFilesState({ batchSize: BATCH_SIZE, expectedTotal: 9 });

  for (const index of [0, 1, 2]) {
    registerBatch(expected, index, filesFor(index, 3));
  }

  // The same three batches, registered in the order a 3-worker pool might
  // actually complete them.
  const scrambled = createRunFilesState({ batchSize: BATCH_SIZE, expectedTotal: 9 });

  for (const index of [2, 0, 1]) {
    registerBatch(scrambled, index, filesFor(index, 3));
  }

  assert.deepEqual(names(orderedFiles(scrambled)), names(orderedFiles(expected)));
  assert.deepEqual(names(orderedFiles(scrambled)), [
    "b0-f0.xml", "b0-f1.xml", "b0-f2.xml",
    "b1-f0.xml", "b1-f1.xml", "b1-f2.xml",
    "b2-f0.xml", "b2-f1.xml", "b2-f2.xml"
  ]);
});

test("a MIDDLE short batch does not reorder anything", () => {
  // The server rejects non-XML parts, so a batch can be sparse in the middle of
  // the run. This is the case a flattened `batchIndex * BATCH_SIZE + position`
  // index invites you to mishandle by treating it as a dense array slot.
  const state = createRunFilesState({ batchSize: BATCH_SIZE, expectedTotal: 9 });

  registerBatch(state, 2, filesFor(2, 3));
  registerBatch(state, 1, [
    { position: 0, filename: "b1-f0.xml", path: "/in/x" },
    { position: 2, filename: "b1-f2.xml", path: "/in/y" }
  ]);
  registerBatch(state, 0, filesFor(0, 3));

  assert.deepEqual(names(orderedFiles(state)), [
    "b0-f0.xml", "b0-f1.xml", "b0-f2.xml",
    "b1-f0.xml", "b1-f2.xml",
    "b2-f0.xml", "b2-f1.xml", "b2-f2.xml"
  ]);
  // orderIndex must stay dense despite the hole in the position space.
  assert.deepEqual(
    orderedFiles(state).map((file) => file.orderIndex),
    [0, 1, 2, 3, 4, 5, 6, 7]
  );
});

test("a retried batch yields each file exactly once, at the right place", () => {
  const state = createRunFilesState({ batchSize: BATCH_SIZE, expectedTotal: 9 });

  registerBatch(state, 0, filesFor(0, 3));
  registerBatch(state, 1, filesFor(1, 2)); // first attempt stalled at 2 of 3
  registerBatch(state, 2, filesFor(2, 3));

  assert.equal(receivedFileCount(state), 8);
  assert.deepEqual(missingBatches(state), { missing: [], partial: [1] });

  // Retry batch 1 in full.
  const { attempt } = registerBatch(state, 1, filesFor(1, 3));

  assert.equal(attempt, 2, "retry must increment the attempt");
  assert.equal(receivedFileCount(state), 9, "retry must not double-count");
  assert.deepEqual(missingBatches(state), { missing: [], partial: [] });

  const ordered = orderedFiles(state);

  assert.equal(ordered.length, 9);
  assert.deepEqual(names(ordered).slice(3, 6), ["b1-f0.xml", "b1-f1.xml", "b1-f2.xml"]);
  // Every surviving file for batch 1 carries the NEW attempt, which is what lets
  // a late result from the stalled first attempt be recognised and discarded.
  for (const file of ordered.filter((f) => f.batchIndex === 1)) {
    assert.equal(file.attempt, 2);
  }
});

test("a superseded attempt is identifiable so its late result can be discarded", () => {
  const state = createRunFilesState({ batchSize: BATCH_SIZE, expectedTotal: 3 });

  const first = registerBatch(state, 0, filesFor(0, 3));
  const second = registerBatch(state, 0, filesFor(0, 3));

  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);

  // This comparison IS the guard the drainer applies before writing a classify
  // result into a slot. Without it, a result issued for attempt 1 can land after
  // attempt 2's and silently win.
  const current = state.batches.get(0)?.attempt;

  assert.equal(current, 2);
  assert.notEqual(first.attempt, current, "a stale attempt must not compare equal");
});

test("missingBatches reports absent and short batches separately", () => {
  const state = createRunFilesState({ batchSize: 50, expectedTotal: 130 });

  assert.equal(state.batchCount, 3);
  assert.equal(expectedCountForBatch(state, 0), 50);
  assert.equal(expectedCountForBatch(state, 2), 30, "last batch is short");

  registerBatch(state, 0, filesFor(0, 50));
  registerBatch(state, 2, filesFor(2, 27)); // short: expected 30

  assert.deepEqual(missingBatches(state), { missing: [1], partial: [2] });
});

test("duplicate basenames are renamed deterministically under every arrival order", () => {
  // Folder uploads routinely contain one sitemap.xml per subdirectory. Before
  // this, the second silently truncated the first in out/.
  const build = (order: number[]) => {
    const state = createRunFilesState({ batchSize: 2, expectedTotal: 6 });
    const batches: Record<number, RegisteredFile[]> = {
      0: [
        { batchIndex: 0, position: 0, attempt: 1, filename: "sitemap.xml", path: "/a" },
        { batchIndex: 0, position: 1, attempt: 1, filename: "other.xml", path: "/b" }
      ],
      1: [
        { batchIndex: 1, position: 0, attempt: 1, filename: "sitemap.xml", path: "/c" },
        { batchIndex: 1, position: 1, attempt: 1, filename: "sitemap.xml", path: "/d" }
      ],
      2: [
        { batchIndex: 2, position: 0, attempt: 1, filename: "other.xml", path: "/e" },
        { batchIndex: 2, position: 1, attempt: 1, filename: "sitemap.xml", path: "/f" }
      ]
    };

    for (const index of order) {
      registerBatch(state, index, batches[index]);
    }

    return orderedFiles(state);
  };

  const reference = build([0, 1, 2]);

  assert.deepEqual(reference.map((f) => f.outputName), [
    "sitemap.xml",
    "other.xml",
    "sitemap-2.xml",
    "sitemap-3.xml",
    "other-2.xml",
    "sitemap-4.xml"
  ]);

  // The whole point: arrival order must not change the mapping.
  for (const order of [[2, 1, 0], [1, 2, 0], [2, 0, 1], [1, 0, 2]]) {
    assert.deepEqual(
      build(order).map((f) => f.outputName),
      reference.map((f) => f.outputName),
      `arrival order ${order.join(",")} produced a different name mapping`
    );
  }

  assert.deepEqual(renamedFiles(reference), [
    { from: "sitemap.xml", to: "sitemap-2.xml" },
    { from: "sitemap.xml", to: "sitemap-3.xml" },
    { from: "other.xml", to: "other-2.xml" },
    { from: "sitemap.xml", to: "sitemap-4.xml" }
  ]);
});

test("renaming cannot collide with a name the user actually supplied", () => {
  // A selection containing both `a.xml` and a real `a-2.xml` must not have the
  // disambiguator generate a second `a-2.xml`.
  const ordered = assignOutputNames([
    { batchIndex: 0, position: 0, attempt: 1, filename: "a.xml", path: "/1" },
    { batchIndex: 0, position: 1, attempt: 1, filename: "a-2.xml", path: "/2" },
    { batchIndex: 0, position: 2, attempt: 1, filename: "a.xml", path: "/3" }
  ]);

  assert.deepEqual(ordered.map((f) => f.outputName), ["a.xml", "a-2.xml", "a-3.xml"]);
  assert.equal(
    new Set(ordered.map((f) => f.outputName)).size,
    3,
    "output names must be unique"
  );
});

test("files with no extension are still disambiguated", () => {
  const ordered = assignOutputNames([
    { batchIndex: 0, position: 0, attempt: 1, filename: "sitemap", path: "/1" },
    { batchIndex: 0, position: 1, attempt: 1, filename: "sitemap", path: "/2" }
  ]);

  assert.deepEqual(ordered.map((f) => f.outputName), ["sitemap", "sitemap-2"]);
});

// ---------------------------------------------------------------------------
// Tier 2: the assertion that actually protects the user.
//
// Everything above is about the ordering module in isolation. This drives the
// REAL engine and asserts that a scrambled batch arrival produces output
// byte-identical to a one-shot run over the same files in selection order.
//
// The fixture is built so a naive arrival-order implementation CANNOT pass:
// the first canonical occurrence of each shared URL lives in a LATE batch's
// file, with a later occurrence in an EARLY batch. Under selection order the
// early file wins; under arrival order (batch 2 registered first) the late file
// would win, flipping `kept_in`, flipping `also_in`, and changing which file
// ends up empty and dropped. Without that inversion the test would pass by
// accident against a broken implementation.

const HOST = "https://site.com";
const TODAY = "2026-08-17";

// batch -> files, each with the locs it contains. The SHARED urls are placed so
// that selection order and arrival order disagree about who wins them.
const CORPUS: { batch: number; name: string; locs: string[] }[] = [
  { batch: 0, name: "a0.xml", locs: [`${HOST}/only-a0`, `${HOST}/shared-x`] },
  { batch: 0, name: "a1.xml", locs: [`${HOST}/only-a1`, `${HOST}/shared-y`] },
  { batch: 1, name: "b0.xml", locs: [`${HOST}/shared-x/`, `${HOST}/only-b0`] },
  { batch: 1, name: "b1.xml", locs: [`${HOST}/shared-y`, `${HOST}/shared-x`] },
  { batch: 2, name: "c0.xml", locs: [`${HOST}/shared-x`, `${HOST}/shared-y`] },
  { batch: 2, name: "c1.xml", locs: [`${HOST}/only-c1`, `${HOST}/shared-y`] }
];

function writeCorpus(dir: string) {
  return CORPUS.map((entry) => {
    const filePath = path.join(dir, `${entry.batch}-${entry.name}`);

    writeFileSync(
      filePath,
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...entry.locs.map((loc) => `  <url><loc>${loc}</loc></url>`),
        "</urlset>"
      ].join("\n"),
      "utf8"
    );

    return { ...entry, path: filePath };
  });
}

async function cleanWith(files: { filename: string; path: string }[]) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-batch-out-"));
  const { result } = await cleanSitemaps({
    files,
    domain: HOST,
    subfolder: "sitemaps",
    today: TODAY,
    outDir,
    // Pinned so the comparison is between ORDERINGS, not between engine paths.
    parallel: false
  });

  const written = readdirSync(outDir)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({ name, body: readFileSync(path.join(outDir, name), "utf8") }));

  rmSync(outDir, { recursive: true, force: true });

  return { result, written, csv: csvOf(written) };
}

// v1.52: the duplicates report is no longer carried in the result — it is
// streamed straight to disk. `written` already contains it, so the report is
// compared from its bytes, which is a stronger check than the old in-memory
// array anyway.
function csvOf(written: { name: string; body: string }[]): string {
  return written.find((file) => file.name === "duplicates-report.csv")?.body ?? "";
}

test("scrambled batch arrival produces byte-identical output to a one-shot run", async () => {
  const inDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-batch-in-"));

  try {
    const corpus = writeCorpus(inDir);

    // Reference: one shot, in selection order.
    const reference = await cleanWith(
      corpus.map((entry) => ({ filename: entry.name, path: entry.path }))
    );

    // Sanity: the fixture must actually exercise cross-file dedup, or the whole
    // comparison is vacuous.
    assert.ok(
      reference.result.duplicates_removed > 0,
      "fixture must contain cross-file duplicates"
    );
    assert.ok(
      reference.csv.startsWith("url,kept_in_file,duplicate_in_file\r\n"),
      "report must use the one-row-per-occurrence header"
    );
    assert.ok(
      reference.csv.includes(",a0.xml,"),
      "the earliest file must win the shared URLs in selection order"
    );
    assert.equal(
      reference.csv.trimEnd().split("\r\n").length - 1,
      reference.result.duplicates_removed,
      "one CSV row per removed duplicate"
    );

    for (const arrival of [
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
      [0, 2, 1],
      [1, 0, 2]
    ]) {
      const state = createRunFilesState({ batchSize: 2, expectedTotal: 6 });

      for (const batchIndex of arrival) {
        registerBatch(
          state,
          batchIndex,
          corpus
            .filter((entry) => entry.batch === batchIndex)
            .map((entry, position) => ({
              position,
              filename: entry.name,
              path: entry.path
            }))
        );
      }

      const batched = await cleanWith(
        orderedFiles(state).map((file) => ({
          filename: file.filename,
          path: file.path,
          outputName: file.outputName
        }))
      );

      const label = `arrival ${arrival.join(",")}`;

      assert.deepEqual(batched.written, reference.written, `${label}: cleaned XML differs`);
      assert.equal(
        batched.csv,
        reference.csv,
        `${label}: duplicates report differs (kept_in attribution or row order)`
      );
      assert.deepEqual(
        batched.result.dropped_files,
        reference.result.dropped_files,
        `${label}: dropped files differ`
      );
      assert.deepEqual(
        batched.result.output_files,
        reference.result.output_files,
        `${label}: output manifest differs`
      );
      assert.equal(batched.result.duplicates_removed, reference.result.duplicates_removed);
      assert.equal(batched.result.clean_urls_remaining, reference.result.clean_urls_remaining);
    }
  } finally {
    rmSync(inDir, { recursive: true, force: true });
  }
});

test("the fixture would actually catch an arrival-order bug", async () => {
  // Guards the guard: if a naive implementation used arrival order, `kept_in`
  // would move off a0.xml. Prove that ordering the corpus differently really
  // does change the output, so the equivalence test above is not vacuous.
  const inDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-batch-neg-"));

  try {
    const corpus = writeCorpus(inDir);
    const selection = corpus.map((e) => ({ filename: e.name, path: e.path }));
    const arrivalOrdered = [...corpus]
      .sort((a, b) => b.batch - a.batch)
      .map((e) => ({ filename: e.name, path: e.path }));

    const reference = await cleanWith(selection);
    const wrong = await cleanWith(arrivalOrdered);

    assert.notEqual(
      wrong.csv,
      reference.csv,
      "fixture is too weak: arrival order must change the duplicates report"
    );
  } finally {
    rmSync(inDir, { recursive: true, force: true });
  }
});
