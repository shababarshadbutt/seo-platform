// User-specified per-file URL cap for the sitemap-regenerate wizard's
// generated chunk files. Same "declare bounds, validate with a clear error"
// shape as outputFilenamePattern.ts's validateFilenameTemplate.

export const MIN_URLS_PER_FILE = 10_000;
export const MAX_URLS_PER_FILE = 50_000;
export const URLS_PER_FILE_STEP = 5_000;

// Preserves today's behavior for anyone who doesn't touch the control.
export const DEFAULT_URLS_PER_FILE = 50_000;

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
