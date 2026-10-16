// A synthetic <urlset> string built from a plain URL list, with no <lastmod>.
// Used for small, bounded lists only — e.g. sessions.ts's download-failed-urls
// and sitemapCategorizer.ts's download-404s, both capped well below the sizes
// that would make building one in-memory string a problem (see those call
// sites' own comments). The sitemap-regenerate wizard's CSV upload, which
// used to build its (potentially 1M+ row) URL list this same way synchronously
// inside an HTTP request handler, no longer does — see
// jobs/csvUploadIngestJob.ts / sitemaps/csvLegacyChunkFiles.ts, which instead
// write chunked files in parallel via the existing sitemapGeneratePool piscina
// worker (already streaming-write, no giant string).

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

export function buildSyntheticSitemapXml(urls: string[]): string {
  let xml = URLSET_HEADER;

  for (const url of urls) {
    xml += `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>\n`;
  }

  return xml + URLSET_FOOTER;
}
