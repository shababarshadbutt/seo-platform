import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildInvalidationBatches,
  cdnPathForFile,
  encodeCdnPath,
  wildcardPathFor
} from "./cdnPaths.js";

// CloudFront invalidation path rules. Pure functions — no AWS, no network.
//
// This file exists because the invalidation call had ZERO test coverage until it
// rejected a live 2,650-file publish for nsn360.com and the failure was reported
// to the SEO team as "Publish failed" on a publish where every byte had landed.

const TEMPLATE = "https://{domain}/sitemaps/{file}";

// The regression that started all of this: the code sent S3 KEYS
// ("/sites/<domain>/sitemaps/x.xml") as CDN paths while CloudFront serves
// "/sitemaps/x.xml". Those paths matched nothing, so even a SUCCESSFUL
// invalidation evicted nothing and the sitemaps stayed cached at the edge.
test("cdnPathForFile returns the served path, never the S3 key", () => {
  assert.equal(
    cdnPathForFile("nsn360.com", "aircraft-engine-parts-rfq.xml", TEMPLATE),
    "/sitemaps/aircraft-engine-parts-rfq.xml"
  );

  // The storage prefix must not appear anywhere in it.
  assert.ok(
    !cdnPathForFile("nsn360.com", "a.xml", TEMPLATE)?.includes("/sites/"),
    "the S3 key prefix must never leak into an invalidation path"
  );

  // A template serving from a different subpath than the key's — the whole
  // reason PUBLIC_SITEMAP_URL_TEMPLATE is configurable — still resolves.
  assert.equal(
    cdnPathForFile("nsn360.com", "a.xml", "https://{domain}/sitemap-files/{file}"),
    "/sitemap-files/a.xml"
  );

  // A CDN host that is not the client domain at all.
  assert.equal(
    cdnPathForFile(
      "nsn360.com",
      "a.xml",
      "https://cdn.example.net/sites/{domain}/sitemaps/{file}"
    ),
    "/sites/nsn360.com/sitemaps/a.xml"
  );

  // A template that cannot be parsed as an absolute url yields null rather than
  // silently collapsing to "/" — which as an invalidation path would purge the
  // site root.
  assert.equal(cdnPathForFile("nsn360.com", "a.xml", "/sitemaps/{file}"), null);
});

// The direct cause of the production rejection. SFTP-pulled filenames are never
// sanitized (a published object must keep its real name byte-for-byte), so odd
// names reach the invalidation call routinely — and ONE of them used to reject
// the entire batch of 2,651 paths.
test("encodeCdnPath encodes what it can and rejects what it cannot", () => {
  // Ordinary name: unchanged.
  assert.equal(encodeCdnPath("/sitemaps/a-b_c.1.xml"), "/sitemaps/a-b_c.1.xml");

  // A leading slash is added rather than rejected.
  assert.equal(encodeCdnPath("sitemaps/a.xml"), "/sitemaps/a.xml");

  // Spaces and non-ASCII bytes are percent-encoded, not refused: these are real
  // filenames on real client servers.
  assert.equal(encodeCdnPath("/sitemaps/air parts.xml"), "/sitemaps/air%20parts.xml");
  assert.equal(encodeCdnPath("/sitemaps/piñón.xml"), "/sitemaps/pi%C3%B1%C3%B3n.xml");

  // A lone "%" is not a valid escape and CloudFront rejects it. It must be
  // encoded rather than passed through (encodeURI alone leaves it).
  assert.equal(encodeCdnPath("/sitemaps/100%-off.xml"), "/sitemaps/100%25-off.xml");

  // An ALREADY-encoded path must not be double-encoded into a different path.
  assert.equal(encodeCdnPath("/sitemaps/air%20parts.xml"), "/sitemaps/air%20parts.xml");

  // Delimiters encodeURI leaves alone but CloudFront treats as path separators.
  assert.equal(encodeCdnPath("/sitemaps/a?b.xml"), "/sitemaps/a%3Fb.xml");
  assert.equal(encodeCdnPath("/sitemaps/a#b.xml"), "/sitemaps/a%23b.xml");

  // Refusals. Each of these would purge something other than the file, or
  // nothing at all.
  assert.equal(encodeCdnPath(""), null, "empty");
  assert.equal(encodeCdnPath("/"), null, "the site root");
  assert.equal(encodeCdnPath("/sitemaps/../../etc/x.xml"), null, "traversal");
  assert.equal(encodeCdnPath("/sitemaps/a*b.xml"), null, "mid-path wildcard");
  assert.equal(encodeCdnPath("/sitemaps/a\u0001b.xml"), null, "control character");

  // A trailing "*" IS meaningful — that is how the wildcard strategy works.
  assert.equal(encodeCdnPath("/sitemaps/*"), "/sitemaps/*");

  // CloudFront's documented 4,096-byte path limit.
  assert.equal(encodeCdnPath(`/sitemaps/${"a".repeat(5000)}.xml`), null, "too long");
});

// The safety property of the whole wildcard strategy. The distribution is SHARED
// with every other client site, so a distribution-wide "/*" would evict all of
// their cached content. There must be no template, however written, that
// produces one.
test("wildcardPathFor is scoped to the domain's sitemap folder and never /*", () => {
  assert.equal(
    wildcardPathFor("nsn360.com", "sitemap-index.xml", TEMPLATE),
    "/sitemaps/*"
  );

  // A nested layout keeps its full directory.
  assert.equal(
    wildcardPathFor(
      "nsn360.com",
      "sitemap-index.xml",
      "https://cdn.example.net/sites/{domain}/sitemaps/{file}"
    ),
    "/sites/nsn360.com/sitemaps/*"
  );

  // Sitemaps served from the site ROOT: the only covering wildcard would be
  // "/*", so this REFUSES and the caller falls back to exact paths. This is the
  // assertion that keeps one client's publish from purging every other client.
  assert.equal(wildcardPathFor("nsn360.com", "sitemap-index.xml", "https://{domain}/{file}"), null);

  // An unparseable template refuses too rather than guessing.
  assert.equal(wildcardPathFor("nsn360.com", "sitemap-index.xml", "/{file}"), null);
});

test("buildInvalidationBatches dedupes, chunks and reports rejects", () => {
  const paths = Array.from({ length: 2651 }, (_, index) => `/sitemaps/f${index}.xml`);

  // 2,651 paths at 1,000 per request = 3 batches. Before chunking this was a
  // single request, and CloudFront caps a non-wildcard request at 3,000 paths —
  // so a domain any larger than this could not be invalidated at all.
  const batched = buildInvalidationBatches(paths, { maxPerRequest: 1000 });

  assert.equal(batched.batches.length, 3);
  assert.equal(batched.batches[0].length, 1000);
  assert.equal(batched.batches[2].length, 651);
  assert.equal(batched.pathCount, 2651);
  assert.deepEqual(batched.rejected, []);

  // Exact-boundary behaviour.
  assert.equal(
    buildInvalidationBatches(paths.slice(0, 1000), { maxPerRequest: 1000 }).batches.length,
    1
  );
  assert.equal(
    buildInvalidationBatches(paths.slice(0, 1001), { maxPerRequest: 1000 }).batches.length,
    2
  );

  // Duplicates are billed twice and add nothing, so they collapse.
  const deduped = buildInvalidationBatches(
    ["/sitemaps/a.xml", "/sitemaps/a.xml", "sitemaps/a.xml", "/sitemaps/b.xml"],
    { maxPerRequest: 1000 }
  );

  assert.equal(deduped.pathCount, 2);
  assert.deepEqual(deduped.batches, [["/sitemaps/a.xml", "/sitemaps/b.xml"]]);

  // A name that cannot be encoded is REPORTED and the rest still batch. This is
  // the graceful-degradation property: one bad file out of 2,651 no longer
  // rejects the other 2,650.
  const withBad = buildInvalidationBatches(
    ["/sitemaps/good.xml", "/sitemaps/b*d.xml", "/sitemaps/also-good.xml"],
    { maxPerRequest: 1000 }
  );

  assert.equal(withBad.pathCount, 2);
  assert.equal(withBad.rejected.length, 1);
  assert.match(withBad.rejected[0].path, /b\*d\.xml/);
  assert.deepEqual(withBad.batches, [
    ["/sitemaps/good.xml", "/sitemaps/also-good.xml"]
  ]);

  // Nothing to do is not an error.
  assert.deepEqual(buildInvalidationBatches([], { maxPerRequest: 1000 }).batches, []);
});
