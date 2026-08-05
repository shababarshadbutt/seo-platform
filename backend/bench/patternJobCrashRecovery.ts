// What happens to a pattern rename/transform job when the WORKER PROCESS dies
// mid-job? Does BullMQ ever re-run it, and if so does it resume or start over?
//
// Timers are shortened here (lockDuration 6s, stalledInterval 2s) so the stalled
// mechanism is observable in seconds instead of the hour production takes. The
// SEMANTICS being tested — whether the re-run resumes or restarts — do not depend
// on the timer values; production's 60-minute lockDuration only changes HOW LONG
// the job sits in limbo before recovery starts.
//
// Usage:
//   npx tsx bench/patternJobCrashRecovery.ts crash   <sessionId> <patternId>
//   npx tsx bench/patternJobCrashRecovery.ts recover
import { Worker } from "bullmq";

import { pool } from "../src/db/pool.js";
import { redisConnectionOptions } from "../src/queue/redisConnection.js";
import {
  BULK_REPLACE_QUEUE_NAME,
  PATTERN_TRANSFORM_JOB,
  type BulkReplaceJobName,
  type BulkReplaceQueueData,
  type PatternStructureJobData
} from "../src/queue/bulkReplaceQueue.js";
import { processPatternTransformJob } from "../src/jobs/patternStructureJob.js";

const MODE = process.argv[2];
const SHORT = { lockDuration: 6000, stalledInterval: 2000 };

const log = (m: string) => process.stdout.write(`${m}\n`);

// Minimal stand-in for the app logger the processor expects.
const logger = {
  info: (o: unknown, m?: string) => log(`  [job] ${m ?? ""} ${JSON.stringify(o)}`),
  warn: (o: unknown, m?: string) => log(`  [job:warn] ${m ?? ""}`),
  error: (o: unknown, m?: string) => log(`  [job:error] ${m ?? ""}`)
} as never;

async function progressOf(patternId: string) {
  const r = await pool.query<{
    status: string;
    files_done: number;
    files_total: number;
  }>(
    `SELECT status, files_done, files_total FROM pattern_structure_jobs
     WHERE pattern_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [patternId]
  );

  return r.rows[0] ?? null;
}

function makeWorker(onJob: (data: PatternStructureJobData) => Promise<void>) {
  return new Worker<BulkReplaceQueueData, void, BulkReplaceJobName>(
    BULK_REPLACE_QUEUE_NAME,
    async (job) => {
      if (job.name !== PATTERN_TRANSFORM_JOB) return;
      await onJob(job.data as PatternStructureJobData);
    },
    { connection: redisConnectionOptions(), concurrency: 1, ...SHORT }
  );
}

async function crash() {
  const patternId = process.argv[4];

  log("worker A up (short lock). Waiting for the transform job, then dying mid-run.");

  makeWorker(async (data) => {
    log(`  picked up job_row_id=${data.job_row_id}`);

    // Let the real processor start and get some files done, then die hard —
    // no COMMIT, no markFailed, exactly what a container kill looks like.
    void processPatternTransformJob(data, logger).catch(() => undefined);

    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const p = await progressOf(patternId);

      if (p && p.files_done > 0) {
        log(
          `  progress reached ${p.files_done}/${p.files_total} (status=${p.status}) — KILLING PROCESS NOW`
        );
        process.exit(137); // SIGKILL-like: no cleanup, no lock release
      }
    }

    log("  never saw progress; giving up");
    process.exit(1);
  });
}

async function recover() {
  log("worker B up (short lock). Watching whether BullMQ re-runs the stalled job.");
  let ran = false;

  makeWorker(async (data) => {
    ran = true;
    log(`  RE-RAN job_row_id=${data.job_row_id}`);
    await processPatternTransformJob(data, logger);
    log("  re-run finished");
  });

  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (ran) break;
  }

  if (!ran) log("  no re-run observed within 60s");

  await new Promise((r) => setTimeout(r, 3000));
  process.exit(0);
}

if (MODE === "crash") void crash();
else if (MODE === "recover") void recover();
else {
  log("usage: crash <sessionId> <patternId> | recover");
  process.exit(1);
}
