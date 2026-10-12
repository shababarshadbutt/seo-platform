import assert from "node:assert/strict";
import { test } from "node:test";

import { renderCategoryChunkFilename } from "./categoryOutputFilename.js";

test("the first chunk is unsuffixed", () => {
  assert.equal(
    renderCategoryChunkFilename("aviation-components", 1),
    "aviation-components.xml"
  );
});

test("later chunks append their 1-based index", () => {
  assert.equal(
    renderCategoryChunkFilename("aviation-components", 2),
    "aviation-components-2.xml"
  );
  assert.equal(
    renderCategoryChunkFilename("aviation-components", 10),
    "aviation-components-10.xml"
  );
});
