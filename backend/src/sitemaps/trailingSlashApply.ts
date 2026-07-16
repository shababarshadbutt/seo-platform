import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  buildTrailingSlashStoredFilename,
  displaySourceFilename,
  isHttpUrl
} from "./filenames.js";
import {
  addTrailingSlashToPathString,
  buildTrailingSlashRewriter,
  rewriteSitemapLocFile,
  stripTrailingSlashFromPathString,
  stripTrailingSlashFromUrl
} from "./rewriteLocs.js";
import { streamSitemapUrlLocs } from "./parser.js";

export type TrailingSlashProgress = (
  filesDone: number,
  filesTotal: number,
  urlsFixed: number
) => Promise<void> | void;

type CurrentFileRow = {
  id: string;
  filename: string;
  trailing_slash_original_path: string | null;
};

export type TrailingSlashPreview = {
  files_affected: number;
  urls_to_fix: number;
  per_file: Array<{ filename: string; url_count: number }>;
  sample_before_after: Array<{ before: string; after: string }>;
};

async function loadCurrentLocalFiles(
  sessionId: string
): Promise<Array<CurrentFileRow & { displayName: string }>> {
  const result = await pool.query<CurrentFileRow>(
    `
      SELECT id, filename, trailing_slash_original_path
      FROM sitemap_files
      WHERE session_id = $1 AND source_role = 'current' AND is_deleted = false
      ORDER BY filename ASC
    `,
    [sessionId]
  );

  return result.rows
    .filter((row) => !isHttpUrl(row.filename))
    .map((row) => ({
      ...row,
      displayName: displaySourceFilename(sessionId, row.filename)
    }));
}

// Stream every current file and count how many <loc> URLs are missing a
// trailing slash, collecting a few before/after examples. Authoritative (reads
// the real files), same rule the apply pass uses.
export async function previewTrailingSlash(
  sessionId: string,
  sampleLimit = 5
): Promise<TrailingSlashPreview> {
  const files = await loadCurrentLocalFiles(sessionId);
  const rewrite = buildTrailingSlashRewriter();
  const perFile: Array<{ filename: string; url_count: number }> = [];
  const samples: Array<{ before: string; after: string }> = [];
  let urlsToFix = 0;

  for (const file of files) {
    const storedPath = path.join(config.uploadDir, file.filename);

    try {
      await access(storedPath);
    } catch {
      continue;
    }

    let count = 0;

    await streamSitemapUrlLocs(file.filename, (loc) => {
      const next = rewrite(loc);

      if (next !== null) {
        count += 1;

        if (samples.length < sampleLimit) {
          samples.push({ before: loc, after: next });
        }
      }
    });

    if (count > 0) {
      perFile.push({ filename: file.displayName, url_count: count });
      urlsToFix += count;
    }
  }

  return {
    files_affected: perFile.length,
    urls_to_fix: urlsToFix,
    per_file: perFile,
    sample_before_after: samples
  };
}

// Rewrite the DB sample/pool/template rows that a trailing-slash fix touches,
// flagging exactly the rows changed so undo can reverse only those.
async function applyTrailingSlashDbChanges(
  sessionId: string,
  selected: Set<string> | null
) {
  const rewrite = buildTrailingSlashRewriter();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // sampled_urls (scoped to the selected source files when a subset was
    // chosen; source_file is the display filename).
    const sampled = await client.query<{
      id: string;
      url: string;
      source_file: string | null;
    }>(
      `
        SELECT s.id, s.url, s.source_file
        FROM sampled_urls s
        JOIN patterns p ON p.id = s.pattern_id
        WHERE p.session_id = $1
      `,
      [sessionId]
    );
    const sampledUpdates = sampled.rows
      .filter(
        (row) => !selected || (row.source_file != null && selected.has(row.source_file))
      )
      .map((row) => ({ id: row.id, next: rewrite(row.url) }))
      .filter((u): u is { id: string; next: string } => u.next !== null);

    if (sampledUpdates.length > 0) {
      await client.query(
        `
          UPDATE sampled_urls AS s
          SET url = u.next, trailing_slash_fixed = true
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, next)
          WHERE s.id = u.id
        `,
        [sampledUpdates.map((u) => u.id), sampledUpdates.map((u) => u.next)]
      );
    }

    // pattern_urls.path (session-wide URL pool; path-level rule).
    const poolRows = await client.query<{ id: string; path: string }>(
      "SELECT id, path FROM pattern_urls WHERE session_id = $1",
      [sessionId]
    );
    const poolUpdates = poolRows.rows
      .map((row) => ({ id: row.id, next: addTrailingSlashToPathString(row.path) }))
      .filter((u): u is { id: string; next: string } => u.next !== null);

    for (let i = 0; i < poolUpdates.length; i += 5000) {
      const chunk = poolUpdates.slice(i, i + 5000);
      await client.query(
        `
          UPDATE pattern_urls AS pu
          SET path = u.next, trailing_slash_fixed = true
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, next)
          WHERE pu.id = u.id
        `,
        [chunk.map((u) => u.id), chunk.map((u) => u.next)]
      );
    }

    // patterns.template.
    const patternRows = await client.query<{ id: string; template: string }>(
      "SELECT id, template FROM patterns WHERE session_id = $1",
      [sessionId]
    );
    const patternUpdates = patternRows.rows
      .map((row) => ({
        id: row.id,
        next: addTrailingSlashToPathString(row.template)
      }))
      .filter((u): u is { id: string; next: string } => u.next !== null);

    if (patternUpdates.length > 0) {
      await client.query(
        `
          UPDATE patterns AS p
          SET template = u.next, trailing_slash_fixed = true
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, next)
          WHERE p.id = u.id
        `,
        [patternUpdates.map((u) => u.id), patternUpdates.map((u) => u.next)]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Apply the trailing-slash fix to the selected files on disk (copy-on-write with
// a backup pointer, mirroring bulk replace), then reflect it in the DB.
export async function applyTrailingSlash(options: {
  sessionId: string;
  selectedFiles: string[] | null;
  onProgress?: TrailingSlashProgress;
}): Promise<{ filesChanged: number; urlsFixed: number }> {
  const files = await loadCurrentLocalFiles(options.sessionId);
  const selected =
    options.selectedFiles && options.selectedFiles.length > 0
      ? new Set(options.selectedFiles)
      : null;
  const targets = selected
    ? files.filter((file) => selected.has(file.displayName))
    : files;
  const rewrite = buildTrailingSlashRewriter();

  let filesChanged = 0;
  let urlsFixed = 0;
  let filesDone = 0;

  for (const file of targets) {
    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      filesDone += 1;
      await options.onProgress?.(filesDone, targets.length, urlsFixed);
      continue;
    }

    const isGzip = file.filename.toLowerCase().endsWith(".gz");
    const newStored = buildTrailingSlashStoredFilename(
      options.sessionId,
      file.displayName,
      randomUUID()
    );
    const outputPath = path.join(config.uploadDir, newStored);

    let rewrittenCount = 0;

    try {
      rewrittenCount = await rewriteSitemapLocFile({
        inputPath,
        outputPath,
        isGzip,
        rewriteUrl: rewrite
      });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    if (rewrittenCount === 0) {
      await unlink(outputPath).catch(() => {});
    } else {
      const originalToKeep =
        file.trailing_slash_original_path ?? file.filename;
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE sitemap_files SET filename = $1, trailing_slash_original_path = $2 WHERE id = $3",
          [newStored, originalToKeep, file.id]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        await unlink(outputPath).catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      if (file.filename !== originalToKeep) {
        await unlink(inputPath).catch(() => {});
      }

      filesChanged += 1;
      urlsFixed += rewrittenCount;
    }

    filesDone += 1;
    await options.onProgress?.(filesDone, targets.length, urlsFixed);
  }

  await applyTrailingSlashDbChanges(options.sessionId, selected);

  return { filesChanged, urlsFixed };
}

// Undo a trailing-slash fix: restore every rewritten file to its pre-fix
// original and reverse exactly the flagged DB rows.
export async function undoTrailingSlash(options: {
  sessionId: string;
  onProgress?: TrailingSlashProgress;
}): Promise<{ filesRestored: number }> {
  const filesResult = await pool.query<CurrentFileRow>(
    `
      SELECT id, filename, trailing_slash_original_path
      FROM sitemap_files
      WHERE session_id = $1
        AND source_role = 'current'
        AND trailing_slash_original_path IS NOT NULL
      ORDER BY filename ASC
    `,
    [options.sessionId]
  );
  const files = filesResult.rows;

  let filesRestored = 0;
  let filesDone = 0;

  for (const file of files) {
    const original = file.trailing_slash_original_path as string;
    const currentPath = path.join(config.uploadDir, file.filename);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE sitemap_files SET filename = $1, trailing_slash_original_path = NULL WHERE id = $2",
        [original, file.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (file.filename !== original) {
      await unlink(currentPath).catch(() => {});
    }

    filesRestored += 1;
    filesDone += 1;
    await options.onProgress?.(filesDone, files.length, 0);
  }

  await reverseTrailingSlashDbChanges(options.sessionId);

  return { filesRestored };
}

async function reverseTrailingSlashDbChanges(sessionId: string) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sampled = await client.query<{ id: string; url: string }>(
      `
        SELECT s.id, s.url
        FROM sampled_urls s
        JOIN patterns p ON p.id = s.pattern_id
        WHERE p.session_id = $1 AND s.trailing_slash_fixed = true
      `,
      [sessionId]
    );
    const sampledUpdates = sampled.rows
      .map((row) => ({ id: row.id, next: stripTrailingSlashFromUrl(row.url) }))
      .filter((u): u is { id: string; next: string } => u.next !== null);

    if (sampledUpdates.length > 0) {
      await client.query(
        `
          UPDATE sampled_urls AS s
          SET url = u.next, trailing_slash_fixed = false
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, next)
          WHERE s.id = u.id
        `,
        [sampledUpdates.map((u) => u.id), sampledUpdates.map((u) => u.next)]
      );
    }

    // Clear any flag whose URL had nothing to strip (defensive; keeps state clean).
    await client.query(
      `
        UPDATE sampled_urls AS s
        SET trailing_slash_fixed = false
        FROM patterns p
        WHERE p.id = s.pattern_id AND p.session_id = $1 AND s.trailing_slash_fixed = true
      `,
      [sessionId]
    );

    const poolRows = await client.query<{ id: string; path: string }>(
      "SELECT id, path FROM pattern_urls WHERE session_id = $1 AND trailing_slash_fixed = true",
      [sessionId]
    );
    const poolUpdates = poolRows.rows
      .map((row) => ({
        id: row.id,
        next: stripTrailingSlashFromPathString(row.path)
      }))
      .filter((u): u is { id: string; next: string } => u.next !== null);

    for (let i = 0; i < poolUpdates.length; i += 5000) {
      const chunk = poolUpdates.slice(i, i + 5000);
      await client.query(
        `
          UPDATE pattern_urls AS pu
          SET path = u.next, trailing_slash_fixed = false
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, next)
          WHERE pu.id = u.id
        `,
        [chunk.map((u) => u.id), chunk.map((u) => u.next)]
      );
    }

    await client.query(
      "UPDATE pattern_urls SET trailing_slash_fixed = false WHERE session_id = $1 AND trailing_slash_fixed = true",
      [sessionId]
    );

    const patternRows = await client.query<{ id: string; template: string }>(
      "SELECT id, template FROM patterns WHERE session_id = $1 AND trailing_slash_fixed = true",
      [sessionId]
    );
    const patternUpdates = patternRows.rows
      .map((row) => ({
        id: row.id,
        next: stripTrailingSlashFromPathString(row.template)
      }))
      .filter((u): u is { id: string; next: string } => u.next !== null);

    if (patternUpdates.length > 0) {
      await client.query(
        `
          UPDATE patterns AS p
          SET template = u.next, trailing_slash_fixed = false
          FROM UNNEST($1::uuid[], $2::text[]) AS u(id, next)
          WHERE p.id = u.id
        `,
        [patternUpdates.map((u) => u.id), patternUpdates.map((u) => u.next)]
      );
    }

    await client.query(
      "UPDATE patterns SET trailing_slash_fixed = false WHERE session_id = $1 AND trailing_slash_fixed = true",
      [sessionId]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
