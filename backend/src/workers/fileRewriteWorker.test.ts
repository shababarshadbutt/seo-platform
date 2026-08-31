import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import fileRewrite from "./fileRewriteWorker.js";

// THE WORKER-THREAD SPEC IS WHERE APPLY CAPABILITIES GO TO DIE.
//
// A wide pattern rewrites its files through this pool, so a capability the spec
// cannot carry is a capability the normal path silently lacks. That has happened
// twice. v1.79 found the queued apply applying neither verified destinations nor
// per-shape rules, because the payload had nowhere to put them — and v1.77 had
// already made the queued path the one almost every apply takes. The reported
// 653-file pattern goes through here.
//
// So the pattern-wide rule (v1.90) is asserted at THIS boundary specifically,
// not only through the route. The parity integration test pins the parallel
// threshold at 1000 to force both of its runs in-process, which means nothing
// there crosses this edge.

const dir = mkdtempSync(path.join(os.tmpdir(), "file-rewrite-worker-"));

const BASE = "https://www.nsnfulfillment.com";
const TEMPLATE = "/aviation/{param}/{param}/{param}";

// Four segments, so a member of TEMPLATE. Distinct valueShapes, as in the real
// pattern — vendor names and part numbers of different layouts.
const MEMBERS = [
  BASE + "/aviation/rfq/textron-inc/95-23218/",
  BASE + "/aviation/rfq/bell-industries-inc/t103228-101/",
  BASE + "/aviation/rfq/avx-corp/1210zd106kata/"
];

// Three segments — another pattern's URL, sharing the file. The rule below
// transforms this string happily; only the template stops it.
const NEIGHBOUR = BASE + "/aviation/rfq/curtiss-wright-corp/";

after(() => rmSync(dir, { recursive: true, force: true }));

function writeSitemap(name: string, urls: string[]): string {
  const file = path.join(dir, name);

  writeFileSync(
    file,
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
      urls.map((url) => "  <url><loc>" + url + "</loc></url>").join("\n") +
      "\n</urlset>\n",
    "utf8"
  );

  return file;
}

test("the spec carries a pattern-wide rule across the thread edge", async () => {
  const inputPath = writeSitemap("in-1.xml", [...MEMBERS, NEIGHBOUR]);
  const outputPath = path.join(dir, "out-1.xml");

  const result = await fileRewrite({
    inputPath,
    outputPath,
    isGzip: false,
    spec: {
      kind: "redirectApply",
      replacements: [],
      rule: null,
      shapeRules: null,
      patternTemplate: TEMPLATE,
      patternRule: { kind: "replace", find: "aviation/", replace: "" }
    }
  });

  const out = readFileSync(outputPath, "utf8");

  // EVERY member, with no per-shape rule for any of them. This is the reported
  // case: thousands of shapes, 25 answerable per pass, one answer that fits all.
  assert.equal(result.rewrittenCount, MEMBERS.length);

  for (const url of MEMBERS) {
    assert.ok(out.includes(url.replace("/aviation/", "/")), url + " rewritten");
    assert.ok(!out.includes(url), url + " no longer present");
  }

  // THE GUARD. Byte-identical, even though the rule matches its text.
  assert.ok(
    out.includes(NEIGHBOUR),
    NEIGHBOUR + " belongs to another pattern and must not move"
  );

  // And nothing is reported as left behind, because nothing was.
  assert.equal(result.skipped.skippedInScope, 0);
});

test("without a template the rule is not applied at all", async () => {
  const inputPath = writeSitemap("in-2.xml", [...MEMBERS, NEIGHBOUR]);
  const outputPath = path.join(dir, "out-2.xml");

  // BOTH HALVES OR NEITHER. A pattern-wide sweep with no template would edit
  // every <loc> in a shared sitemap file, including patterns nobody was looking
  // at — and it would look like a success. The route and the job both refuse to
  // build such a request; this pins the worker's own half of that guard, since it
  // is the only place the two fields arrive separately over a clone boundary.
  const result = await fileRewrite({
    inputPath,
    outputPath,
    isGzip: false,
    spec: {
      kind: "redirectApply",
      replacements: [],
      rule: null,
      shapeRules: null,
      patternRule: { kind: "replace", find: "aviation/", replace: "" }
    }
  });

  assert.equal(result.rewrittenCount, 0, "no template, no sweep");
  assert.equal(
    readFileSync(outputPath, "utf8"),
    readFileSync(inputPath, "utf8"),
    "the file passes through byte-for-byte"
  );
});

test("a per-shape rule still beats the pattern-wide one here too", async () => {
  const inputPath = writeSitemap("in-3.xml", MEMBERS);
  const outputPath = path.join(dir, "out-3.xml");

  // Precedence is the rewriter's contract, but it has to survive the clone: the
  // spec sends shapeRules as pairs and the pattern rule as a plain object, and
  // rebuilding them in the wrong order here would let a catch-all overwrite an
  // answer somebody gave for one group.
  const result = await fileRewrite({
    inputPath,
    outputPath,
    isGzip: false,
    spec: {
      kind: "redirectApply",
      replacements: [],
      rule: null,
      shapeRules: [
        ["/a/a/a-a/99-99999/", { kind: "replace", find: "/aviation/", replace: "/av/" }]
      ],
      patternTemplate: TEMPLATE,
      patternRule: { kind: "replace", find: "aviation/", replace: "" }
    }
  });

  const out = readFileSync(outputPath, "utf8");

  assert.equal(result.rewrittenCount, MEMBERS.length);
  assert.ok(
    out.includes(BASE + "/av/rfq/textron-inc/95-23218/"),
    "the group with its own rule keeps it"
  );
  assert.ok(
    out.includes(BASE + "/rfq/avx-corp/1210zd106kata/"),
    "a group without one gets the pattern answer"
  );
});

test("with no pattern rule the spec behaves exactly as before", async () => {
  const inputPath = writeSitemap("in-4.xml", [...MEMBERS, NEIGHBOUR]);
  const outputPath = path.join(dir, "out-4.xml");

  const result = await fileRewrite({
    inputPath,
    outputPath,
    isGzip: false,
    spec: {
      kind: "redirectApply",
      replacements: [[MEMBERS[0], BASE + "/measured/"]],
      rule: null,
      shapeRules: null,
      patternTemplate: TEMPLATE
    }
  });

  assert.equal(result.rewrittenCount, 1, "only the confirmed pair");
  assert.equal(
    result.skipped.skippedInScope,
    MEMBERS.length - 1,
    "and the rest are reported as pattern members left unchanged"
  );
});
