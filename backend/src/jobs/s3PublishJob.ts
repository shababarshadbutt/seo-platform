import type { Job } from "bullmq";
import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { deleteSessionDiagnostics } from "../diagnostics/eventLog.js";
import { withPublishLock } from "../publish/publishLock.js";
import { resolvePublishTarget } from "../publish/publishTarget.js";
import {
  buildPublishPlan,
  executePublish,
  type InvalidationOutcome,
  type PublishFailedFile
} from "../publish/s3Publish.js";
import type { S3PublishJobData } from "../queue/publishQueue.js";

// How many written keys go into the log line. A 1,600-file publish must not
// dump 1,600 keys, but the prefix has to be verifiable from the logs alone, and
// first+last is enough to establish it.
const LOGGED_KEY_SAMPLE = 3;

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
  // Files that could not be written after retries. A non-empty list is a
  // PARTIAL publish: everything else went live and these did not.
  failed_files: PublishFailedFile[];
  // What the CloudFront stage did. An error here does NOT mean the publish
  // failed — the objects are already on production.
  invalidation: InvalidationOutcome;
};

// Failed filenames included in the log line. Same reasoning as LOGGED_KEY_SAMPLE:
// bounded, but enough to start diagnosing without bucket access.
const LOGGED_FAILURE_SAMPLE = 10;

export async function processS3PublishJob(
  data: S3PublishJobData,
  logger: FastifyBaseLogger,
  // Progress is written to the BullMQ job so the SSE route can follow it
  // without the API process needing a channel back into this worker.
  job?: Job
): Promise<S3PublishJobResult> {
  const { session_id: sessionId, domain: queuedDomain } = data;

  // Re-check the flag HERE, not just at the route that enqueued this. A job can
  // outlive the process that queued it (retries, a restart with a changed .env),
  // and this one WRITES TO LIVE PRODUCTION, so it refuses rather than trusting
  // that the enqueue was gated. Checked before the lock so a refusal doesn't
  // occupy the domain.
  if (!config.awsPublishEnabled) {
    throw new Error(
      "S3 publish is disabled on this deployment (AWS_PUBLISH_ENABLED is not true)"
    );
  }

  // Re-resolved HERE from the database rather than taken from the job payload,
  // for the same reason the flag is re-checked above: a queued job can outlive
  // the request that created it, and this one overwrites live production. The
  // payload's domain is treated as a label to cross-check, never as the target.
  const target = await resolvePublishTarget(sessionId);
  const domain = target.prefixDomain;

  if (queuedDomain && queuedDomain !== domain) {
    // Not fatal — the resolved value is authoritative by design — but a
    // divergence means the session changed between enqueue and execution, and
    // that must not pass unrecorded on a path that overwrites production.
    logger.warn(
      {
        session_id: sessionId,
        queued_domain: queuedDomain,
        resolved_domain: domain,
        domain_source: target.source
      },
      "s3 publish: queued domain differs from the resolved publish target; using the resolved one"
    );
  }

  if (target.baseUrlHostIgnored) {
    // The exact divergence that caused the production incident. It is now
    // resolved in favour of the SFTP folder instead of silently picking the
    // base_url host, but it is still worth a log line every time it happens.
    logger.warn(
      {
        session_id: sessionId,
        sftp_domain: domain,
        base_url_host: target.baseUrlHostIgnored
      },
      "s3 publish: session base_url host differs from the SFTP source domain; the SFTP domain decides the prefix"
    );
  }

  return withPublishLock(domain, async () => {
    const plan = await buildPublishPlan(sessionId, target);

    // Written BEFORE the first PUT and before any refusal, so an attempt always
    // leaves a trace. Without this the only record was a BullMQ job (trimmed
    // after 100 completions, gone on a Redis flush) and two log lines, which
    // made "did a publish for this domain ever run?" unanswerable after the
    // fact — the exact question production trouble raises.
    const runResult = await pool.query<{ id: string }>(
      `
        INSERT INTO publish_runs (
          session_id, domain, public_host, domain_source, bucket, prefix, job_id,
          status, planned_file_count, missing_local_count, index_key
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'STARTED', $8, $9, $10)
        RETURNING id
      `,
      [
        sessionId,
        domain,
        target.publicHost,
        target.source,
        config.s3.bucket,
        plan.prefix,
        job?.id ?? null,
        plan.files.length,
        plan.missingLocal.length,
        `${plan.prefix}${plan.indexFilename}`
      ]
    );
    const runId = runResult.rows[0].id;

    logger.info(
      {
        publish_run_id: runId,
        session_id: sessionId,
        domain,
        // Logged explicitly: the bucket and the RESOLVED prefix are what a
        // "publish reported success but production is unchanged" report turns
        // on, and they are derived from base_url + a template, so they cannot be
        // reconstructed later from config alone.
        bucket: config.s3.bucket,
        prefix: plan.prefix,
        // Provenance of the prefix host, so a wrong prefix is traceable to the
        // rule that chose it rather than guessed at.
        domain_source: target.source,
        public_host: target.publicHost,
        files: plan.files.length,
        omitted_deleted: plan.omittedDeleted.length,
        // Non-zero here means the publish is about to refuse; logged at start so
        // the reason is visible even if the throw is caught somewhere upstream.
        missing_local: plan.missingLocal.length,
        missing_local_sample: plan.missingLocal.slice(0, 10),
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

    let result: Awaited<ReturnType<typeof executePublish>>;

    try {
      result = await executePublish(plan, {
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
    } catch (error) {
      // Stamp the audit row and log at ERROR before rethrowing. Rethrowing is
      // what marks the BullMQ job failed, which is what turns the UI's stream
      // into an error frame — but that stream only exists while the user is
      // watching, so the durable record is written here regardless.
      const message = error instanceof Error ? error.message : String(error);

      await pool
        .query(
          `
            UPDATE publish_runs
            SET status = 'FAILED', error = $2, finished_at = NOW()
            WHERE id = $1
          `,
          [runId, message]
        )
        .catch((updateError: unknown) => {
          // Never let the audit write mask the real failure.
          logger.error(
            { publish_run_id: runId, error: updateError },
            "could not record failed publish run"
          );
        });

      logger.error(
        {
          publish_run_id: runId,
          session_id: sessionId,
          domain,
          bucket: config.s3.bucket,
          prefix: plan.prefix,
          planned_files: plan.files.length,
          error
        },
        "s3 publish FAILED — production may be partially updated"
      );

      throw error;
    }

    // PARTIAL, not FAILED: some files did not make it, or the CDN invalidation
    // was rejected, but objects WERE written to production. Recording that as a
    // failure is the bug this status exists to fix — a fully successful
    // 2,651-file publish whose invalidation was rejected used to be stamped
    // FAILED with uploaded_count left at 0, destroying the only durable evidence
    // that production had in fact been updated.
    const partial =
      result.failed_files.length > 0 || result.invalidation.error !== null;

    const summary =
      result.failed_files.length > 0
        ? `Published ${result.uploaded} of ${
            plan.files.length + 1
          } file(s) — ${result.failed_files.length} not published`
        : partial
          ? `Published ${result.uploaded} file(s) — CDN invalidation incomplete`
          : `Published ${result.uploaded} file(s)`;

    const resultPayload: S3PublishJobResult = {
      uploaded: result.uploaded,
      bytes: result.bytes,
      index_key: result.index_key,
      omitted_deleted: result.omitted_deleted,
      invalidation_id: result.invalidation_id,
      failed_files: result.failed_files,
      invalidation: result.invalidation
    };

    await job?.updateProgress({
      stage: "done",
      current: result.uploaded,
      total: result.uploaded,
      message: summary,
      result: resultPayload
    });

    await pool.query(
      `
        UPDATE publish_runs
        SET status = $6,
            uploaded_count = $2,
            bytes = $3,
            index_key = $4,
            invalidation_id = $5,
            failed_file_count = $7,
            failed_files = $8::jsonb,
            invalidation_strategy = $9,
            invalidation_error = $10,
            finished_at = NOW()
        WHERE id = $1
      `,
      [
        runId,
        result.uploaded,
        result.bytes,
        result.index_key,
        result.invalidation_id,
        partial ? "PARTIAL" : "COMPLETE",
        result.failed_files.length,
        result.failed_files.length > 0
          ? JSON.stringify(result.failed_files)
          : null,
        result.invalidation.strategy,
        result.invalidation.error
      ]
    );

    // A partial publish is a warning, not information: someone has to re-run
    // the named files. A clean one stays at info.
    logger[partial ? "warn" : "info"](
      {
        publish_run_id: runId,
        session_id: sessionId,
        domain,
        bucket: config.s3.bucket,
        prefix: plan.prefix,
        uploaded: result.uploaded,
        bytes: result.bytes,
        invalidation_id: result.invalidation_id,
        invalidation_strategy: result.invalidation.strategy,
        invalidation_paths: result.invalidation.paths_requested,
        // Non-null means the bytes are live but the edge may serve stale
        // sitemaps until their TTL lapses. Explicitly NOT a publish failure.
        invalidation_error: result.invalidation.error,
        failed_files: result.failed_files.length,
        failed_files_sample: result.failed_files
          .slice(0, LOGGED_FAILURE_SAMPLE)
          .map((file) => file.filename),
        // A bounded sample of the ACTUAL keys written. "Publish succeeded but
        // the object is untouched" is usually a right-publish-wrong-prefix, and
        // this is what proves which prefix got the bytes.
        first_keys: result.written_keys.slice(0, LOGGED_KEY_SAMPLE),
        index_key: result.index_key
      },
      partial ? "s3 publish PARTIAL" : "s3 publish complete"
    );

    // OPTIONAL space reclamation, OFF by default.
    //
    // The daily sweep is the primary mechanism and stays that way: most sessions never
    // publish at all, so a publish-triggered delete could never cover the abandoned and
    // failed runs that actually accumulate. This exists so that if disk pressure ever
    // becomes real the knob is already written and tested.
    //
    // Two things protect the evidence, both inside deleteSessionDiagnostics: a session
    // whose host REFUSED us (or whose patterns were skipped) carries a .keep marker and
    // is never touched, and a minimum age keeps the most recent runs regardless. A
    // successful publish says nothing about whether the checker could see the site, so
    // "it published" must not be allowed to erase "and we could not check any of it".
    // `!partial` as well as the flag: a publish that left files behind still
    // needs its evidence for the re-run, so reclaiming disk on a partial success
    // would delete exactly the diagnostics someone is about to go looking for.
    if (config.diagnostics.deleteOnSuccess && !partial) {
      const reclaimed = await deleteSessionDiagnostics(sessionId, {
        minAgeMs:
          config.diagnostics.deleteOnSuccessMinAgeHours * 60 * 60 * 1000
      }).catch((error) => {
        // Best-effort, exactly like every other write in that module: a publish that
        // succeeded must not be reported as failed because a log file would not delete.
        logger.warn(
          { session_id: sessionId, error },
          "could not clean up this session's diagnostics after a successful publish"
        );

        return null;
      });

      if (reclaimed && (reclaimed.filesRemoved > 0 || reclaimed.kept > 0)) {
        logger.info(
          {
            session_id: sessionId,
            files_removed: reclaimed.filesRemoved,
            bytes_freed: reclaimed.bytesFreed,
            // Days kept because the session was interesting (a .keep marker) or too
            // recent. A non-zero count here is the guard working, not a failure.
            kept: reclaimed.kept
          },
          "diagnostics cleaned up after a successful publish"
        );
      }
    }

    // Returned, not just written to progress: BullMQ persists a job's return
    // value ATOMICALLY as part of marking it completed, whereas progress is a
    // separate write that can still be in flight when a watcher first observes
    // the completed state. The SSE route reads this for its terminal frame so
    // the summary is never a stale mid-upload message.
    return resultPayload;
  });
}
