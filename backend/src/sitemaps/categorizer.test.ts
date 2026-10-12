import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDepthBoundaryLookup,
  categorizeRegular,
  categorizeRfq,
  categorizeUrl,
  DepthBoundaryDetector,
  MAIN_FILENAME,
  pathSegmentsFromUrl,
  UNCATEGORIZED_FILENAME
} from "./categorizer.js";

// --- pathSegmentsFromUrl ----------------------------------------------------

test("pathSegmentsFromUrl splits and drops empty segments", () => {
  assert.deepEqual(
    pathSegmentsFromUrl("https://example.com/aviation/components/"),
    ["aviation", "components"]
  );
  assert.deepEqual(pathSegmentsFromUrl("https://example.com/"), []);
});

test("pathSegmentsFromUrl returns null for an unparseable URL", () => {
  assert.equal(pathSegmentsFromUrl("not a url"), null);
});

// --- categorizeRfq: the doc's 8 RFQ cases, verbatim examples ---------------

test("case 1: manufacturer RFQ (no vertical)", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.hardwaredomain.com/rfq/hawker-beechcraft/at552hnxl1-8/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-1",
    filename: "rfq.xml"
  });
});

test("case 2: product RFQ", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.stackedindustrials.com/rfq/product/safety/carhartt-inc/100791-246-54wx32l/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-2",
    filename: "safety-rfq.xml"
  });
});

test("case 3: category + part only", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.cogentpurchasing.com/aircraft-primer/rfq/aerodur-s15-90-w-s66-14/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-3",
    filename: "aircraft-primer-rfq.xml"
  });
});

test("case 4: category + manufacturer", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.asap-amspares.com/aviation/rfq/hartzell-propeller/990601053-1/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-4",
    filename: "aviation-rfq.xml"
  });
});

test("case 5: NSN + manufacturer", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.cogentpurchasing.com/nsn/rfq/aiw-aufbau-instandsetzungswerk/b0403-04-00/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-5",
    filename: "nsn-rfq.xml"
  });
});

test("case 6: NSN + vertical (13-digit NSN distinguishes it from case 5)", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.hardwaredomain.com/nsn/rfq/navair-and-navsea-managed/1210003447703/285951pc1/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-6",
    filename: "nsn-navair-and-navsea-managed-rfq.xml"
  });
});

test("case 7: parts by IPC", () => {
  const segments = pathSegmentsFromUrl(
    "https://www.aviationsourcingsolutions.com/parts-by-ipc/pma-parts/rfq/boeing-b737/beaver-aerospace-and-defense/b10047/"
  )!;

  assert.deepEqual(categorizeRfq(segments), {
    ruleId: "rfq-7",
    filename: "parts-by-ipc-pma-parts-rfq.xml"
  });
});

test("case 8 (Business Jet): no generalized rule in the doc, does not match", () => {
  // Only one ungeneralized example exists for this case, and it does not fit
  // case 3/4's segment counts (3 segments follow "rfq", not 1 or 2) — the doc
  // gives no stated filename rule, so this must fall through rather than be
  // guessed at.
  const segments = pathSegmentsFromUrl(
    "https://www.asapsemi.com/civil-aviation/rfq/beechcraft-65-a90-3/beechcraft-corporation/32-0153k/"
  )!;

  assert.equal(categorizeRfq(segments), null);
});

test("case 1 vs case 2: a literal 'product' second segment never falls back to case 1", () => {
  // Doc step 1: second segment literally "product" routes to case 2 or
  // nothing — never to case 1's /rfq/{manufacturer}/{part-no}/ shape, even
  // though a short product-RFQ-shaped URL could otherwise structurally fit it.
  assert.equal(categorizeRfq(["rfq", "product", "x"]), null);
});

test("nsn without rfq is not an RFQ case (doc step 5)", () => {
  assert.equal(categorizeRfq(["nsn", "fscs", "5805-telephone-and-telegraph-equipment"]), null);
});

// --- categorizeRegular / DepthBoundaryDetector: doc sections 3.1 / 3.2 -----

function buildBoundariesFromFixture() {
  const detector = new DepthBoundaryDetector();

  // /aviation/components/{product}/ — several distinct products, so position
  // 2 under ["aviation", "components"] resolves dynamic.
  for (const product of ["g-10-sheet", "fr-4-sheet", "phenolic-rod", "nylon-block", "peek-rod"]) {
    detector.observe(["aviation", "components", product]);
  }
  // The listing pages themselves terminate before the dynamic position, so
  // they must not be miscategorized as part of it.
  detector.observe(["aviation"]);
  detector.observe(["aviation", "components"]);

  // /manufacturer/{code}/ — position 1 under ["manufacturer"] resolves dynamic.
  for (const code of ["08b", "12k", "55x", "7qr", "zz9"]) {
    detector.observe(["manufacturer", code]);
  }
  detector.observe(["manufacturer"]);

  // /nsn/fscs/{part}/ — position 2 under ["nsn", "fscs"] resolves dynamic,
  // while ["nsn"] and ["nsn", "fscs"] alone stay static (listing pages).
  for (const part of [
    "5805-telephone-and-telegraph-equipment",
    "5810-communication-security-equipment",
    "5820-radio-and-television-equipment",
    "5826-radio-navigation-equipment",
    "5830-intercommunication-equipment"
  ]) {
    detector.observe(["nsn", "fscs", part]);
  }
  detector.observe(["nsn"]);
  detector.observe(["nsn", "fscs"]);

  return buildDepthBoundaryLookup(detector.boundaries());
}

test("homepage and L1/L2 static pages go to main.xml", () => {
  const boundaries = buildBoundariesFromFixture();

  assert.deepEqual(categorizeRegular([], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
  assert.deepEqual(categorizeRegular(["aviation"], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
  assert.deepEqual(categorizeRegular(["aviation", "components"], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
});

test("L2/L3 product pages get the dash-joined static-prefix filename", () => {
  const boundaries = buildBoundariesFromFixture();

  assert.deepEqual(
    categorizeRegular(["aviation", "components", "g-10-sheet"], boundaries),
    { ruleId: "regular", filename: "aviation-components.xml" }
  );
});

test("static-listing pages (doc 3.2) use the SAME dash-joined rule, one level deep", () => {
  const boundaries = buildBoundariesFromFixture();

  assert.deepEqual(categorizeRegular(["manufacturer"], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
  assert.deepEqual(categorizeRegular(["manufacturer", "08b"], boundaries), {
    ruleId: "regular",
    filename: "manufacturer.xml"
  });
});

test("static-listing pages (doc 3.2), two static levels deep", () => {
  const boundaries = buildBoundariesFromFixture();

  assert.deepEqual(categorizeRegular(["nsn"], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
  assert.deepEqual(categorizeRegular(["nsn", "fscs"], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
  assert.deepEqual(
    categorizeRegular(
      ["nsn", "fscs", "5805-telephone-and-telegraph-equipment"],
      boundaries
    ),
    { ruleId: "regular", filename: "nsn-fscs.xml" }
  );
});

test("a section with too little data to resolve stays static (falls to main.xml)", () => {
  const detector = new DepthBoundaryDetector();

  detector.observe(["rare-section", "only-page"]);
  const boundaries = buildDepthBoundaryLookup(detector.boundaries());

  assert.deepEqual(categorizeRegular(["rare-section", "only-page"], boundaries), {
    ruleId: "regular-main",
    filename: MAIN_FILENAME
  });
});

// --- categorizeUrl: full pipeline -------------------------------------------

test("categorizeUrl tries RFQ before depth-based categorization", () => {
  const boundaries = buildBoundariesFromFixture();

  assert.deepEqual(
    categorizeUrl("https://www.hardwaredomain.com/rfq/hawker-beechcraft/at552hnxl1-8/", boundaries),
    { ruleId: "rfq-1", filename: "rfq.xml" }
  );
});

test("categorizeUrl falls back to uncategorized for an unparseable URL", () => {
  const boundaries = buildDepthBoundaryLookup([]);

  assert.deepEqual(categorizeUrl("not a url", boundaries), {
    ruleId: "uncategorized",
    filename: UNCATEGORIZED_FILENAME
  });
});
