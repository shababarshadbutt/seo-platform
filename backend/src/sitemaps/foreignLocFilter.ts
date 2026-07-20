import { createReadStream } from "node:fs";
import { PassThrough, type Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";

import { UrlBlockFilterTransform } from "./deleteUrls.js";
import { hostFromLoc, isSameDomain } from "./domain.js";

// Stats reported for one filtered file once its stream ends. `keptCount` /
// `removedCount` come from the filter transform (how many <url> blocks survived
// vs were dropped as foreign-domain); `bytesOut` is the total bytes emitted.
// Used by the download-ZIP diagnostics to tell a stream-truncated file (bytesOut
// far below the source size, output cut mid-content) apart from a domain-stripped
// one (keptCount === 0, output a valid but near-empty <urlset>).
export type ForeignLocFilterStats = {
  bytesOut: number;
  keptCount: number;
  removedCount: number;
};

// Wire up the read → (gunzip →) filter (→ gzip) pipeline and return both the
// output stream and the filter transform (so callers can read its kept/removed
// counts). Shared by the eager and lazy entry points below.
function buildForeignLocFilterPipeline(options: {
  inputPath: string;
  isGzip: boolean;
  expectedHost: string;
}): { output: Readable; transform: UrlBlockFilterTransform } {
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

    return { output: gzip, transform };
  }

  readable.on("error", (error) => transform.destroy(error));
  readable.pipe(transform);

  return { output: transform, transform };
}

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
  return buildForeignLocFilterPipeline(options).output;
}

// Same output as streamSitemapWithoutForeignLocs, but the underlying file
// descriptor and filter pipeline are NOT opened until a consumer first reads
// from the returned stream. Use this when appending many files to a single
// archiver in a loop: archiver consumes appended sources one at a time, so a
// lazy source keeps only one file open/flowing at a time. Creating the sources
// eagerly (calling streamSitemapWithoutForeignLocs directly in the loop) opens
// every file and starts every pipeline flowing before archiver reaches it,
// which overruns archiver's queue and silently truncates the later entries to
// near-empty. Mirrors the lazystream wrapper archiver itself uses for
// archive.file(). See buildSessionZipArchive.
//
// `onComplete` (optional) fires once the file has fully streamed, with the
// bytes emitted and the transform's kept/removed counts — used only by the
// download-ZIP diagnostics.
export function lazyStreamSitemapWithoutForeignLocs(options: {
  inputPath: string;
  isGzip: boolean;
  expectedHost: string;
  onComplete?: (stats: ForeignLocFilterStats) => void;
}): Readable {
  const pass = new PassThrough();
  let started = false;
  let transform: UrlBlockFilterTransform | null = null;
  let bytesOut = 0;
  const originalRead = pass._read.bind(pass);

  pass._read = (size: number) => {
    if (!started) {
      started = true;
      const pipeline = buildForeignLocFilterPipeline(options);
      transform = pipeline.transform;
      pipeline.output.on("error", (error) => pass.destroy(error));
      pipeline.output.pipe(pass);
    }

    originalRead(size);
  };

  if (options.onComplete) {
    pass.on("data", (chunk: Buffer | string) => {
      bytesOut += Buffer.byteLength(chunk);
    });
    pass.on("end", () => {
      options.onComplete?.({
        bytesOut,
        keptCount: transform?.keptCount ?? 0,
        removedCount: transform?.removedCount ?? 0
      });
    });
  }

  return pass;
}
