// Maps low-level filesystem errno failures to actionable HTTP responses so the
// frontend can show a clear message instead of a generic 500 (which it used to
// render as the misleading "Cannot connect to backend").

export type FsErrorResponse = {
  status: number;
  body: { error: string; message: string };
};

// Returns a mapped HTTP response for disk-related errno codes, or null when the
// error is not a filesystem error we recognise (let the caller handle it).
export function fsErrorResponse(error: unknown): FsErrorResponse | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;

  // No space left on device — the server disk is full.
  if (code === "ENOSPC") {
    return {
      status: 507,
      body: {
        error: "Insufficient Storage",
        message:
          "Server storage is full. Please free up disk space and try again."
      }
    };
  }

  // A referenced file vanished (e.g. cleaned up between listing and read).
  if (code === "ENOENT") {
    return {
      status: 404,
      body: {
        error: "Not Found",
        message: "Sitemap file not found — it may have been cleaned up"
      }
    };
  }

  return null;
}
