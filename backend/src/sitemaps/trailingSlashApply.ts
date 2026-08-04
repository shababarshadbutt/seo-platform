import { randomUUID } from "node:crypto";
import { access, unlink } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  planTemplateChanges,
  type SkippedTemplateChange
} from "./patternTemplateConflict.js";
import {
  FILE_REWRITE_PARALLEL_THRESHOLD,
  runFileRewriteJob
} from "../jobs/fileRewritePool.js";
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

export type TrailingSlashProgress = (
  filesDone: number,
  filesTotal: number,
  urlsFixed: number
) => Promise<void> | void;

type CurrentFileRow = {
  id: string;
  filename: string;
  trailing_slash_original_path: string | null;
  total_urls: number | string | null;
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
      SELECT id, filename, trailing_slash_original_path, total_urls
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

// List the session's current sitemap files so the "Fix Trailing Slashes" modal
// can show a file list + Apply button. This is a cheap DB-only read (v1.33
// Fix 1): the previous version streamed and parsed EVERY <loc> in EVERY file to
// count fixable URLs, which took ~1s per ~65k URLs — minutes on a large session
// (900 files × tens of thousands of URLs) — and blew past the preview request's
// timeout, so the modal ended up with no files and only a Close button.
// Parallelising that parse (piscina) or switching to the byte-level scanner both
// gave no real speedup — the cost is per-URL `new URL()` parsing, O(total URLs).
//
// `url_count` here is the file's TOTAL URL count (an upper bound on what a fix
// touches), not an exact fixable count; the apply pass is authoritative and
// reports how many URLs it actually changed. `sampleLimit` is accepted for
// signature compatibility but unused (no parsing happens here).
export async function previewTrailingSlash(
  sessionId: string,
  _sampleLimit = 5
): Promise<TrailingSlashPreview> {
  const files = await loadCurrentLocalFiles(sessionId);

  const perFile: Array<{ filename: string; url_count: number }> = [];
  let totalUrls = 0;

  for (const file of files) {
    // Only files still present on disk can be fixed.
    try {
      await access(path.join(config.uploadDir, file.filename));
    } catch {
      continue;
    }

    const count = Number(file.total_urls ?? 0);

    perFile.push({ filename: file.displayName, url_count: count });
    totalUrls += count;
  }

  return {
    files_affected: perFile.length,
    urls_to_fix: totalUrls,
    per_file: perFile,
    // Samples would require parsing files (the exact cost this endpoint now
    // avoids), so none are returned; the modal's sample section is optional.
    sample_before_after: []
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

    // patterns.template. source_role is selected because the uniqueness that can
    // block a slash is per (session_id, source_role, template).
    const patternRows = await client.query<{
      id: string;
      template: string;
      source_role: string;
    }>("SELECT id, template, source_role FROM patterns WHERE session_id = $1", [
      sessionId
    ]);
    const existing = patternRows.rows.map((row) => ({
      id: row.id,
      sourceRole: row.source_role,
      template: row.template
    }));
    const wanted = patternRows.rows
      .map((row) => ({
        id: row.id,
        sourceRole: row.source_role,
        template: row.template,
        next: addTrailingSlashToPathString(row.template)
      }))
      .filter(
        (u): u is (typeof existing)[number] & { next: string } => u.next !== null
      );

    // Slashing "/x" collides when a separate "/x/" pattern already exists. One
    // statement meant one collision aborted the whole apply; skip those and apply
    // the rest, then report them.
    const { applied: patternUpdates, skipped } = planTemplateChanges(
      wanted,
      existing
    );

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

    return { skipped };
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
}): Promise<{
  filesChanged: number;
  urlsFixed: number;
  // Patterns left unslashed because another pattern already holds the slashed
  // form. Not failures — reported so a skip is never silent.
  skipped: SkippedTemplateChange[];
}> {
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

  // Swap in the rewritten copy for one file and record its pre-fix original for
  // undo. Runs on the MAIN thread only, so DB writes stay single-threaded even
  // when the file rewrites themselves ran in parallel worker threads (v1.32).
  const finalizeRewrittenFile = async (
    file: (typeof targets)[number],
    inputPath: string,
    newStored: string,
    outputPath: string,
    rewrittenCount: number
  ) => {
    if (rewrittenCount === 0) {
      await unlink(outputPath).catch(() => {});
    } else {
      const originalToKeep = file.trailing_slash_original_path ?? file.filename;
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
  };

  // Rewrite one file (missing trailing slashes → added) to a new stored copy,
  // then finalize. `runRewrite` streams the file — inline (sequential) or via
  // the piscina pool (parallel). Skips (still counts) a source that's gone.
  const processFile = async (
    file: (typeof targets)[number],
    runRewrite: (input: {
      inputPath: string;
      outputPath: string;
      isGzip: boolean;
    }) => Promise<number>
  ) => {
    const inputPath = path.join(config.uploadDir, file.filename);

    try {
      await access(inputPath);
    } catch {
      filesDone += 1;
      await options.onProgress?.(filesDone, targets.length, urlsFixed);
      return;
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
      rewrittenCount = await runRewrite({ inputPath, outputPath, isGzip });
    } catch (error) {
      await unlink(outputPath).catch(() => {});
      throw error;
    }

    await finalizeRewrittenFile(
      file,
      inputPath,
      newStored,
      outputPath,
      rewrittenCount
    );
  };

  if (targets.length >= FILE_REWRITE_PARALLEL_THRESHOLD) {
    // Parallel: the piscina pool caps concurrent rewrites at its thread count,
    // so mapping every target is safe — extra tasks queue. Each file's DB swap
    // runs here as its rewrite resolves (bounded by the same cap in practice).
    await Promise.all(
      targets.map((file) =>
        processFile(file, (input) =>
          runFileRewriteJob({
            ...input,
            spec: { kind: "trailingSlash" }
          }).then((result) => result.rewrittenCount)
        )
      )
    );
  } else {
    // Sequential for small sessions — no worker-thread overhead.
    for (const file of targets) {
      await processFile(file, (input) =>
        rewriteSitemapLocFile({ ...input, rewriteUrl: rewrite })
      );
    }
  }

  const { skipped } = await applyTrailingSlashDbChanges(
    options.sessionId,
    selected
  );

  return { filesChanged, urlsFixed, skipped };
}

// Undo a trailing-slash fix: restore every rewritten file to its pre-fix
// original and reverse exactly the flagged DB rows.
export async function undoTrailingSlash(options: {
  sessionId: string;
  onProgress?: TrailingSlashProgress;
}): Promise<{
  filesRestored: number;
  skipped: SkippedTemplateChange[];
}> {
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

  const { skipped } = await reverseTrailingSlashDbChanges(options.sessionId);

  return { filesRestored, skipped };
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

    // Captured before the flags are cleared below, so the strip set is known even
    // though the "already taken" set has to span the whole session.
    const flaggedRows = await client.query<{ id: string }>(
      "SELECT id FROM patterns WHERE session_id = $1 AND trailing_slash_fixed = true",
      [sessionId]
    );
    const flaggedPatternIds = new Set(flaggedRows.rows.map((row) => row.id));

    // Every pattern in the session, not just the flagged ones: an unslashed
    // pattern that was never touched by the fix is exactly what a strip can
    // collide with, so it has to be in the "already taken" set.
    const allPatternRows = await client.query<{
      id: string;
      template: string;
      source_role: string;
    }>("SELECT id, template, source_role FROM patterns WHERE session_id = $1", [
      sessionId
    ]);
    const existing = allPatternRows.rows.map((row) => ({
      id: row.id,
      sourceRole: row.source_role,
      template: row.template
    }));
    const wanted = allPatternRows.rows
      .filter((row) => flaggedPatternIds.has(row.id))
      .map((row) => ({
        id: row.id,
        sourceRole: row.source_role,
        template: row.template,
        next: stripTrailingSlashFromPathString(row.template)
      }))
      .filter(
        (u): u is (typeof existing)[number] & { next: string } => u.next !== null
      );

    const { applied: patternUpdates, skipped } = planTemplateChanges(
      wanted,
      existing
    );

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

    return { skipped };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
