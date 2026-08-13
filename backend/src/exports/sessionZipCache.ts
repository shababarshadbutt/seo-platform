import { unlink } from "node:fs/promises";

import type { FastifyBaseLogger } from "fastify";

import { pool } from "../db/pool.js";
import { enqueuePreGenerateZipJob } from "../queue/preGenerateZipQueue.js";

// Re-export the pure freshness decision (defined side-effect-free so it can be
// unit-tested without opening a DB pool / Redis connection). Shared by the
// download endpoint and the pre-gen skip-if-fresh guard so they can't disagree.
export { isZipCacheFresh } from "./zipCacheFreshness.js";

// Clear a session's pre-generated download ZIPs and re-enqueue their generation.
// Call after ANY operation that mutates the session's sitemap files (bulk
// replace, pattern rename/transform, apply-redirects, trailing-slash fix, URL
// deletion/restore, file soft-delete) so the cached ZIP never serves stale data.
// Best-effort: failures here must not break the mutation that triggered them —
// but they are LOGGED. This used to swallow everything into a bare `catch {}`,
// so a failure to clear the cache was invisible and the user could go on
// downloading a stale ZIP with no trace of why.
export async function invalidateSessionZipCache(
  sessionId: string,
  logger?: FastifyBaseLogger
) {
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

    // Stamp files_mutated_at so a pre-gen build already in flight can detect it
    // raced this mutation (and rebuild), and the download endpoint won't serve a
    // cache older than this. This is the single choke point every file-mutation
    // path already funnels through, so it is the one place to record the edit.
    await pool.query(
      "UPDATE sessions SET zip_all_path = NULL, zip_edited_path = NULL, zip_generated_at = NULL, zip_progress = 0, zip_progress_file = 0, files_mutated_at = now() WHERE id = $1",
      [sessionId]
    );

    await enqueuePreGenerateZipJob({ session_id: sessionId, type: "all" });
    await enqueuePreGenerateZipJob({ session_id: sessionId, type: "edited" });
  } catch (error) {
    // Non-fatal — the next completion/mutation or a manual download will
    // rebuild. Logged so a persistently stale download has something to point at.
    logger?.warn(
      { session_id: sessionId, err: error },
      "failed to invalidate the session ZIP cache; a stale ZIP may be served until the next mutation"
    );
  }
}
