import { createWriteStream } from "node:fs";

// A synthetic <urlset> built from the sitemap-regenerate wizard's CSV URL
// list, with no <lastmod> — it is never published itself, only a vehicle to
// run the CSV's URLs through the existing extraction/sampling pipeline
// unchanged (see ingest.ts's createStoredSitemapFile, source_role "legacy").

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

// Await a writable stream fully flushing and closing. Rejects on any stream
// error so a disk-full / permission failure surfaces instead of hanging.
function finishStream(stream: import("node:fs").WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(() => resolve());
  });
}

export async function writeSyntheticSitemapXml(
  urls: string[],
  outPath: string
): Promise<void> {
  const stream = createWriteStream(outPath);
  stream.write(URLSET_HEADER);

  for (const url of urls) {
    stream.write(`  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>\n`);
  }

  stream.write(URLSET_FOOTER);
  await finishStream(stream);
}
