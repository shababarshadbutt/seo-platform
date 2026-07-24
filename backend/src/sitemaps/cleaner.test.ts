import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createDedupState,
  normalizeForDedup,
  writeCandidatesParallel,
  type CleanerInputFile,
  type DropReason
} from "./cleaner.js";

// Pass 2's cross-file dedup ("first occurrence across files wins") must depend
// on FILE ORDER, not the order the parallel workers finish in. These tests
// drive writeCandidatesParallel with a loadProvisional whose per-file
// completion order is deliberately scrambled, and assert the result — the
// duplicates report AND the written cleaned files — is byte-identical to an
// in-order run.

const TODAY = "2026-07-24";
const HOST = "https://site.com";

// Each fixture's on-domain locs in file order, seeded with cross-file dups:
//  - HOST/dup first in a → kept in a; b (as "dup/", trailing-slash variant that
//    normalizes equal) and c are duplicates.
//  - d is entirely dups of a → drops as "empty".
const FIXTURE: { file: CleanerInputFile; locs: string[] }[] = [
  { file: { filename: "a.xml", path: "/unused/a" }, locs: [`${HOST}/x`, `${HOST}/y`, `${HOST}/dup`] },
  { file: { filename: "b.xml", path: "/unused/b" }, locs: [`${HOST}/z`, `${HOST}/dup/`, `${HOST}/w`] },
  { file: { filename: "c.xml", path: "/unused/c" }, locs: [`${HOST}/dup`, `${HOST}/v`] },
  { file: { filename: "d.xml", path: "/unused/d" }, locs: [`${HOST}/x`, `${HOST}/y`] }
];

const candidates = FIXTURE.map((f) => ({
  file: f.file,
  onDomainCount: f.locs.length
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RunResult = {
  survivors: { filename: string; url_count: number }[];
  dropped: { filename: string; reason: DropReason }[];
  duplicates_removed: number;
  duplicate_urls: { url: string; kept_in: string; also_in: string[] }[];
  outDir: string;
};

async function run(
  concurrency: number,
  delayFor: (index: number) => number
): Promise<RunResult> {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-order-"));
  const provDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-prov-"));
  const state = createDedupState();
  const survivors: {
    filename: string;
    url_count: number;
    path: string;
    onDomainCount: number;
  }[] = [];
  const dropped: { filename: string; reason: DropReason }[] = [];

  await writeCandidatesParallel({
    candidates,
    concurrency,
    today: TODAY,
    outDir,
    state,
    survivors,
    dropped,
    cleanupProvisional: true,
    // Mock worker: write this file's provisional "<key>\t<loc>" lines after a
    // per-index delay so completion order != file order, then return the path.
    loadProvisional: async (_candidate, index) => {
      await sleep(delayFor(index));
      const provPath = path.join(provDir, `p${index}.provisional`);
      const body = FIXTURE[index].locs
        .map((loc) => `${normalizeForDedup(loc)}\t${loc}`)
        .join("\n");
      writeFileSync(provPath, body + "\n");

      return provPath;
    }
  });

  rmSync(provDir, { recursive: true, force: true });

  return {
    survivors: survivors.map((s) => ({
      filename: s.filename,
      url_count: s.url_count
    })),
    dropped,
    duplicates_removed: state.duplicatesRemoved,
    duplicate_urls: [...state.dupReport.values()],
    outDir
  };
}

test("Pass 2 dedup + output is identical whatever order the workers finish in", async () => {
  const reference = await run(1, () => 0); // in-order
  const scrambled = await run(FIXTURE.length, (i) => (FIXTURE.length - i) * 15); // reverse-ish

  const expectedSurvivors = [
    { filename: "a.xml", url_count: 3 },
    { filename: "b.xml", url_count: 2 },
    { filename: "c.xml", url_count: 1 }
  ];
  const expectedDropped = [{ filename: "d.xml", reason: "empty" as DropReason }];
  const expectedDuplicates = [
    { url: `${HOST}/dup/`, kept_in: "a.xml", also_in: ["b.xml", "c.xml"] },
    { url: `${HOST}/x`, kept_in: "a.xml", also_in: ["d.xml"] },
    { url: `${HOST}/y`, kept_in: "a.xml", also_in: ["d.xml"] }
  ];

  // Reference matches the hand-computed first-wins expectation.
  assert.deepEqual(reference.survivors, expectedSurvivors);
  assert.deepEqual(reference.dropped, expectedDropped);
  assert.equal(reference.duplicates_removed, 4);
  assert.deepEqual(reference.duplicate_urls, expectedDuplicates);

  // Scrambled completion is identical in every reported dimension...
  assert.deepEqual(scrambled.survivors, reference.survivors);
  assert.deepEqual(scrambled.dropped, reference.dropped);
  assert.equal(scrambled.duplicates_removed, reference.duplicates_removed);
  assert.deepEqual(scrambled.duplicate_urls, reference.duplicate_urls);

  // ...and so are the actual cleaned files on disk.
  for (const { filename } of expectedSurvivors) {
    const a = readFileSync(path.join(reference.outDir, filename), "utf8");
    const b = readFileSync(path.join(scrambled.outDir, filename), "utf8");
    assert.equal(b, a, `${filename} must be byte-identical across completion orders`);
  }

  const aXml = readFileSync(path.join(reference.outDir, "a.xml"), "utf8");
  assert.ok(
    aXml.indexOf(`${HOST}/x`) < aXml.indexOf(`${HOST}/dup`),
    "locs stay in original file order"
  );
  assert.match(aXml, new RegExp(`<lastmod>${TODAY}</lastmod>`));
  assert.throws(
    () => readFileSync(path.join(reference.outDir, "d.xml"), "utf8"),
    "d.xml was entirely duplicates → must not be written"
  );

  rmSync(reference.outDir, { recursive: true, force: true });
  rmSync(scrambled.outDir, { recursive: true, force: true });
});
