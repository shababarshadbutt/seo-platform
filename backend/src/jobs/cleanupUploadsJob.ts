import type { FastifyBaseLogger } from "fastify";

import { deleteSessionUploads } from "../sitemaps/uploadCleanup.js";

// The SAFETY NET for forgotten sessions — no longer the primary cleanup path.
//
// It used to fire one hour after a session reached COMPLETE, which is when
// ANALYSIS finishes, not when the work is done: the user still has to review
// patterns, apply fixes and publish. An hour is not enough time to review a
// multi-gigabyte client site, and this job silently removed the bytes anyway,
// regardless of whether anything had been published. That is what turned a
// publish of a day-old session into an upload of an empty sitemap index (fixed
// separately in publish/s3Publish.ts, which now refuses instead).
//
// It is now a long backstop (UPLOAD_CLEANUP_DELAY_HOURS, default 48) whose job is
// to stop abandoned sessions filling a 500 GB volume. The deliberate path is the
// post-publish prompt / History storage view, which ask a human first.
//
// The deletion itself lives in sitemaps/uploadStorage.ts and is shared with that
// explicit path, so there is one definition of what "clean a session" removes
// rather than two that can drift.
export async function processCleanupUploadsJob(
  data: { session_id: string },
  logger: FastifyBaseLogger
) {
  await deleteSessionUploads(data.session_id, logger, "safety-net");
}
