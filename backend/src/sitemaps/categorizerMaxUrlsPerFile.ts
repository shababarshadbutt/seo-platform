// User-specified per-file URL cap for the Sitemap Categorizer tool's output
// chunks. A SIBLING of maxUrlsPerFile.ts (same "declare bounds, validate with
// a clear error" shape), not an edit of it: sitemap-regenerate depends on that
// file's current 10,000-50,000 range and 50,000 default, and this tool's doc
// calls for a 45,000 default with room to raise it — bending the shared
// constants would change sitemap-regenerate's behavior for an unrelated tool.

export const MIN_URLS_PER_FILE = 10_000;
export const MAX_URLS_PER_FILE = 100_000;
export const URLS_PER_FILE_STEP = 5_000;

export const DEFAULT_URLS_PER_FILE = 45_000;

export type MaxUrlsPerFileValidation =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function validateMaxUrlsPerFile(value: unknown): MaxUrlsPerFileValidation {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: "max_urls_per_file must be an integer." };
  }

  if (value < MIN_URLS_PER_FILE || value > MAX_URLS_PER_FILE) {
    return {
      ok: false,
      error: `max_urls_per_file must be between ${MIN_URLS_PER_FILE} and ${MAX_URLS_PER_FILE}.`
    };
  }

  if ((value - MIN_URLS_PER_FILE) % URLS_PER_FILE_STEP !== 0) {
    return {
      ok: false,
      error: `max_urls_per_file must be a multiple of ${URLS_PER_FILE_STEP} starting from ${MIN_URLS_PER_FILE}.`
    };
  }

  return { ok: true, value };
}
