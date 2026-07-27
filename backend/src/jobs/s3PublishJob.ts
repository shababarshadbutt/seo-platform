import type { Job } from "bullmq";
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
export type S3PublishJobResult = {
  uploaded: number;
  bytes: number;
  index_key: string;
  omitted_deleted: string[];
  invalidation_id: string | null;
};

export async function processS3PublishJob(
  data: S3PublishJobData,
  logger: FastifyBaseLogger,
  // Progress is written to the BullMQ job so the SSE route can follow it
  // without the API process needing a channel back into this worker.
  job?: Job
): Promise<S3PublishJobResult> {
  const { session_id: sessionId, domain } = data;

  return withPublishLock(domain, async () => {
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

    await job?.updateProgress({
      stage: "start",
      current: 0,
      total: plan.files.length + 1,
      message: `Publishing ${plan.files.length + 1} file(s) to ${domain}`
    });

    const result = await executePublish(plan, {
      today: new Date().toISOString().slice(0, 10),
      onProgress: async (event) => {
        // Awaited, not fire-and-forget: an out-of-order write can land after the
        // terminal "done" progress below and overwrite it. A single Redis HSET
        // per file is negligible next to the S3 PUT it follows.
        await job?.updateProgress({
          stage: "upload",
          current: event.current,
          total: event.total,
          message: `Uploaded ${event.filename} (${event.current} of ${event.total})`
        });
      }
    });

    await job?.updateProgress({
      stage: "done",
      current: result.uploaded,
      total: result.uploaded,
      message: `Published ${result.uploaded} file(s)`,
      result: {
        uploaded: result.uploaded,
        bytes: result.bytes,
        index_key: result.index_key,
        omitted_deleted: result.omitted_deleted,
        invalidation_id: result.invalidation_id
      }
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

    // Returned, not just written to progress: BullMQ persists a job's return
    // value ATOMICALLY as part of marking it completed, whereas progress is a
    // separate write that can still be in flight when a watcher first observes
    // the completed state. The SSE route reads this for its terminal frame so
    // the summary is never a stale mid-upload message.
    return {
      uploaded: result.uploaded,
      bytes: result.bytes,
      index_key: result.index_key,
      omitted_deleted: result.omitted_deleted,
      invalidation_id: result.invalidation_id
    };
  });
}
