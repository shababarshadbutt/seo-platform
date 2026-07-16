import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";

import { UrlBlockFilterTransform } from "./deleteUrls.js";
import { hostFromLoc, isSameDomain } from "./domain.js";

// Return a lazily-streamed readable of `inputPath` with every <url> block whose
// <loc> host is a DIFFERENT site than `expectedHost` removed; same-site locs
// (and any non-http loc, which is never a cross-domain signal) pass through
// byte-for-byte. Used when building the download ZIP so foreign-domain URLs that
// were accepted at upload (and filtered out of pattern extraction) are also kept
// out of the corrected sitemaps the SEO team downloads. Domain-based, so it
// excludes ALL foreign locs even in large files whose mismatch COUNT was only
// sampled during extraction. Streams a bounded single <url> block at a time —
// the file is never fully buffered.
export function streamSitemapWithoutForeignLocs(options: {
  inputPath: string;
  isGzip: boolean;
  expectedHost: string;
}): Readable {
  const { inputPath, isGzip, expectedHost } = options;
  const transform = new UrlBlockFilterTransform((loc) => {
    if (loc === null) {
      return false;
    }

    const host = hostFromLoc(loc);

    return host !== null && !isSameDomain(host, expectedHost);
  });

  const readable = createReadStream(inputPath);

  if (isGzip) {
    const gunzip = createGunzip();
    const gzip = createGzip();

    readable.on("error", (error) => gunzip.destroy(error));
    gunzip.on("error", (error) => transform.destroy(error));
    transform.on("error", (error) => gzip.destroy(error));
    readable.pipe(gunzip).pipe(transform).pipe(gzip);

    return gzip;
  }

  readable.on("error", (error) => transform.destroy(error));
  readable.pipe(transform);

  return transform;
}
