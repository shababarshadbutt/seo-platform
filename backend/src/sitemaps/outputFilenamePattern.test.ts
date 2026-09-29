import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_FILENAME_TEMPLATE,
  pickCollisionFreeTemplate,
  renderOutputFilename,
  validateFilenameTemplate
} from "./outputFilenamePattern.js";

test("renderOutputFilename substitutes {n} and forces a single .xml extension", () => {
  assert.equal(renderOutputFilename(DEFAULT_FILENAME_TEMPLATE, 1), "sitemap-1.xml");
  assert.equal(renderOutputFilename(DEFAULT_FILENAME_TEMPLATE, 12), "sitemap-12.xml");
  assert.equal(renderOutputFilename("niin/rfq-{n}", 1), "niin/rfq-1.xml");
  assert.equal(renderOutputFilename("niin/rfq-{n}", 2), "niin/rfq-2.xml");
});

test("validateFilenameTemplate accepts the default and a one-folder-level custom stem", () => {
  assert.deepEqual(validateFilenameTemplate(DEFAULT_FILENAME_TEMPLATE), { ok: true });
  assert.deepEqual(validateFilenameTemplate("niin/rfq-{n}"), { ok: true });
});

test("validateFilenameTemplate rejects a missing or duplicated placeholder", () => {
  assert.equal(validateFilenameTemplate("sitemap.xml").ok, false);
  assert.equal(validateFilenameTemplate("sitemap-{n}-{n}.xml").ok, false);
});

test("validateFilenameTemplate rejects path escapes and a leading slash", () => {
  assert.equal(validateFilenameTemplate("/sitemap-{n}.xml").ok, false);
  assert.equal(validateFilenameTemplate("../sitemap-{n}.xml").ok, false);
  assert.equal(validateFilenameTemplate("a/b/sitemap-{n}.xml").ok, false);
});

test("validateFilenameTemplate rejects unsafe characters", () => {
  assert.equal(validateFilenameTemplate("sitemap {n}.xml").ok, false);
  assert.equal(validateFilenameTemplate("sitemap-{n}?.xml").ok, false);
});

test("pickCollisionFreeTemplate returns the batch unchanged when nothing collides", () => {
  const result = pickCollisionFreeTemplate(
    DEFAULT_FILENAME_TEMPLATE,
    3,
    new Set(["other.xml"])
  );

  assert.equal(result.renamed, false);
  assert.deepEqual(result.filenames, [
    "sitemap-1.xml",
    "sitemap-2.xml",
    "sitemap-3.xml"
  ]);
});

test("pickCollisionFreeTemplate backs off the WHOLE batch together on collision", () => {
  const result = pickCollisionFreeTemplate(
    DEFAULT_FILENAME_TEMPLATE,
    2,
    new Set(["sitemap-1.xml"])
  );

  assert.equal(result.renamed, true);
  assert.deepEqual(result.filenames, ["sitemap-v2-1.xml", "sitemap-v2-2.xml"]);
});

test("pickCollisionFreeTemplate keeps bumping the version until nothing collides", () => {
  const result = pickCollisionFreeTemplate(
    DEFAULT_FILENAME_TEMPLATE,
    1,
    new Set(["sitemap-1.xml", "sitemap-v2-1.xml"])
  );

  assert.deepEqual(result.filenames, ["sitemap-v3-1.xml"]);
});
