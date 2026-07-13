import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { enqueueParseSitemapJobs } from "../queue/sitemapQueue.js";
import {
  incrementParsedSitemapCount,
  isSessionCancelled,
  tryFinalizeParsedSession
} from "./sessionCompletion.js";
import { parseSitemapSource } from "../sitemaps/parser.js";
import { buildStoredUploadFilename } from "../sitemaps/filenames.js";

// The stored filename an uploaded local copy of this child sitemap would have,
// so fan-out can skip children the user already uploaded (which would otherwise
// be duplicated — once as the upload, once as a fetched URL child).
function uploadedTwinFilename(
  sessionId: string,
  childUrl: string,
  sourceRole: SitemapSourceRole
): string | null {
  try {
    const basename = new URL(childUrl).pathname.split("/").filter(Boolean).pop();

    return basename
      ? buildStoredUploadFilename(sessionId, basename, sourceRole)
      : null;
  } catch {
    return null;
  }
}

type SitemapFileRow = {
  id: string;
  session_id: string;
  filename: string;
  source_role: SitemapSourceRole;
};

type SitemapSourceRole = "current" | "legacy";

function uniqueValues(values: string[]) {
  return [...new Set(values)];
}

export async function processParseSitemapJob(
  data: { sitemap_file_id: string; session_id: string },
  logger: FastifyBaseLogger
) {
  logger.info(
    {
      session_id: data.session_id,
      sitemap_file_id: data.sitemap_file_id
    },
    "parse sitemap job handler started"
  );

  if (await isSessionCancelled(data.session_id)) {
    logger.info(
      { session_id: data.session_id },
      "parse sitemap job skipped — session cancelled"
    );
    return;
  }

  const fileResult = await pool.query<SitemapFileRow>(
    `
      SELECT id, session_id, filename, source_role
      FROM sitemap_files
      WHERE id = $1 AND session_id = $2
    `,
    [data.sitemap_file_id, data.session_id]
  );

  const file = fileResult.rows[0];

  if (!file) {
    throw new Error(`Sitemap file not found: ${data.sitemap_file_id}`);
  }

  logger.info(
    { sitemap_file_id: file.id, filename: file.filename },
    "parse sitemap job started"
  );

  await pool.query(
    "UPDATE sessions SET status = 'PROCESSING' WHERE id = $1 AND status = 'PENDING'",
    [file.session_id]
  );

  const parsed = await parseSitemapSource(file.filename);
  const isIndex = parsed.rootElement === "sitemapindex";
  const childUrls = isIndex ? uniqueValues(parsed.childSitemapUrls) : [];
  const locEntryCount = isIndex ? childUrls.length : parsed.totalUrls;
  const isEmpty = parsed.isValid && locEntryCount === 0;
  const partialLocs =
    !parsed.isValid && parsed.rootElement === "urlset" && parsed.totalUrls > 0
      ? (
          await parseSitemapSource(file.filename, {
            collectUrlLocs: true
          })
        ).urlLocs ?? []
      : [];
  const insertedChildRows: Array<{ id: string; filename: string }> = [];
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `
        UPDATE sitemap_files
        SET
          total_urls = $2,
          parsed_at = NOW(),
          is_valid = $3,
          parse_error = $4,
          parse_error_offset = $5,
          is_index = $6,
          had_preamble_stripped = $7,
          is_empty = $8
        WHERE id = $1
      `,
      [
        file.id,
        parsed.totalUrls,
        parsed.isValid,
        parsed.parseError,
        parsed.parseErrorOffset,
        isIndex,
        parsed.hadPreambleStripped,
        isEmpty
      ]
    );
    await client.query("DELETE FROM sitemap_partial_urls WHERE sitemap_file_id = $1", [
      file.id
    ]);

    if (partialLocs.length > 0) {
      await client.query(
        `
          INSERT INTO sitemap_partial_urls (
            sitemap_file_id,
            loc_order,
            url
          )
          SELECT $1, item.loc_order, item.url
          FROM UNNEST($2::integer[], $3::text[]) AS item(loc_order, url)
        `,
        [
          file.id,
          partialLocs.map((_, index) => index),
          partialLocs
        ]
      );
    }

    for (const childUrl of childUrls) {
      // Skip if this child already exists as a fetched-URL row OR as a local
      // file the user uploaded (matched by basename). This prevents an uploaded
      // index from doubling the file count and firing pointless network fetches
      // for sitemaps that are already present on disk.
      const twin = uploadedTwinFilename(
        file.session_id,
        childUrl,
        file.source_role
      );
      const existingNames = twin ? [childUrl, twin] : [childUrl];
      const childResult = await client.query<{ id: string; filename: string }>(
        `
          INSERT INTO sitemap_files (
            session_id,
            filename,
            total_urls,
            is_valid,
            is_index,
            source_role
          )
          SELECT $1, $2, 0, TRUE, FALSE, $3
          WHERE NOT EXISTS (
            SELECT 1
            FROM sitemap_files
            WHERE session_id = $1
              AND source_role = $3
              AND filename = ANY($4::text[])
          )
          RETURNING id, filename
        `,
        [file.session_id, childUrl, file.source_role, existingNames]
      );

      insertedChildRows.push(...childResult.rows);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Re-check cancellation before touching the shared progress counter /
  // finalization. If the user hit Stop while this job was mid-flight, exit now
  // so we don't recreate the Redis counter key the cancel handler just deleted.
  if (await isSessionCancelled(file.session_id)) {
    logger.info(
      { session_id: file.session_id, sitemap_file_id: file.id },
      "parse sitemap job completed after cancellation — results ignored"
    );
    return;
  }

  if (insertedChildRows.length > 0) {
    await enqueueParseSitemapJobs(
      insertedChildRows.map((child) => ({
        sitemap_file_id: child.id,
        session_id: file.session_id
      }))
    );
  }

  const parsedCount = await incrementParsedSitemapCount(file.session_id);
  await tryFinalizeParsedSession(file.session_id, logger, parsedCount, file.id);

  logger.info(
    {
      sitemap_file_id: file.id,
      total_urls: parsed.totalUrls,
      is_valid: parsed.isValid,
      is_index: isIndex,
      is_empty: isEmpty,
      source_role: file.source_role,
      partial_url_count: partialLocs.length,
      had_preamble_stripped: parsed.hadPreambleStripped,
      child_sitemap_count: childUrls.length
    },
    "parse sitemap job completed"
  );
}
