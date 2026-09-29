import { createWriteStream } from "node:fs";

// piscina worker: writes ONE brand-new sitemap chunk file for the
// sitemap-regenerate wizard, off the worker process's main thread, so a large
// regeneration writes several chunk files in parallel instead of one at a
// time — same convention as fileRewriteWorker.ts, but simpler: there is no
// input file to stream through, since this writes a synthesized <urlset> from
// scratch rather than rewriting an existing one copy-on-write.
//
// Pure disk work — no database access; the caller keeps every DB write on its
// own thread.
//
// Runs under tsx in a worker thread (the pool passes `--import tsx`), so it
// can import nothing beyond Node builtins — kept dependency-free rather than
// reusing cleaner.ts's escapeXml/URLSET_HEADER (which are file-local there
// too; duplicating this small a helper is the established convention, see
// csvToSitemapXml.ts).

const URLSET_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
const URLSET_FOOTER = "</urlset>\n";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function finishStream(stream: import("node:fs").WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });
}

export type SitemapGenerateUrl = {
  loc: string;
  // null omits <lastmod> entirely for this URL — the "only files containing a
  // rewritten URL" lastmod policy leaves as-is URLs in an otherwise-stamped
  // file without a <lastmod> of their own.
  lastmod: string | null;
};

export type SitemapGenerateInput = {
  outputPath: string;
  urls: SitemapGenerateUrl[];
};

export type SitemapGenerateResult = {
  writtenCount: number;
};

export default async function generateSitemapChunk(
  input: SitemapGenerateInput
): Promise<SitemapGenerateResult> {
  const stream = createWriteStream(input.outputPath);
  stream.write(URLSET_HEADER);

  for (const { loc, lastmod } of input.urls) {
    stream.write(
      lastmod
        ? `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`
        : `  <url>\n    <loc>${escapeXml(loc)}</loc>\n  </url>\n`
    );
  }

  stream.write(URLSET_FOOTER);
  await finishStream(stream);

  return { writtenCount: input.urls.length };
}
