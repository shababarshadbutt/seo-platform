import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { peekRootElement } from "./peek.js";

// The one way a sitemap file enters a session, whatever its source: manual
// upload, fetch-from-URL, or (Phase 1) an SFTP pull. Extracted out of
// routes/sessions.ts unchanged so the SFTP job reuses the exact same row
// creation rather than duplicating the insert — everything downstream of
// ingestion then treats an SFTP-sourced file identically to an uploaded one.

export type SitemapSourceRole = "current" | "legacy";

export type StoredSitemapFile = {
  sitemap_file_id: string;
  filename: string;
  is_index: boolean;
  root_element: string | null;
  source_role: SitemapSourceRole;
  parse_job_id?: string;
};

// `originalFilename` is the TRUE incoming name from the source — the uploaded
// file's name, the basename of a fetched URL, or the remote SFTP filename. It is
// recorded rather than derived so publishing never has to guess: see migration
// 031 and productionFilename(). Callers that genuinely have no source name (only
// pre-031 rows, in practice) may omit it and fall back to the heuristic.
export async function createStoredSitemapFile(
  sessionId: string,
  storedFilename: string,
  sourceRole: SitemapSourceRole,
  originalFilename?: string
): Promise<StoredSitemapFile> {
  const filePath = path.join(config.uploadDir, storedFilename);
  const rootElement = await peekRootElement(filePath);
  const isIndex = rootElement === "sitemapindex";
  const fileResult = await pool.query<{ id: string }>(
    `
      WITH inserted AS (
        INSERT INTO sitemap_files (
          session_id,
          filename,
          total_urls,
          is_valid,
          is_index,
          source_role,
          original_filename
        )
        VALUES ($1, $2, 0, TRUE, $3, $4, $5)
        ON CONFLICT (session_id, filename) DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION ALL
      SELECT id
      FROM sitemap_files
      WHERE session_id = $1
        AND filename = $2
      LIMIT 1
    `,
    [sessionId, storedFilename, isIndex, sourceRole, originalFilename ?? null]
  );
  const sitemapFileId = fileResult.rows[0].id;

  return {
    sitemap_file_id: sitemapFileId,
    filename: storedFilename,
    is_index: isIndex,
    root_element: rootElement,
    source_role: sourceRole
  };
}
