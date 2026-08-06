import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  applyStructureFilterToRewriter,
  clusterParamValues,
  detectPatternStructures,
  isValidStructureFilter,
  resolveStructureFilter,
  segmentMatchesAnchor,
  structureFilterSegmentIndex,
  urlMatchesStructureFilter
} from "./structureClusters.js";

// ---- Clustering: the three real-world validation cases ---------------------
// These value sets mirror the data the algorithm was validated against: the
// live nsnstocks.com packed slugs and the acquireelectrical session's
// pattern_urls. They are the acceptance cases — do not weaken them.

function packedSlugs(section: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${section}-${i + 11}`);
}

test("nsnstocks /nsn/{param}: four prefix-anchored structures, none lost", () => {
  const values = [
    ...packedSlugs("niin-parts", 89),
    ...packedSlugs("part-types", 89),
    ...packedSlugs("nsn-parts", 89),
    ...packedSlugs("cage-codes", 89)
  ];
  const clusters = clusterParamValues(values);

  assert.equal(clusters.length, 4);
  assert.deepEqual(
    clusters.map((cluster) => cluster.label).sort(),
    [
      "cage-codes-{var}",
      "niin-parts-{var}",
      "nsn-parts-{var}",
      "part-types-{var}"
    ]
  );

  for (const cluster of clusters) {
    assert.equal(cluster.urlCount, 89);
    assert.equal(cluster.anchor?.direction, "prefix");
  }
});

test("acquireelectrical /manufacturer/{param}: ONE suffix-anchored structure", () => {
  // Real shape: <manufacturer-name>-parts-catalog — the manufacturer prefix is
  // free-form (hundreds of distinct names), the suffix is the invariant.
  const manufacturers = [
    "integrated-device-technology",
    "intronics",
    "stelvio-kontek-spa",
    "molex-incorporated",
    "phoenix-contact",
    "samtec-inc",
    "3m-electronics",
    "amphenol",
    "erni-electronics",
    "lightel-technologies-inc"
  ];
  // Enough distinct prefixes that a left anchor cannot form (ratio > 0.5).
  const values = Array.from({ length: 500 }, (_, i) => {
    const name = manufacturers[i % manufacturers.length];
    return `${name}-${i}-parts-catalog`;
  });
  const clusters = clusterParamValues(values);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].label, "{var}-parts-catalog");
  assert.equal(clusters[0].anchor?.direction, "suffix");
  assert.equal(clusters[0].urlCount, 500);
});

test("free-form slugs (rfq manufacturers/part numbers) do NOT split", () => {
  // Mirror /rfq/{param}/{param}: high-cardinality values, no shared anchor.
  const values = Array.from({ length: 400 }, (_, i) => `slug-x${i}-y${i * 7}`);
  // "slug" would be a universal prefix — so use truly distinct first tokens:
  const freeform = values.map((v, i) => `${i}${v}`);
  const clusters = clusterParamValues(freeform);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].label, "{param}");
  assert.equal(clusters[0].anchor, null);
  assert.equal(clusters[0].urlCount, 400);
});

test("page-{n} second position clusters as one prefix structure", () => {
  const values = Array.from({ length: 1000 }, (_, i) => `page-${i + 1}`);
  const clusters = clusterParamValues(values);

  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].label, "page-{var}");
  assert.equal(clusters[0].anchor?.direction, "prefix");
});

test("sub-support strays fold into the residual bucket", () => {
  const values = [...packedSlugs("niin-parts", 50), "one-off-slug"];
  const clusters = clusterParamValues(values);

  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].label, "niin-parts-{var}");
  assert.equal(clusters[0].urlCount, 50);
  assert.equal(clusters[1].label, "{param} (other)");
  assert.equal(clusters[1].anchor, null);
  assert.equal(clusters[1].urlCount, 1);
});

test("detectPatternStructures maps clusters to each {param} slot", () => {
  const paths = [
    ...packedSlugs("niin-parts", 10).map((slug) => `/nsn/${slug}/`),
    ...packedSlugs("cage-codes", 10).map((slug) => `/nsn/${slug}/`)
  ];
  const positions = detectPatternStructures("/nsn/{param}", paths);

  assert.equal(positions.length, 1);
  assert.equal(positions[0].segmentIndex, 1);
  assert.equal(positions[0].paramIndex, 0);
  assert.equal(positions[0].clusters.length, 2);
});

// ---- Filter validation / resolution ----------------------------------------

test("isValidStructureFilter accepts the wire shape and rejects junk", () => {
  assert.equal(
    isValidStructureFilter({ param_index: 0, anchor: "prefix", value: "niin-parts" }),
    true
  );
  assert.equal(
    isValidStructureFilter({ param_index: -1, anchor: "prefix", value: "x" }),
    false
  );
  assert.equal(
    isValidStructureFilter({ param_index: 0, anchor: "middle", value: "x" }),
    false
  );
  assert.equal(
    isValidStructureFilter({ param_index: 0, anchor: "suffix", value: "  " }),
    false
  );
  assert.equal(isValidStructureFilter(null), false);
});

test("structureFilterSegmentIndex resolves param ordinals across templates", () => {
  assert.equal(structureFilterSegmentIndex("/nsn/{param}", 0), 1);
  assert.equal(structureFilterSegmentIndex("/nsn/niin/{param}", 0), 2);
  assert.equal(structureFilterSegmentIndex("/a/{param}/b/{param}", 1), 3);
  assert.equal(structureFilterSegmentIndex("/nsn/{param}", 1), null);
});

test("segmentMatchesAnchor is token-boundary aware", () => {
  assert.equal(segmentMatchesAnchor("niin-parts-24", "prefix", "niin-parts"), true);
  // Raw startsWith would accept this; token matching must not.
  assert.equal(segmentMatchesAnchor("niin-partsx-24", "prefix", "niin-parts"), false);
  assert.equal(
    segmentMatchesAnchor("molex-parts-catalog", "suffix", "parts-catalog"),
    true
  );
  assert.equal(
    segmentMatchesAnchor("molex-parts-catalogs", "suffix", "parts-catalog"),
    false
  );
  assert.equal(segmentMatchesAnchor("niin-parts", "prefix", "niin-parts"), true);
});

// ---- Scoped rewriting -------------------------------------------------------

test("scoped rewriter touches only the filtered structure's URLs", () => {
  const filter = resolveStructureFilter(
    { param_index: 0, anchor: "prefix", value: "niin-parts" },
    "/nsn/{param}"
  );

  assert.ok(filter);
  assert.equal(filter.segmentIndex, 1);

  // A rewriter that would rewrite EVERYTHING — the guard must gate it.
  const rewriteAll = (url: string) => url.replace("/nsn/", "/nsn-new/");
  const scoped = applyStructureFilterToRewriter(rewriteAll, filter);

  assert.equal(
    scoped("https://www.nsnstocks.com/nsn/niin-parts-24/"),
    "https://www.nsnstocks.com/nsn-new/niin-parts-24/"
  );
  // Sibling structures in the SAME pattern pass through untouched.
  assert.equal(scoped("https://www.nsnstocks.com/nsn/part-types-825/"), null);
  assert.equal(scoped("https://www.nsnstocks.com/nsn/cage-codes-42/"), null);
  // Unparseable / out-of-range URLs pass through.
  assert.equal(scoped("not-a-url"), null);
  assert.equal(scoped("https://www.nsnstocks.com/"), null);
});

test("urlMatchesStructureFilter suffix scoping", () => {
  const filter = resolveStructureFilter(
    { param_index: 0, anchor: "suffix", value: "parts-catalog" },
    "/manufacturer/{param}"
  );

  assert.ok(filter);
  assert.equal(
    urlMatchesStructureFilter(
      "https://example.com/manufacturer/molex-parts-catalog/",
      filter
    ),
    true
  );
  assert.equal(
    urlMatchesStructureFilter(
      "https://example.com/manufacturer/molex-price-list/",
      filter
    ),
    false
  );
});

test("null filter leaves the rewriter unscoped", () => {
  const rewriter = (url: string) => `${url}!`;
  assert.equal(applyStructureFilterToRewriter(rewriter, null)("x://y"), "x://y!");
});
