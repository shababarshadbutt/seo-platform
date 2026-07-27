import assert from "node:assert/strict";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { createGzip, gunzipSync } from "node:zlib";

import {
  cleanSitemaps,
  createDedupState,
  normalizeForDedup,
  uniqueOutputName,
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
  outputName: f.file.filename,
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

// ---- v1.46.1 Cleaner correctness fixes ------------------------------------

const DOMAIN = "https://www.airpartshop.com";

function urlsetXml(locs: string[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    locs.map((l) => `  <url><loc>${l}</loc></url>\n`).join("") +
    "</urlset>\n"
  );
}

function scratch(tag: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cleaner-${tag}-`));
  const inDir = path.join(dir, "in");
  const outDir = path.join(dir, "out");
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  return { dir, inDir, outDir };
}

test("uniqueOutputName suffixes collisions and preserves .xml / .xml.gz", () => {
  const used = new Set<string>();
  assert.equal(uniqueOutputName("sitemap.xml", used), "sitemap.xml");
  assert.equal(uniqueOutputName("sitemap.xml", used), "sitemap-2.xml");
  assert.equal(uniqueOutputName("sitemap.xml", used), "sitemap-3.xml");
  assert.equal(uniqueOutputName("a.xml.gz", used), "a.xml.gz");
  // The suffix must land on the stem, not between .xml and .gz.
  assert.equal(uniqueOutputName("a.xml.gz", used), "a-2.xml.gz");
});

// Two uploads sharing a basename (the route flattens ZIP paths via baseName)
// used to write the SAME outDir path — the second silently overwrote the first,
// losing its URLs while the summary still counted them.
test("two uploads sharing a basename both survive — no URLs silently lost", async () => {
  const { dir, inDir, outDir } = scratch("dupname");

  try {
    const p1 = path.join(inDir, "0__sitemap.xml");
    const p2 = path.join(inDir, "1__sitemap.xml");
    writeFileSync(p1, urlsetXml([`${DOMAIN}/aaa1`, `${DOMAIN}/aaa2`, `${DOMAIN}/aaa3`]));
    writeFileSync(p2, urlsetXml([`${DOMAIN}/bbb1`, `${DOMAIN}/bbb2`]));

    const { result } = await cleanSitemaps({
      files: [
        { filename: "sitemap.xml", path: p1 },
        { filename: "sitemap.xml", path: p2 }
      ],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });

    assert.equal(result.files_kept, 2);
    assert.equal(result.clean_urls_remaining, 5);
    assert.deepEqual(
      result.output_files.map((f) => f.filename).sort(),
      ["sitemap-2.xml", "sitemap.xml"]
    );

    // The reported total must actually exist on disk.
    const written = result.output_files.reduce(
      (sum, f) =>
        sum +
        (readFileSync(path.join(outDir, f.filename), "utf8").match(/<loc>/g) ?? [])
          .length,
      0
    );
    assert.equal(written, result.clean_urls_remaining);

    // The rebuilt index must reference both distinct files, not one name twice.
    const idx = readFileSync(path.join(outDir, "sitemap-index.xml"), "utf8");
    assert.ok(idx.includes("/sitemaps/sitemap.xml"));
    assert.ok(idx.includes("/sitemaps/sitemap-2.xml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// .xml.gz input was read correctly but written back as PLAIN xml under the .gz
// name — anything that gunzips it (Google, or this tool's own re-ingest) fails.
test("gzipped input produces genuinely gzipped output", async () => {
  const { dir, inDir, outDir } = scratch("gzip");

  try {
    const plain = path.join(inDir, "src.xml");
    writeFileSync(plain, urlsetXml([`${DOMAIN}/g1`, `${DOMAIN}/g2`, `${DOMAIN}/g3`]));
    const gz = path.join(inDir, "0__aviation-mfg1.xml.gz");
    await pipeline(createReadStream(plain), createGzip(), createWriteStream(gz));

    const { result } = await cleanSitemaps({
      files: [{ filename: "aviation-mfg1.xml.gz", path: gz }],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });

    assert.equal(result.clean_urls_remaining, 3);

    const raw = readFileSync(path.join(outDir, "aviation-mfg1.xml.gz"));
    // gzip magic number — the whole point of the fix.
    assert.equal(raw[0], 0x1f);
    assert.equal(raw[1], 0x8b);

    const round = gunzipSync(raw).toString("utf8");
    assert.equal((round.match(/<loc>/g) ?? []).length, 3);
    assert.ok(round.startsWith('<?xml version="1.0"'));
    assert.ok(round.trimEnd().endsWith("</urlset>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A file emptied entirely by dedup leaves the survivors set, so a
// survivors-only denominator reported an absurd reduction (2/2 = 100% for an
// input that was 4 URLs and 50% duplicated).
test("reduction_pct counts every URL that entered dedup, not just survivors", async () => {
  const { dir, inDir, outDir } = scratch("reduction");

  try {
    const x = path.join(inDir, "0__x.xml");
    const y = path.join(inDir, "1__y.xml");
    writeFileSync(x, urlsetXml([`${DOMAIN}/q1`, `${DOMAIN}/q2`]));
    writeFileSync(y, urlsetXml([`${DOMAIN}/q1`, `${DOMAIN}/q2`]));

    const { result } = await cleanSitemaps({
      files: [
        { filename: "x.xml", path: x },
        { filename: "y.xml", path: y }
      ],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });

    assert.equal(result.files_kept, 1);
    assert.deepEqual(result.dropped_files, [{ filename: "y.xml", reason: "empty" }]);
    assert.equal(result.duplicates_removed, 2);
    // 2 duplicates out of the 4 on-domain URLs that entered dedup = 50%.
    assert.equal(result.reduction_pct, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
