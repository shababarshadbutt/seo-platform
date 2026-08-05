import { unlink } from "node:fs/promises";
import path from "node:path";

// Deleting sitemap copies that a DB row identifies by STORED FILENAME.
//
// THE BUG THIS EXISTS FOR. pattern_transforms.new_file_paths holds stored
// filenames ("<session>-transformed-<hex>-<name>.xml"), not paths — the column
// name says "paths" but migration 021 describes it as "the repointed
// post-transform stored filename". Transform-undo passed that array straight to a
// helper that called unlink() on each entry, so every removal resolved against
// the process CWD instead of the uploads directory and failed ENOENT. The failures
// were logged at warn and nothing read them, so undo silently left every
// post-transform copy on disk: ~900 orphaned files, several hundred MB, per undo
// of a large pattern.
//
// WHY A SEPARATE FUNCTION rather than fixing the call. The root cause is that a
// bare `string[]` cannot say whether it holds filenames or paths, and the codebase
// has both (the rename path really does carry resolved paths). Two differently
// named functions make the caller state which it has, so the next person cannot
// reintroduce this by passing the wrong array.
//
// It also RETURNS what it did. The old code's only output was a warn log, which is
// why a total failure to delete anything went unnoticed; a caller (and a test) can
// now assert on the outcome.

export type StoredFileCleanupResult = {
  // Filenames whose file is now gone from the directory.
  removed: string[];
  // Filenames that could not be removed for a reason other than "already gone".
  failed: string[];
  // Filenames that were already absent. Not a failure: a superseded copy may have
  // been reaped by upload cleanup, and re-running an undo must stay idempotent.
  missing: string[];
};

type CleanupLogger = {
  warn: (details: Record<string, unknown>, message: string) => void;
};

// Remove each stored filename from `uploadDir`. `uploadDir` is a parameter rather
// than read from config so this is exercisable against a temp directory with real
// files on disk — the fix is precisely that the resolution happens, so a test that
// stubbed it out would prove nothing.
export async function removeStoredFiles(
  uploadDir: string,
  storedFilenames: string[],
  logger?: CleanupLogger
): Promise<StoredFileCleanupResult> {
  const result: StoredFileCleanupResult = {
    removed: [],
    failed: [],
    missing: []
  };

  for (const filename of storedFilenames) {
    // Guard against an entry that is already an absolute path (or escapes the
    // directory): path.join would happily build something outside uploadDir, and
    // this function deletes what it is given.
    if (path.isAbsolute(filename) || filename.includes("..")) {
      result.failed.push(filename);
      logger?.warn(
        { filename },
        "refusing to remove a stored file outside the uploads directory"
      );

      continue;
    }

    try {
      await unlink(path.join(uploadDir, filename));
      result.removed.push(filename);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;

      if (code === "ENOENT") {
        result.missing.push(filename);

        continue;
      }

      result.failed.push(filename);
      logger?.warn(
        { filename, error },
        "failed to remove a superseded sitemap copy"
      );
    }
  }

  return result;
}
