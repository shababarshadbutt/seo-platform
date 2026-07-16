import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { config } from "../config.js";
import { detectForeignHostInFile, hostFromLoc } from "./domainScan.js";

// detectForeignHostInFile reads from config.uploadDir; point it at a temp dir
// for the duration of this suite and restore afterwards.
let tmpDir: string;
let originalUploadDir: string;

async function writeSitemap(filename: string, locs: string[]) {
  const body = locs.map((loc) => `  <url><loc>${loc}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

  await writeFile(path.join(tmpDir, filename), xml, "utf8");

  return filename;
}

before(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "domainscan-"));
  originalUploadDir = config.uploadDir;
  config.uploadDir = tmpDir;
});

after(async () => {
  config.uploadDir = originalUploadDir;
  await rm(tmpDir, { recursive: true, force: true });
});

describe("hostFromLoc", () => {
  test("normalizes http(s) hosts and drops leading www.", () => {
    assert.equal(hostFromLoc("https://www.example.com/a"), "example.com");
    assert.equal(hostFromLoc("http://Shop.Example.com/a"), "shop.example.com");
  });

  test("returns null for non-http locs", () => {
    assert.equal(hostFromLoc("mailto:x@example.com"), null);
    assert.equal(hostFromLoc("/relative/path"), null);
    assert.equal(hostFromLoc("not a url"), null);
  });
});

describe("detectForeignHostInFile", () => {
  test("accepts a file whose URLs are all same-site", async () => {
    const file = await writeSitemap("clean.xml", [
      "https://industrialsurge.com/a/",
      "https://www.industrialsurge.com/b/",
      "https://shop.industrialsurge.com/c/"
    ]);

    assert.equal(await detectForeignHostInFile(file, "industrialsurge.com"), null);
  });

  test("flags a foreign domain that appears only LATE in the file (the peek bug)", async () => {
    // 1,000 legitimate same-site URLs, then a single foreign URL far past any
    // first-few-KB sample window. A peek-based check misses this; a full stream
    // must catch it.
    const locs = Array.from(
      { length: 1000 },
      (_, i) => `https://industrialsurge.com/rfq/part-${i}/`
    );
    locs.push("https://industrialautomationpartsworld.com/rfq/part-x/");

    const file = await writeSitemap("industrial-rfq-17.xml", locs);

    assert.equal(
      await detectForeignHostInFile(file, "industrialsurge.com"),
      "industrialautomationpartsworld.com"
    );
  });

  test("flags a foreign domain on the very first URL too", async () => {
    const file = await writeSitemap("foreign-first.xml", [
      "https://industrialautomationpartsworld.com/rfq/part-1/",
      "https://industrialsurge.com/rfq/part-2/"
    ]);

    assert.equal(
      await detectForeignHostInFile(file, "industrialsurge.com"),
      "industrialautomationpartsworld.com"
    );
  });

  test("treats subdomains of the base host as same-site", async () => {
    const file = await writeSitemap("subdomain.xml", [
      "https://parts.industrialsurge.com/a/",
      "https://industrialsurge.com/b/"
    ]);

    assert.equal(await detectForeignHostInFile(file, "industrialsurge.com"), null);
  });

  test("look-alike hosts are still foreign", async () => {
    const file = await writeSitemap("lookalike.xml", [
      "https://industrialsurge.com/a/",
      "https://notindustrialsurge.com/b/"
    ]);

    assert.equal(
      await detectForeignHostInFile(file, "industrialsurge.com"),
      "notindustrialsurge.com"
    );
  });
});
