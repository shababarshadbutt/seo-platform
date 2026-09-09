import type { FastifyInstance } from "fastify";

import { publishQueue } from "../queue/publishQueue.js";

// SSE tuning for the long-running publish/pull streams, mirroring the Cleaner's
// values. Defined here rather than in sessions.ts because the extracted pull
// route below needs them and the publish stream that still lives in sessions.ts
// imports them back — one definition, two consumers.
export const PUBLISH_SSE_KEEPALIVE_MS = 15 * 1000;
export const PUBLISH_SSE_POLL_MS = 1000;
export const PUBLISH_SSE_TIMEOUT_MS = 30 * 60 * 1000;
// How long to wait for a just-enqueued job to become visible before reporting
// that nothing is running.
export const PUBLISH_SSE_JOB_GRACE_MS = 10 * 1000;

// Follow a remote pull (SFTP or S3) over SSE.
//
// EXTRACTED RATHER THAN COPIED. The SFTP and S3 pulls run the identical job
// contract — {stage,current,total,message} progress writes plus a
// {stored,failed,total,domain} return value — and differ only in which job id
// they poll and which config gate they check. Duplicating ~150 lines for the
// second one would also duplicate three defects that were each found the hard
// way on the publish path and fixed here:
//
//   1. The config gate runs BEFORE reply.hijack(). After hijacking, Fastify no
//      longer owns the socket and reply.code().send() writes nothing.
//   2. The terminal frame reads job.returnvalue, not the last progress write.
//      BullMQ persists the return value atomically with completion, whereas a
//      progress write can still be in flight when a watcher first sees
//      "completed" — so a stream driven by progress can end on a stale message.
//   3. PUBLISH_SSE_JOB_GRACE_MS covers the enqueue race. The client opens this
//      stream immediately after its POST returns, and the job is not guaranteed
//      visible yet; without the grace window that reads as "nothing is running".
//
// The publish stream deliberately stays separate: it has a "partial" terminal
// state (objects written but the CDN purge incomplete) that a pull cannot reach,
// and folding it in would mean teaching this function a state it never needs.
export function registerPullProgressRoute(
  app: FastifyInstance,
  options: {
    // Route path, e.g. "/api/sessions/:id/sources/s3/progress".
    path: string;
    // BullMQ job-name prefix; the job id is `${jobIdPrefix}-${sessionId}`.
    jobIdPrefix: string;
    // Evaluated per request, not at registration: config is read at boot, but a
    // gate that closed later must still refuse rather than serve a stream that
    // can only fail.
    configError: () => string | null;
    // How this source is named in user-facing frames ("SFTP", "S3").
    label: string;
  }
) {
  app.get<{ Params: { id: string } }>(
    options.path,
    {
      onRequest: (request, reply, done) => {
        request.raw.setTimeout(PUBLISH_SSE_TIMEOUT_MS);
        reply.raw.setTimeout(PUBLISH_SSE_TIMEOUT_MS);
        done();
      }
    },
    async (request, reply) => {
      // Gate before hijacking — see note 1 above.
      const configError = options.configError();

      if (configError) {
        return reply
          .code(503)
          .send({ error: "Service Unavailable", message: configError });
      }

      reply.hijack();
      const stream = reply.raw;
      stream.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin":
          (request.headers.origin as string | undefined) ?? "*"
      });

      const send = (payload: unknown) => {
        if (!stream.writableEnded) {
          stream.write(`data: ${JSON.stringify(payload)}\n\n`);
        }
      };

      const keepalive = setInterval(() => {
        if (!stream.writableEnded) {
          stream.write(": keepalive\n\n");
        }
      }, PUBLISH_SSE_KEEPALIVE_MS);
      keepalive.unref?.();

      let closed = false;
      const stop = () => {
        closed = true;
        clearInterval(keepalive);
      };
      request.raw.on("close", stop);

      const jobId = `${options.jobIdPrefix}-${request.params.id}`;
      let lastMessage = "";
      const startedAt = Date.now();

      try {
        for (;;) {
          if (closed) {
            return;
          }

          const job = await publishQueue.getJob(jobId);

          if (!job) {
            // The enqueue race — see note 3 above.
            if (Date.now() - startedAt < PUBLISH_SSE_JOB_GRACE_MS) {
              await new Promise((resolve) =>
                setTimeout(resolve, PUBLISH_SSE_POLL_MS)
              );
              continue;
            }

            send({
              type: "done",
              message: `No ${options.label} pull is running.`
            });
            break;
          }

          const state = await job.getState();
          const progress = job.progress as
            | {
                stage?: string;
                current?: number;
                total?: number;
                message?: string;
              }
            | number
            | undefined;

          if (progress && typeof progress === "object") {
            if (progress.message && progress.message !== lastMessage) {
              lastMessage = progress.message;
              send({
                type: "progress",
                stage: progress.stage ?? "pull",
                current: progress.current,
                total: progress.total,
                message: progress.message
              });
            }
          }

          if (state === "completed") {
            // Re-read so returnvalue is the persisted one — see note 2 above.
            const settled = (await publishQueue.getJob(jobId)) ?? job;
            const returned = settled.returnvalue as
              | {
                  stored?: number;
                  failed?: number;
                  total?: number;
                  domain?: string;
                }
              | undefined;

            send({
              type: "done",
              message: returned?.total
                ? `Pulled ${returned.stored ?? 0} of ${returned.total} file(s)${
                    returned.failed ? `, ${returned.failed} failed` : ""
                  }`
                : lastMessage || `${options.label} pull complete.`,
              result: returned
            });
            break;
          }

          if (state === "failed") {
            send({
              type: "error",
              message: job.failedReason || `${options.label} pull failed.`
            });
            break;
          }

          if (Date.now() - startedAt > PUBLISH_SSE_TIMEOUT_MS) {
            send({
              type: "error",
              message: `Stopped following this ${options.label} pull — it is taking unusually long.`
            });
            break;
          }

          await new Promise((resolve) =>
            setTimeout(resolve, PUBLISH_SSE_POLL_MS)
          );
        }
      } catch (error) {
        send({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : `Could not follow ${options.label} pull`
        });
      } finally {
        stop();

        if (!stream.writableEnded) {
          stream.end();
        }
      }
    }
  );
}
