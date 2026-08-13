import { unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";

// Deleting sitemap files that live in UPLOAD_DIR.
//
// This codebase carries BOTH bare stored filenames and fully resolved absolute
// paths in `string[]`s, and a bare array cannot say which it holds. Getting it
// wrong is silent: unlink("sess-abc.xml") resolves against the process CWD, and
// the ENOENT that follows looks exactly like "already deleted".
//
// pattern_transforms.new_file_paths is the case that matters — despite the
// name it stores bare FILENAMES, so the undo path's cleanup never removed
// anything and left the post-transform copies orphaned on every undo.
//
// Hence two functions with names that state what they take, and a report of
// what happened so a total failure can't pass for success.

export type StoredFileRemovalReport = {
  removed: number;
  missing: number;
  failed: number;
};

async function removeOne(
  filePath: string,
  logger: FastifyBaseLogger,
  report: StoredFileRemovalReport
) {
  try {
    await unlink(filePath);
    report.removed += 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      report.missing += 1;
      return;
    }

    report.failed += 1;
    logger.warn(
      { file_path: filePath, err: error },
      "failed to remove a stored sitemap file"
    );
  }
}

// For arrays that already hold absolute paths.
export async function removeStoredFilePaths(
  filePaths: string[],
  logger: FastifyBaseLogger
): Promise<StoredFileRemovalReport> {
  const report: StoredFileRemovalReport = { removed: 0, missing: 0, failed: 0 };

  for (const filePath of filePaths) {
    await removeOne(filePath, logger, report);
  }

  return report;
}

// For arrays that hold bare stored filenames (pattern_transforms.new_file_paths,
// sitemap_files.filename). Resolves each against UPLOAD_DIR first.
export async function removeStoredFilenames(
  filenames: string[],
  logger: FastifyBaseLogger
): Promise<StoredFileRemovalReport> {
  const report: StoredFileRemovalReport = { removed: 0, missing: 0, failed: 0 };

  for (const filename of filenames) {
    await removeOne(path.join(config.uploadDir, filename), logger, report);
  }

  if (filenames.length > 0 && report.removed === 0) {
    logger.warn(
      { count: filenames.length, ...report },
      "removed none of the stored files requested — check whether these are filenames or paths"
    );
  }

  return report;
}
