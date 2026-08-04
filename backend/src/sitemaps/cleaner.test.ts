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
import {
  CleanerCapacityError,
  dedupLedger,
  resetDedupLedgerForTest,
  setDedupBudgetForTest
} from "./dedupBudget.js";

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

type ReportRow = { url: string; kept_in: string; duplicate_in: string };

type RunResult = {
  survivors: { filename: string; url_count: number }[];
  dropped: { filename: string; reason: DropReason }[];
  duplicates_removed: number;
  // The rows the duplicates report RECEIVED, in the order it received them.
  // Since v1.48 the report is streamed one row per duplicate occurrence rather
  // than accumulated in a Map, so the ordering guarantee has to be asserted on
  // the emitted sequence — which is a stronger check than the old grouped
  // snapshot: it would catch a reordering that a per-URL grouping hid.
  report_rows: ReportRow[];
  outDir: string;
};

async function run(
  concurrency: number,
  delayFor: (index: number) => number
): Promise<RunResult> {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-order-"));
  const provDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-prov-"));
  const reportRows: ReportRow[] = [];
  const state = createDedupState({
    report: {
      writeRow: (url, kept_in, duplicate_in) =>
        reportRows.push({ url, kept_in, duplicate_in })
    }
  });
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
    report_rows: reportRows,
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
  // One row per duplicate OCCURRENCE, in file order — so the row count equals
  // duplicates_removed (4), which the old URL-grouped form could not express.
  const expectedDuplicates: ReportRow[] = [
    { url: `${HOST}/dup/`, kept_in: "a.xml", duplicate_in: "b.xml" },
    { url: `${HOST}/dup`, kept_in: "a.xml", duplicate_in: "c.xml" },
    { url: `${HOST}/x`, kept_in: "a.xml", duplicate_in: "d.xml" },
    { url: `${HOST}/y`, kept_in: "a.xml", duplicate_in: "d.xml" }
  ];

  // Reference matches the hand-computed first-wins expectation.
  assert.deepEqual(reference.survivors, expectedSurvivors);
  assert.deepEqual(reference.dropped, expectedDropped);
  assert.equal(reference.duplicates_removed, 4);
  assert.deepEqual(reference.report_rows, expectedDuplicates);
  assert.equal(reference.report_rows.length, reference.duplicates_removed);

  // Scrambled completion is identical in every reported dimension...
  assert.deepEqual(scrambled.survivors, reference.survivors);
  assert.deepEqual(scrambled.dropped, reference.dropped);
  assert.equal(scrambled.duplicates_removed, reference.duplicates_removed);
  assert.deepEqual(scrambled.report_rows, reference.report_rows);

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

// ---- v1.48: dedup memory budget + streamed duplicates report ---------------

// The report is no longer built from an in-memory Map, so the thing to prove is
// that the FILE is still correct — right header, right rows, right order — and
// that its row count matches duplicates_removed (which the old URL-grouped form
// could not, since it collapsed N occurrences into one row).
test("the duplicates report is streamed to disk with one row per occurrence", async () => {
  const { dir, inDir, outDir } = scratch("report");

  try {
    const a = path.join(inDir, "a.xml");
    const b = path.join(inDir, "b.xml");
    const c = path.join(inDir, "c.xml");
    writeFileSync(a, urlsetXml([`${DOMAIN}/p1`, `${DOMAIN}/p2`]));
    writeFileSync(b, urlsetXml([`${DOMAIN}/p1`, `${DOMAIN}/p3`]));
    writeFileSync(c, urlsetXml([`${DOMAIN}/p1`, `${DOMAIN}/p2`]));

    const { result, files } = await cleanSitemaps({
      files: [
        { filename: "a.xml", path: a },
        { filename: "b.xml", path: b },
        { filename: "c.xml", path: c }
      ],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });

    // p1 duplicated in b and c, p2 duplicated in c → 3 occurrences.
    assert.equal(result.duplicates_removed, 3);

    const csv = readFileSync(path.join(outDir, "duplicates-report.csv"), "utf8");
    const lines = csv.trim().split("\r\n");

    assert.equal(lines[0], "url,kept_in_file,duplicate_in_file");
    assert.deepEqual(lines.slice(1), [
      `${DOMAIN}/p1,a.xml,b.xml`,
      `${DOMAIN}/p1,a.xml,c.xml`,
      `${DOMAIN}/p2,a.xml,c.xml`
    ]);

    // Row count matches the counter — the property the grouped form lacked.
    assert.equal(lines.length - 1, result.duplicates_removed);

    // And the report is still in the manifest so it reaches the ZIP.
    assert.ok(files.some((f) => f.filename === "duplicates-report.csv"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The summary must NOT carry the rows any more. This is the memory win: a run
// with millions of duplicates used to return all of them (plus hold a Map of
// them) purely so the browser could rebuild a CSV that already existed on disk.
test("the summary does not carry the duplicate rows", async () => {
  const { dir, inDir, outDir } = scratch("nocopy");

  try {
    const a = path.join(inDir, "a.xml");
    const b = path.join(inDir, "b.xml");
    writeFileSync(a, urlsetXml([`${DOMAIN}/q1`]));
    writeFileSync(b, urlsetXml([`${DOMAIN}/q1`]));

    const { result } = await cleanSitemaps({
      files: [
        { filename: "a.xml", path: a },
        { filename: "b.xml", path: b }
      ],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });

    assert.equal(result.duplicates_removed, 1);
    assert.equal(
      (result as unknown as Record<string, unknown>).duplicate_urls,
      undefined,
      "duplicate_urls must be gone — the CSV on disk is the only copy"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The real fix, end to end: an oversized run is REFUSED with an actionable
// message instead of aborting the process. Before this, the only outcome
// available at the heap limit was `FATAL ERROR: Reached heap limit` — which is
// uncatchable, so it took every concurrent run down with it and could not be
// turned into a message at all.
test("a run over the dedup budget fails with a clear error, not a heap abort", async () => {
  const { dir, inDir, outDir } = scratch("budget");

  // Shrink the budget so a handful of URLs exceeds it. Sizing this via the
  // public seam rather than allocating gigabytes is the only way to exercise the
  // guard in a test that anyone will actually run.
  setDedupBudgetForTest(200);
  resetDedupLedgerForTest();

  try {
    const a = path.join(inDir, "a.xml");
    writeFileSync(
      a,
      urlsetXml(
        Array.from({ length: 200 }, (_, i) => `${DOMAIN}/budget-probe-${i}`)
      )
    );

    const error = await cleanSitemaps({
      files: [{ filename: "a.xml", path: a }],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    }).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(
      error instanceof CleanerCapacityError,
      `expected CleanerCapacityError, got ${String(error)}`
    );
    // The message has to be actionable: it names the count and the ceiling.
    assert.match(error.message, /unique URLs/);
    assert.match(error.message, /smaller batches|max-old-space-size/);

    // And the charge is released, so the failure does not shrink the budget for
    // every later run — a leak here would need a restart to recover.
    assert.equal(dedupLedger().totalBytes, 0);
    assert.equal(dedupLedger().runs, 0);

    // The report's write stream is opened BEFORE the point that throws, so the
    // refusal path has to close it too. An unclosed stream per refused run is an
    // fd leak — fd exhaustion reached by way of the guard meant to prevent an
    // outage. A readable file with its header flushed proves it was ended.
    const csv = readFileSync(path.join(outDir, "duplicates-report.csv"), "utf8");
    assert.match(csv, /^url,kept_in_file,duplicate_in_file/);
  } finally {
    setDedupBudgetForTest(null);
    resetDedupLedgerForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A normal run must leave the ledger clean too, or the budget bleeds away one
// successful run at a time.
test("a successful run releases its dedup charge", async () => {
  const { dir, inDir, outDir } = scratch("release");
  resetDedupLedgerForTest();

  try {
    const a = path.join(inDir, "a.xml");
    writeFileSync(a, urlsetXml([`${DOMAIN}/r1`, `${DOMAIN}/r2`]));

    await cleanSitemaps({
      files: [{ filename: "a.xml", path: a }],
      domain: DOMAIN,
      subfolder: "sitemaps",
      today: TODAY,
      outDir
    });

    assert.equal(dedupLedger().totalBytes, 0);
    assert.equal(dedupLedger().runs, 0);
  } finally {
    resetDedupLedgerForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});
