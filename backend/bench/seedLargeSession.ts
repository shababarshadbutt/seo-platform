// Seed a session with N sitemap files x M URLs so the pattern rename / transform
// paths can be driven at the scale that broke them. See bench/README.md.
//
// Per-file URL count matters MORE than file count here, which is the whole reason
// this exists: 900 files x 500 URLs transforms in 17s, while 823 files x 8000 URLs
// takes 136s. Sizing a repro by file count alone will tell you there is no bug.
//
// Usage: npx tsx bench/seedLargeSession.ts <fileCount> <urlsPerFile>
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";

const fileCount = Number(process.argv[2] ?? 900);
const urlsPerFile = Number(process.argv[3] ?? 500);

const BASE = "https://example.com";
// patterns.template uses a literal {param} per variable segment (rewriteLocs.ts);
// the transform STRUCTURE syntax is what uses named {A}/{B} tokens.
const TEMPLATE = "/parts/{param}/{param}";

function sitemapXml(fileIndex: number): string {
  const urls: string[] = [];

  for (let i = 0; i < urlsPerFile; i += 1) {
    const a = `cat${fileIndex % 40}`;
    const b = `item-${fileIndex}-${i}-parts-catalog`;
    urls.push(
      `  <url>\n    <loc>${BASE}/parts/${a}/${b}</loc>\n` +
        `    <lastmod>2026-01-01</lastmod>\n  </url>`
    );
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.join("\n") +
    `\n</urlset>\n`
  );
}

async function main() {
  const session = await pool.query<{ id: string }>(
    `
      INSERT INTO sessions (name, base_url, sample_size, status, upload_complete)
      VALUES ($1, $2, 10, 'COMPLETE', true)
      RETURNING id
    `,
    [`perf-${fileCount}files-${urlsPerFile}urls`, BASE]
  );
  const sessionId = session.rows[0].id;

  const pattern = await pool.query<{ id: string }>(
    `
      INSERT INTO patterns
        (session_id, template, total_urls, coverage_pct, source_role, status)
      VALUES ($1, $2, $3, 100, 'current', 'GOOD')
      RETURNING id
    `,
    [sessionId, TEMPLATE, fileCount * urlsPerFile]
  );
  const patternId = pattern.rows[0].id;

  const displayNames: string[] = [];
  const storedNames: string[] = [];

  for (let index = 0; index < fileCount; index += 1) {
    const displayName = `sitemap-${String(index).padStart(4, "0")}.xml`;
    const stored = `${sessionId}-${displayName}`;

    await writeFile(
      path.join(config.uploadDir, stored),
      sitemapXml(index),
      "utf8"
    );
    displayNames.push(displayName);
    storedNames.push(stored);
  }

  // One statement rather than N — the per-row round trips dominated seeding.
  await pool.query(
    `
      INSERT INTO sitemap_files
        (session_id, filename, total_urls, is_valid, source_role,
         extract_status, sample_status, parsed_at)
      SELECT $1, f, $2, true, 'current', 'done', 'done', now()
      FROM UNNEST($3::text[]) AS f
    `,
    [sessionId, urlsPerFile, storedNames]
  );

  // pattern_file_occurrences is what the routes use to decide which files a
  // pattern spans — every seeded file contributes to the single pattern.
  await pool.query(
    `
      INSERT INTO pattern_file_occurrences (pattern_id, source_file, occurrence_count)
      SELECT $1, f, $2 FROM UNNEST($3::text[]) AS f
    `,
    [patternId, urlsPerFile, displayNames]
  );

  await pool.query("UPDATE patterns SET source_file = $2 WHERE id = $1", [
    patternId,
    displayNames.join(",")
  ]);

  // A bounded sample, as the real pipeline would leave behind.
  for (let i = 0; i < 20; i += 1) {
    const url = `${BASE}/parts/cat${i % 40}/item-${i}-0-parts-catalog`;
    await pool.query(
      `
        INSERT INTO sampled_urls (pattern_id, url, is_hit, http_status_category)
        VALUES ($1, $2, true, 'success')
      `,
      [patternId, url]
    );
    await pool.query(
      `
        INSERT INTO pattern_urls (session_id, pattern_id, source_url, path)
        VALUES ($1, $2, $3, $4)
      `,
      [sessionId, patternId, url, new URL(url).pathname]
    );
  }

  process.stdout.write(
    JSON.stringify(
      { session_id: sessionId, pattern_id: patternId, files: fileCount },
      null,
      2
    ) + "\n"
  );
  await pool.end();
}

main().catch((error) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
