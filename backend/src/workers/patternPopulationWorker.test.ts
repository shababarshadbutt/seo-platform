import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// The parallel enumerator's per-file scan, exercised WITHOUT a database.
//
// It needs one because the integration tests that cover enumeration
// (verifyScoping, verifyUrls) skip themselves when Postgres is unreachable, so
// on a dev box with no stack running the worker path would otherwise ship with
// nothing exercising it at all. Everything here is filesystem-only.
//
// What matters is that this produces EXACTLY what the sequential scan in
// patternPopulation.ts produces: same matches, same pattern attribution, same
// order. Anywhere the two disagree, a verification silently measures a different
// population depending on how many files the session happens to have.

const DOMAIN = "https://www.example.com";

function urlsetXml(locs: string[]) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    locs.map((loc) => `  <url><loc>${loc}</loc></url>\n`).join("") +
    "</urlset>\n"
  );
}

const dir = mkdtempSync(path.join(os.tmpdir(), "population-worker-"));

// The worker takes a STORED filename and resolves it against config.uploadDir,
// exactly as the sequential enumerator does. Set before the import below so
// config picks it up: importing first would bake in /uploads and every read
// would look for the fixtures inside it.
process.env.UPLOAD_DIR = dir;

const { default: scan } = await import("./patternPopulationWorker.js");

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

let fixtureCount = 0;

// Runs the worker over a fixture and returns the decoded provisional lines the
// main thread would read back, as [patternId, loc] pairs.
async function scanFixture(
  locs: string[],
  patterns: Array<{ id: string; template: string }>
) {
  fixtureCount += 1;
  const storedFilename = `sitemap${fixtureCount}.xml`;
  const provisionalPath = path.join(dir, `p${fixtureCount}.provisional`);

  writeFileSync(path.join(dir, storedFilename), urlsetXml(locs));

  const result = await scan({ storedFilename, provisionalPath, patterns });
  const lines = readFileSync(provisionalPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const tab = line.indexOf("\t");

      return [line.slice(0, tab), line.slice(tab + 1)] as const;
    });

  return { result, lines };
}

const PRODUCTS = { id: "pattern-products", template: "/products/{param}" };
const BLOG = { id: "pattern-blog", template: "/blog/{param}" };

test("only URLs matching a pattern are written, tagged with that pattern", async () => {
  const { result, lines } = await scanFixture(
    [
      `${DOMAIN}/products/one`,
      `${DOMAIN}/about-us`,
      `${DOMAIN}/blog/hello`,
      `${DOMAIN}/products/two`
    ],
    [PRODUCTS, BLOG]
  );

  assert.deepEqual(lines, [
    ["pattern-products", `${DOMAIN}/products/one`],
    ["pattern-blog", `${DOMAIN}/blog/hello`],
    ["pattern-products", `${DOMAIN}/products/two`]
  ]);
  // The count the main thread is told must match what is actually on disk, or a
  // truncated write would go unnoticed.
  assert.equal(result.count, lines.length);
  assert.equal(result.provisionalPath, path.join(dir, "p1.provisional"));
});

// Matches the sequential enumerator's "first matching selected template wins".
// The patterns arrive in the caller's order and the worker must not reorder them.
test("the FIRST matching template wins when two patterns overlap", async () => {
  const specific = { id: "pattern-specific", template: "/products/{param}" };
  const broad = { id: "pattern-broad", template: "/{param}/{param}" };

  const { lines } = await scanFixture([`${DOMAIN}/products/one`], [
    specific,
    broad
  ]);
  assert.deepEqual(lines, [["pattern-specific", `${DOMAIN}/products/one`]]);

  const { lines: reversed } = await scanFixture([`${DOMAIN}/products/one`], [
    broad,
    specific
  ]);
  assert.deepEqual(reversed, [["pattern-broad", `${DOMAIN}/products/one`]]);
});

test("a file with no matches produces an empty provisional and a zero count", async () => {
  const { result, lines } = await scanFixture(
    [`${DOMAIN}/about-us`, `${DOMAIN}/contact`],
    [PRODUCTS]
  );

  assert.equal(result.count, 0);
  assert.deepEqual(lines, []);
});

// Same rule as the sequential scan: a loc that is not a parseable absolute URL
// cannot be probed or matched, so it is skipped rather than failing the file.
test("an unparseable loc is skipped without losing the rest of the file", async () => {
  const { result, lines } = await scanFixture(
    [`${DOMAIN}/products/one`, "not a url", `${DOMAIN}/products/two`],
    [PRODUCTS]
  );

  assert.equal(result.count, 2);
  assert.deepEqual(lines.map(([, loc]) => loc), [
    `${DOMAIN}/products/one`,
    `${DOMAIN}/products/two`
  ]);
});

// Order within a file is what makes the parallel result identical to the
// sequential one once the main thread merges files in order.
test("matches are written in file order", async () => {
  const locs = Array.from(
    { length: 50 },
    (_, index) => `${DOMAIN}/products/p${index}`
  );
  const { lines } = await scanFixture(locs, [PRODUCTS]);

  assert.deepEqual(lines.map(([, loc]) => loc), locs);
});

// The provisional format splits on the FIRST tab, so anything tab-like in a URL
// would corrupt the pattern id. URLs cannot contain a raw tab or newline, and a
// percent-encoded one (%09) must survive untouched.
test("a percent-encoded tab in a URL does not break the line format", async () => {
  const loc = `${DOMAIN}/products/a%09b`;
  const { lines } = await scanFixture([loc], [PRODUCTS]);

  assert.deepEqual(lines, [["pattern-products", loc]]);
});

test("a missing input file rejects rather than reporting an empty scan", async () => {
  // The caller logs and skips, but it must be able to TELL — a silently empty
  // result would shrink the population with nothing said.
  await assert.rejects(
    scan({
      storedFilename: "does-not-exist.xml",
      provisionalPath: path.join(dir, "missing.provisional"),
      patterns: [PRODUCTS]
    })
  );
});
