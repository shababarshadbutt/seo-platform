import { readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import { config } from "../config.js";

// Defined HERE rather than alongside the queue constants: the queue module builds a
// BullMQ Queue (and a Redis connection) at import time, so importing a number from
// it would drag Redis into every consumer — including this module's unit tests,
// which must run on a bare filesystem.
//
// SIX HOURS, and the number is doing real work. The primary cleanup for a run dir is
// an in-process setTimeout (RUN_TTL_MS, 1 hour after the run is cached), so this only
// ever fires for runs whose timer never got the chance — an API restart or crash. It
// must therefore sit comfortably above "longest plausible run + that 1h retention":
// the SFTP pull alone has been measured at ~25 minutes for 2,264 files, and a large
// clean adds minutes more. Six hours clears that by a wide margin while still
// bounding a leak to a fraction of a day. The sweep also treats a run as fresh if any
// of its immediate children were touched recently, so a genuinely long clean is never
// swept out from under itself.
// Driven by CLEANER_RUN_MAX_AGE_HOURS (config.cleanerRunMaxAgeMs, default 6h).
//
// That env var and config key shipped on main in v1.50 and were then read NOWHERE
// for three releases, while a docker-compose comment claimed a sweep consumed
// them. This module is that missing consumer. Read through a function rather than
// captured at module load so a test can move it.
export function cleanerRunMaxAgeMs(): number {
  return config.cleanerRunMaxAgeMs;
}

// AGE-BASED, RESTART-SAFE sweep of the uploads volume for artifacts whose only
// other cleanup lives in process memory.
//
// THE LEAK THIS EXISTS FOR. A Cleaner run's working directory
// (<uploadDir>/cleaner/<runId>/, holding the spilled inputs, the cleaned outputs,
// the dedup bucket spill files under out/.cleaner-scratch/, and the generated ZIP)
// is removed by a setTimeout scheduled in storeRun — RUN_TTL_MS after the run is
// cached. That timer lives in the API process and nothing else knows the directory
// exists, so an API restart or crash in that window orphans the whole directory
// PERMANENTLY. Reproduced: a 14MB run dir survived a hard kill of the API, a full
// restart, and a worker running every pre-existing periodic and backstop job.
//
// WHY THE EXISTING BACKSTOPS DID NOT COVER IT. There were two, and both are
// scoped in ways that exclude this:
//   * deleteSessionUploads (the 48h cleanup-uploads job) matches uploadDir entries
//     by `entry.isFile() && name.startsWith("<sessionId>-")`. A run directory is a
//     DIRECTORY, and it is keyed by RUN id, not session id — it fails both tests.
//     A Cleaner run also has no session until the handoff, so there is no session
//     whose cleanup could ever own it.
//   * processCleanupZipsJob only ever reads config.exportDir.
// So this is a genuine gap rather than a redundant third sweep, and it is the class
// of bug this codebase has hit repeatedly: cleanup that assumes an in-memory timer
// always fires, with nothing durable behind it.
//
// It is filesystem-driven ON PURPOSE. It consults no Map, no job row and no DB
// table — it looks at what is actually on disk and how old it is, which is the only
// signal that survives the process that created it.

// Diagnostics retention. SEVEN DAYS, matching the horizon an investigation actually
// spans: the "Not scored" question took a week of screenshots to settle, and a window
// shorter than that would have expired the evidence mid-diagnosis.
//
// This is a real cap, not decoration. The VM has already had one disk-growth incident
// from logs nobody bounded (d8ca7df4, uncapped container logs), and writing per-session
// JSONL without a sweep would be the same mistake with a different filename.
export const DIAGNOSTICS_RETENTION_DAYS_DEFAULT = 7;

export type SweepResult = {
  cleanerRunsRemoved: number;
  cleanerBytesFreed: number;
  partFilesRemoved: number;
  partBytesFreed: number;
  diagnosticFilesRemoved: number;
  diagnosticBytesFreed: number;
};

// A directory's own mtime changes when entries are added or removed directly in it,
// NOT when a file deep inside is written. A run dir creates in/ and out/ up front,
// so its own mtime can be stale while the run is very much alive. Taking the newest
// mtime across the directory and its immediate children makes an active run look
// fresh, so a long clean can never be swept out from under itself.
async function newestMtimeMs(dir: string): Promise<number> {
  let newest = 0;

  try {
    newest = (await stat(dir)).mtimeMs;
  } catch {
    return 0;
  }

  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return newest;
  }

  for (const entry of entries) {
    try {
      const info = await stat(path.join(dir, entry));

      if (info.mtimeMs > newest) {
        newest = info.mtimeMs;
      }
    } catch {
      // Raced with a delete; the other candidates still decide the answer.
    }
  }

  return newest;
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;

  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
      continue;
    }

    try {
      total += (await stat(full)).size;
    } catch {
      // Gone mid-walk.
    }
  }

  return total;
}

// Cleaner run working directories older than the cutoff.
async function sweepCleanerRuns(
  uploadDir: string,
  logger: FastifyBaseLogger,
  now: number
): Promise<{ removed: number; bytes: number }> {
  const root = path.join(uploadDir, "cleaner");
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // No cleaner root yet — nothing has ever run here.
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(root, entry.name);
    const newest = await newestMtimeMs(dir);
    const age = now - newest;

    if (newest === 0 || age <= cleanerRunMaxAgeMs()) {
      continue;
    }

    // Size measured BEFORE the delete so the log line can report what was actually
    // reclaimed rather than an estimate.
    const size = await directorySizeBytes(dir);

    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
      bytes += size;
      logger.warn(
        {
          run_dir: entry.name,
          age_hours: Math.round(age / 3_600_000),
          bytes: size
        },
        "stale sweep: removed an orphaned Cleaner run directory (its in-process TTL timer never fired — API restart or crash)"
      );
    } catch (error) {
      logger.error(
        { run_dir: entry.name, error },
        "stale sweep: could not remove a Cleaner run directory"
      );
    }
  }

  return { removed, bytes };
}

// Half-written copies from the handoff ingest: <stored>.<uuid>.part. The ingest
// renames its temp into place the moment the copy completes and unlinks it on a
// handled failure, so any .part still around minutes later belongs to a process
// that died mid-copy. They carry the session-id prefix, so deleteSessionUploads
// does reach them — but only for a session that actually reaches its 48h cleanup,
// which a session abandoned before completion never does.
async function sweepPartFiles(
  uploadDir: string,
  logger: FastifyBaseLogger,
  now: number
): Promise<{ removed: number; bytes: number }> {
  let entries;

  try {
    entries = await readdir(uploadDir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }

  let removed = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".part")) {
      continue;
    }

    const full = path.join(uploadDir, entry.name);

    try {
      const info = await stat(full);

      if (now - info.mtimeMs <= cleanerRunMaxAgeMs()) {
        continue;
      }

      await unlink(full);
      removed += 1;
      bytes += info.size;
      logger.warn(
        { file: entry.name, bytes: info.size },
        "stale sweep: removed an abandoned partial copy"
      );
    } catch {
      // Already gone, or not ours to remove.
    }
  }

  return { removed, bytes };
}

// Host-strategy diagnostics, which are laid out as
// <diagnosticsDir>/host-strategy/<YYYY-MM-DD>/<session_id>.jsonl.
//
// TWO limits, because they fail differently. Age is the normal mechanism and does the
// work every day. The total ceiling is the backstop for the one bug that would matter:
// a call site regressing to per-URL logging, which at 1.3M URLs would fill a volume long
// before anything was seven days old. Deleting oldest-day-first when over the ceiling
// keeps whatever is most likely to be under investigation right now.
export async function sweepDiagnostics(
  diagnosticsDir: string,
  logger: FastifyBaseLogger,
  limits: { retentionDays: number; maxTotalBytes: number },
  now: number
): Promise<{ removed: number; bytes: number }> {
  const root = path.join(diagnosticsDir, "host-strategy");
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // Nothing has ever been written — the usual case on a box where the volume is not
    // mounted, and not an error.
    return { removed: 0, bytes: 0 };
  }

  // Day directories sort lexicographically BECAUSE the name is an ISO date. That is the
  // reason the writer uses YYYY-MM-DD and UTC rather than anything friendlier: oldest
  // first needs no parsing and cannot be fooled by a local timezone change.
  const days = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const maxAgeMs = limits.retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now - maxAgeMs).toISOString().slice(0, 10);
  let removed = 0;
  let bytes = 0;
  const survivors: Array<{ day: string; dir: string; size: number }> = [];

  for (const day of days) {
    const dir = path.join(root, day);
    const size = await directorySizeBytes(dir);

    // String comparison on ISO dates, so a day directory is removed once the DAY it
    // names is older than the cutoff day — no partial-day arithmetic and no surprise
    // deletion of today's file at 00:01.
    if (day < cutoff) {
      try {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
        bytes += size;
        logger.info(
          { day, bytes: size, retention_days: limits.retentionDays },
          "diagnostics sweep: removed a day past the retention window"
        );
      } catch (error) {
        logger.error(
          { day, error },
          "diagnostics sweep: could not remove a day directory"
        );
      }

      continue;
    }

    survivors.push({ day, dir, size });
  }

  let total = survivors.reduce((sum, entry) => sum + entry.size, 0);

  for (const entry of survivors) {
    if (total <= limits.maxTotalBytes) {
      break;
    }

    try {
      await rm(entry.dir, { recursive: true, force: true });
      removed += 1;
      bytes += entry.size;
      total -= entry.size;
      // WARN, not info: reaching this ceiling means something is writing far more than
      // the bounded per-host/per-pattern events these files are supposed to contain.
      // The deletion is the symptom; the call site is the bug.
      logger.warn(
        {
          day: entry.day,
          bytes: entry.size,
          total_after: total,
          max_total_bytes: limits.maxTotalBytes
        },
        "diagnostics sweep: over the total size ceiling — removed the oldest surviving day. Something is very likely logging per-URL"
      );
    } catch (error) {
      logger.error(
        { day: entry.day, error },
        "diagnostics sweep: could not remove a day directory while over the size ceiling"
      );
    }
  }

  return { removed, bytes };
}

// `uploadDir` is a parameter rather than read from config so the sweep can be
// exercised against a temp directory with real files and real mtimes — the whole
// behaviour IS filesystem age, so a test that stubbed the filesystem would prove
// nothing. Same for `diagnostics`.
export async function sweepStaleArtifacts(
  uploadDir: string,
  logger: FastifyBaseLogger,
  diagnostics?: {
    dir: string;
    retentionDays: number;
    maxTotalBytes: number;
  }
): Promise<SweepResult> {
  const now = Date.now();
  const runs = await sweepCleanerRuns(uploadDir, logger, now);
  const parts = await sweepPartFiles(uploadDir, logger, now);
  const diagnosticSweep = diagnostics
    ? await sweepDiagnostics(
        diagnostics.dir,
        logger,
        {
          retentionDays: diagnostics.retentionDays,
          maxTotalBytes: diagnostics.maxTotalBytes
        },
        now
      )
    : { removed: 0, bytes: 0 };

  const result: SweepResult = {
    cleanerRunsRemoved: runs.removed,
    cleanerBytesFreed: runs.bytes,
    partFilesRemoved: parts.removed,
    partBytesFreed: parts.bytes,
    diagnosticFilesRemoved: diagnosticSweep.removed,
    diagnosticBytesFreed: diagnosticSweep.bytes
  };

  // Logged at info even when it found nothing, so "is the sweep running at all?"
  // is answerable from the logs — the previous cleanup's whole problem was being
  // invisible until a volume filled up.
  logger.info(result, "stale artifact sweep complete");

  return result;
}
