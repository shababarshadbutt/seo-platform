import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { urlShape, valueShape } from "./value-shape";

test("digit-run LENGTH is preserved, letter runs collapse", () => {
  // The distinction the whole feature rests on: these two are different shapes.
  assert.equal(valueShape("/nsn/nsn-parts-12191/"), "/a/a-a-99999/");
  assert.equal(valueShape("/nsn/nsn-parts-6492/"), "/a/a-a-9999/");
  assert.equal(valueShape("/nsn/page-1-34/"), "/a/a-9-99/");
});

test("very long digit runs are capped at 12", () => {
  assert.equal(valueShape("1".repeat(20)), "9".repeat(12));
});

test("urlShape returns null rather than throwing on junk", () => {
  assert.equal(urlShape("not a url"), null);
  assert.equal(urlShape("https://x.com/a-1/"), "/a-9/");
});

test("byte-identical to the backend copy", () => {
  // This is a mirror, and the drift that matters is silent: a shape computed
  // differently here would tick a checkbox for one set of URLs and filter a
  // different set. Compared as source, like the transform-structure guard.
  const extract = (file: string) => {
    const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const start = source.indexOf("export function valueShape");

    assert.notEqual(start, -1, `valueShape not found in ${file}`);

    const end = source.indexOf("\n}\n", start);

    assert.notEqual(end, -1, `unterminated valueShape in ${file}`);

    return source.slice(start, end + 3);
  };

  assert.equal(
    extract(path.join(__dirname, "value-shape.ts")),
    extract(
      path.join(
        __dirname,
        "..",
        "..",
        "backend",
        "src",
        "sitemaps",
        "transformDryRun.ts"
      )
    )
  );
});
