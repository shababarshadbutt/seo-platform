// sitemap-index.xml for the Sitemap Categorizer tool.
//
// Adapted from buildSitemapIndexXml (routes/sessions.ts), with the
// indexStoredFilename / detectIndexBasePath legacy-layout detection dropped:
// that logic exists to match an EXISTING index's base path on a site this
// tool pulled from and partially regenerated. This tool always writes a
// brand-new output set from scratch, so there is no existing layout to match
// — basePath is a plain, fixed convention instead.

const DEFAULT_BASE_PATH = "/sitemaps/";

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildCategorizerSitemapIndexXml(options: {
  baseUrl: string;
  displayNames: string[];
  today: string;
  basePath?: string;
}): string {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  let basePath = options.basePath ?? DEFAULT_BASE_PATH;

  if (!basePath.startsWith("/")) {
    basePath = `/${basePath}`;
  }

  if (!basePath.endsWith("/")) {
    basePath = `${basePath}/`;
  }

  const entries = options.displayNames
    .map(
      (name) =>
        `  <sitemap>\n    <loc>${escapeXml(
          `${baseUrl}${basePath}${name}`
        )}</loc>\n    <lastmod>${options.today}</lastmod>\n  </sitemap>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}
