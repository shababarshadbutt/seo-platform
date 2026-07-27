import type { FastifyBaseLogger } from "fastify";

import { withPublishLock } from "../publish/publishLock.js";
import { buildPublishPlan, executePublish } from "../publish/s3Publish.js";
import type { S3PublishJobData } from "../queue/publishQueue.js";

// Background S3 publish (Phase 1). Large domains span thousands of child files,
// so the upload runs here rather than on the request thread.
//
// The per-domain lock is re-taken INSIDE the job, not inherited from the route.
// The route's lock only guards the enqueue decision and is released as soon as
// that returns; holding a Redis lock across a queue handoff would mean its TTL
// covers unbounded queue-wait time as well as the work. withPublishLock
// releases in a finally, so a crashed publish frees the domain immediately
// rather than blocking it until the TTL lapses.
export async function processS3PublishJob(
  data: S3PublishJobData,
  logger: FastifyBaseLogger
) {
  const { session_id: sessionId, domain } = data;

  await withPublishLock(domain, async () => {
    const plan = await buildPublishPlan(sessionId, domain);

    logger.info(
      {
        session_id: sessionId,
        domain,
        files: plan.files.length,
        omitted_deleted: plan.omittedDeleted.length,
        index: plan.indexFilename
      },
      "s3 publish started"
    );

    const result = await executePublish(plan, {
      today: new Date().toISOString().slice(0, 10)
    });

    logger.info(
      {
        session_id: sessionId,
        domain,
        uploaded: result.uploaded,
        bytes: result.bytes,
        invalidation_id: result.invalidation_id
      },
      "s3 publish complete"
    );
  });
}
