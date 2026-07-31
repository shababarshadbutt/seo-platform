import assert from "node:assert/strict";
import {
  createReadStream,
  createWriteStream,
  existsSync,
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
  dedupBucketCount,
  dedupBucketOf,
  normalizeForDedup,
  REPORT_FILENAME,
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

// ---- Sharded cross-file dedup (the 2^24 Map ceiling fix) ------------------
//
// A V8 Map throws `RangeError: Map maximum size exceeded` at 16,777,216 entries.
// A real client (915 sitemaps / 33.4M URLs) is double that, so the single-Map
// dedup could never hold it: Map.set threw, nothing caught it, and the API
// exited 1 — killing every concurrent run and reporting itself to the user as
// "the server restarted while this run was in progress".
//
// The fix shards the dedup by key into buckets processed one at a time. These
// tests force real sharding on small inputs via CLEANER_DEDUP_URLS_PER_BUCKET so
// the sharded and single-Map paths can be compared over the SAME corpus.

async function cleanWithBucketSize(
  files: CleanerInputFile[],
  outDir: string,
  perBucket: string | undefined
) {
  const previous = process.env.CLEANER_DEDUP_URLS_PER_BUCKET;

  if (perBucket === undefined) {
    delete process.env.CLEANER_DEDUP_URLS_PER_BUCKET;
  } else {
    process.env.CLEANER_DEDUP_URLS_PER_BUCKET = perBucket;
  }

  try {
    return await cleanSitemaps({
      files,
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CLEANER_DEDUP_URLS_PER_BUCKET;
    } else {
      process.env.CLEANER_DEDUP_URLS_PER_BUCKET = previous;
    }
  }
}

test("dedupBucketCount stays on the single-Map path until sharding is needed", () => {
  // The whole safety argument for this change: anything that fits today keeps
  // running through the exact code path it ran through before.
  assert.equal(dedupBucketCount(0), 1);
  assert.equal(dedupBucketCount(1), 1);
  assert.equal(dedupBucketCount(4_000_000), 1);

  // Past the per-bucket target it shards, always to a power of two, and always
  // enough that expected/buckets lands back under the target.
  for (const expected of [4_000_001, 33_404_316, 100_000_000]) {
    const buckets = dedupBucketCount(expected);
    assert.ok(buckets > 1, `${expected} must shard`);
    assert.equal(buckets & (buckets - 1), 0, `${buckets} must be a power of 2`);
    assert.ok(
      expected / buckets <= 4_000_000,
      `${expected} over ${buckets} buckets must fit the per-bucket target`
    );
    // And must stay clear of the ceiling that caused the outage.
    assert.ok(expected / buckets < 16_777_216);
  }
});

test("dedupBucketOf is pure in the key, so equal keys always co-locate", () => {
  // The property the whole correctness argument rests on: if equal keys could
  // land in different buckets, a duplicate would be missed and a URL silently
  // kept twice.
  for (const buckets of [2, 8, 64]) {
    for (const key of [
      `${DOMAIN}/a`,
      `${DOMAIN}/some/deep/path`,
      "",
      "not-a-url"
    ]) {
      assert.equal(
        dedupBucketOf(key, buckets),
        dedupBucketOf(key, buckets),
        "same key must always map to the same bucket"
      );
      const bucket = dedupBucketOf(key, buckets);
      assert.ok(
        Number.isInteger(bucket) && bucket >= 0 && bucket < buckets,
        `bucket ${bucket} out of range for ${buckets}`
      );
    }
  }

  // buckets === 1 is the unsharded path — everything lands in bucket 0.
  assert.equal(dedupBucketOf(`${DOMAIN}/anything`, 1), 0);
});

test("sharded dedup is byte-identical to the single-Map path", async () => {
  // Same corpus cleaned twice: once unsharded, once forced into many buckets.
  // Every reported number, the duplicates report, and the actual output bytes
  // must agree — sharding is a memory strategy, not a behaviour change.
  const locsFor = (tag: string) =>
    Array.from({ length: 40 }, (_, i) => `${DOMAIN}/${tag}/page-${i}`);
  // Deliberate cross-file overlap so dedup has real work spread across buckets.
  const shared = Array.from({ length: 25 }, (_, i) => `${DOMAIN}/shared/s-${i}`);

  const build = (tag: string) => {
    const { dir, inDir, outDir } = scratch(`shard-${tag}`);
    const files: CleanerInputFile[] = [];

    for (const [index, name] of ["a", "b", "c", "d", "e"].entries()) {
      const p = path.join(inDir, `${index}__${name}.xml`);
      // Every file re-lists `shared`, so most of it duplicates file a.
      writeFileSync(p, urlsetXml([...locsFor(name), ...shared]));
      files.push({ filename: `${name}.xml`, path: p });
    }

    return { dir, outDir, files };
  };

  const plain = build("plain");
  const shard = build("shard");

  try {
    const unsharded = await cleanWithBucketSize(
      plain.files,
      plain.outDir,
      undefined
    );
    // 1 URL per bucket forces the maximum number of buckets for this corpus.
    const sharded = await cleanWithBucketSize(shard.files, shard.outDir, "1");

    // Sanity: the fixture must actually produce duplicates, or this proves nothing.
    assert.ok(unsharded.result.duplicates_removed > 0);
    assert.equal(
      sharded.result.duplicates_removed,
      unsharded.result.duplicates_removed
    );
    assert.equal(sharded.result.files_kept, unsharded.result.files_kept);
    assert.equal(
      sharded.result.clean_urls_remaining,
      unsharded.result.clean_urls_remaining
    );
    assert.equal(
      sharded.result.total_urls_kept_files,
      unsharded.result.total_urls_kept_files
    );
    assert.equal(sharded.result.reduction_pct, unsharded.result.reduction_pct);
    assert.deepEqual(
      sharded.result.dropped_files,
      unsharded.result.dropped_files
    );
    assert.deepEqual(
      sharded.result.output_files,
      unsharded.result.output_files
    );
    // Report rows: same content AND same order as the unsharded run.
    assert.deepEqual(
      sharded.result.duplicate_urls,
      unsharded.result.duplicate_urls
    );

    // The cleaned files themselves must be byte-for-byte identical.
    for (const { filename } of unsharded.result.output_files) {
      assert.equal(
        readFileSync(path.join(shard.outDir, filename), "utf8"),
        readFileSync(path.join(plain.outDir, filename), "utf8"),
        `${filename} must be byte-identical between sharded and unsharded runs`
      );
    }

    // So must the rebuilt index and the full CSV on disk.
    for (const filename of [unsharded.result.index_filename, REPORT_FILENAME]) {
      assert.equal(
        readFileSync(path.join(shard.outDir, filename), "utf8"),
        readFileSync(path.join(plain.outDir, filename), "utf8"),
        `${filename} must be byte-identical between sharded and unsharded runs`
      );
    }

    // The scratch dir must not survive into the output handed to the user.
    assert.ok(
      !existsSync(path.join(shard.outDir, ".cleaner-scratch")),
      "the sharded scratch dir must be cleaned up, not shipped in the ZIP"
    );
  } finally {
    rmSync(plain.dir, { recursive: true, force: true });
    rmSync(shard.dir, { recursive: true, force: true });
  }
});

test("sharded dedup handles a file emptied entirely by duplicates", async () => {
  // Verdict bitsets are sized from each provisional's own line count. If a
  // file's every loc is a duplicate its bitset is all zeros, and the file must
  // drop as "empty" — the same outcome the single-Map path produces.
  const { dir, inDir, outDir } = scratch("shard-empty");

  try {
    const x = path.join(inDir, "0__x.xml");
    const y = path.join(inDir, "1__y.xml");
    writeFileSync(x, urlsetXml([`${DOMAIN}/q1`, `${DOMAIN}/q2`]));
    writeFileSync(y, urlsetXml([`${DOMAIN}/q1`, `${DOMAIN}/q2`]));

    const { result } = await cleanWithBucketSize(
      [
        { filename: "x.xml", path: x },
        { filename: "y.xml", path: y }
      ],
      outDir,
      "1"
    );

    assert.equal(result.files_kept, 1);
    assert.deepEqual(result.dropped_files, [
      { filename: "y.xml", reason: "empty" }
    ]);
    assert.equal(result.duplicates_removed, 2);
    assert.equal(result.reduction_pct, 50);
    assert.ok(!existsSync(path.join(outDir, "y.xml")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sharding also covers the sequential (sub-threshold) path", async () => {
  // The crash was NOT limited to big file COUNTS. A handful of files can hold
  // far more than 2^24 URLs between them, and that input stays under
  // CLEANER_PARALLEL_THRESHOLD (200) — so it ran the sequential engine and died
  // exactly the same way. Only 3 files here, so no worker pool is involved, and
  // the sharded two-phase machinery must still be what runs.
  const { dir, inDir, outDir } = scratch("shard-seq");

  try {
    const files: CleanerInputFile[] = [];

    for (const [index, name] of ["p", "q", "r"].entries()) {
      const p = path.join(inDir, `${index}__${name}.xml`);
      writeFileSync(
        p,
        urlsetXml([
          ...Array.from({ length: 12 }, (_, i) => `${DOMAIN}/${name}/u-${i}`),
          // Shared across all three files, so files q and r contribute dups.
          `${DOMAIN}/common/one`,
          `${DOMAIN}/common/two`
        ])
      );
      files.push({ filename: `${name}.xml`, path: p });
    }

    assert.ok(files.length < 200, "must stay under the parallel threshold");

    const sharded = await cleanWithBucketSize(files, outDir, "1");

    // 2 shared URLs duplicated in 2 later files = 4 removals, 2 groups.
    assert.equal(sharded.result.duplicates_removed, 4);
    assert.equal(sharded.result.duplicate_urls_total, 2);
    assert.equal(sharded.result.files_kept, 3);
    assert.equal(sharded.result.clean_urls_remaining, 12 * 3 + 2);

    // And it agrees with the unsharded run over the same corpus.
    const plainOut = path.join(dir, "out-plain");
    mkdirSync(plainOut, { recursive: true });
    const plain = await cleanWithBucketSize(files, plainOut, undefined);

    assert.equal(
      sharded.result.duplicates_removed,
      plain.result.duplicates_removed
    );
    assert.deepEqual(
      sharded.result.duplicate_urls,
      plain.result.duplicate_urls
    );

    for (const { filename } of plain.result.output_files) {
      assert.equal(
        readFileSync(path.join(outDir, filename), "utf8"),
        readFileSync(path.join(plainOut, filename), "utf8"),
        `${filename} must match the unsharded sequential run`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate_urls is capped while the CSV on disk stays complete", async () => {
  // The summary rides an SSE frame to the browser, so it cannot carry tens of
  // millions of rows. The cap keeps it deliverable — and the full report must
  // still be on disk, because that is what the download now serves.
  const { dir, inDir, outDir } = scratch("shard-cap");

  try {
    const locs = Array.from({ length: 60 }, (_, i) => `${DOMAIN}/c/page-${i}`);
    const a = path.join(inDir, "0__a.xml");
    const b = path.join(inDir, "1__b.xml");
    writeFileSync(a, urlsetXml(locs));
    writeFileSync(b, urlsetXml(locs)); // every loc duplicates a → 60 groups

    const { result, files } = await cleanWithBucketSize(
      [
        { filename: "a.xml", path: a },
        { filename: "b.xml", path: b }
      ],
      outDir,
      "1"
    );

    assert.equal(result.duplicates_removed, 60);
    assert.equal(result.duplicate_urls_total, 60);
    // Well under the 10,000 cap, so nothing is truncated here.
    assert.equal(result.duplicate_urls_truncated, false);
    assert.equal(result.duplicate_urls.length, 60);

    // The complete report is on disk AND in the manifest, so the download route
    // can serve it by token.
    const report = files.find((f) => f.filename === REPORT_FILENAME);
    assert.ok(report, "the duplicates report must be in the output manifest");
    const csv = readFileSync(report.path, "utf8");
    const rows = csv.trimEnd().split("\r\n");
    assert.equal(rows[0], "url,kept_in_file,duplicate_in_files");
    assert.equal(rows.length - 1, 60, "every duplicate group must be in the CSV");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
