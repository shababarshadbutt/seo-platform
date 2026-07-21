import { unlink } from "node:fs/promises";

import { pool } from "../db/pool.js";
import { enqueuePreGenerateZipJob } from "../queue/preGenerateZipQueue.js";

// Clear a session's pre-generated download ZIPs and re-enqueue their generation.
// Call after ANY operation that mutates the session's sitemap files (bulk
// replace, pattern rename/transform, apply-redirects, trailing-slash fix, URL
// deletion/restore, file soft-delete) so the cached ZIP never serves stale data.
// Best-effort: failures here must not break the mutation that triggered them.
export async function invalidateSessionZipCache(sessionId: string) {
  try {
    const result = await pool.query<{
      zip_all_path: string | null;
      zip_edited_path: string | null;
    }>(
      "SELECT zip_all_path, zip_edited_path FROM sessions WHERE id = $1",
      [sessionId]
    );

    const row = result.rows[0];

    if (row) {
      for (const stalePath of [row.zip_all_path, row.zip_edited_path]) {
        if (stalePath) {
          await unlink(stalePath).catch(() => {});
        }
      }
    }

    await pool.query(
      "UPDATE sessions SET zip_all_path = NULL, zip_edited_path = NULL, zip_generated_at = NULL, zip_progress = 0, zip_progress_file = 0 WHERE id = $1",
      [sessionId]
    );

    await enqueuePreGenerateZipJob({ session_id: sessionId, type: "all" });
    await enqueuePreGenerateZipJob({ session_id: sessionId, type: "edited" });
  } catch {
    // Non-fatal — the next completion/mutation or a manual download will rebuild.
  }
}
