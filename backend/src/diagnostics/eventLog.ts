import { appendFile, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// DURABLE, PER-SESSION DIAGNOSTIC EVENTS.
//
// THE PROBLEM IT SOLVES. The host-strategy engine's only output was pino lines on
// stdout, and docker-compose.aws.yml caps every service at max-size 10m / max-file 3.
// On a busy box that is a rolling window measured in HOURS: by the time someone brings
// a screenshot of a page full of "Not scored" rows, the negotiation that produced it
// has already scrolled out of existence. Worse, several people run analyses at once, so
// even inside the window one session's story is interleaved with every other.
//
// So these events are ALSO written to a file per session per day. stdout keeps its
// copy — every existing `docker compose logs | grep` recipe still works — and the file
// is the copy that is still there tomorrow.
//
// DELIBERATELY NOT A LOGGING FRAMEWORK. It writes JSONL, it is bounded, and it cannot
// fail anything. That is the whole remit.

export type EventFields = Record<string, unknown>;

// The sink, as a type, so modules that must stay free of the filesystem (hostStrategy.ts
// and its no-Redis/no-Postgres/no-sockets test discipline) take this instead of importing
// the writer. `import type` is erased at compile time, so it loads nothing at runtime.
export type DiagnosticEmitter = (event: string, fields: EventFields) => void;

type EventLogOptions = {
  // Which process wrote the line. Both the API and the worker append to the SAME
  // session file, and "who observed this" is the first question when they disagree.
  service: string;
  dir: string;
  enabled: boolean;
  maxFileBytes: number;
};

// The subdirectory under the diagnostics root. One namespace for now; a second family
// of events would get its own rather than being mixed into these files.
const HOST_STRATEGY_DIR = "host-strategy";

// A file with no session id. It should ALWAYS be empty: resolveHostStrategy is only
// reachable through createHostStrategyRun, whose three callers (sampling, verification,
// triage) have each already loaded a session row. So this is not a fallback that
// quietly absorbs mistakes — it is where a missing id lands LOUDLY, and a non-empty
// file here is a defect in this module's plumbing rather than a finding about a site.
const UNATTRIBUTED = "_unattributed";

// ONE appendFile CALL PER LINE, AND EVERY LINE UNDER THIS.
//
// Two processes append to one session file. On Linux an O_APPEND write smaller than
// PIPE_BUF (4096) lands atomically, so their lines interleave cleanly and neither can
// observe a torn record. Splitting a line across two writes, or letting one grow past
// this, forfeits that guarantee — hence the clamp in serialise() rather than a comment
// asking callers to be careful.
const MAX_LINE_BYTES = 4096;

// Rate limit for complaining about our own failures. If /diagnostics is not mounted,
// every event would otherwise print a stack trace and the diagnostics would become the
// noise they exist to cut through.
const WARN_INTERVAL_MS = 60_000;

// DISABLED until something calls initEventLog. A module that started writing on import
// would write from unit tests and from any script that happens to pull in the engine.
const DEFAULTS: EventLogOptions = {
  service: "unknown",
  dir: "/diagnostics",
  enabled: false,
  maxFileBytes: 32 * 1024 * 1024
};

let options: EventLogOptions = { ...DEFAULTS };

// ORDERED, NOT AWAITED. Callers fire and forget — a disk write must never sit in the
// negotiation path — but the writes still have to land in the order they were made, so
// they chain onto one promise per process.
let tail: Promise<void> = Promise.resolve();

const ensuredDirs = new Set<string>();
// Bytes written per file BY THIS PROCESS. Seeded from the file on first touch so a
// restart (or the other container) does not reset the cap to zero. Two processes each
// keep their own counter, so the true ceiling is maxFileBytes per writer — documented
// rather than coordinated, because a shared counter would need a lock per line.
const bytesByFile = new Map<string, number>();
const cappedFiles = new Set<string>();
const markedSessions = new Set<string>();

let lastWarnedAt = 0;
let suppressedWarnings = 0;

// MERGED OVER THE DEFAULTS, never over the previous call. Each init is therefore a
// COMPLETE configuration: passing `{dir}` alone resets the size cap to its default
// rather than silently inheriting whatever the last caller set. Production calls this
// once, so the difference only shows up in tests — where inheriting a previous test's
// 900-byte cap made a later test look like the writer was dropping events.
export function initEventLog(overrides: Partial<EventLogOptions>): void {
  options = { ...DEFAULTS, ...overrides };
  ensuredDirs.clear();
  bytesByFile.clear();
  cappedFiles.clear();
  markedSessions.clear();
}

// Test seam. Nothing in production waits for a diagnostic write.
export async function flushEventLog(): Promise<void> {
  await tail;
}

export function hostStrategyRoot(dir: string = options.dir): string {
  return path.join(dir, HOST_STRATEGY_DIR);
}

// UTC, so a file name means the same thing to whoever reads it and cannot go backwards
// when a box's local zone changes.
export function dayStamp(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function sessionKey(sessionId: string): string {
  const trimmed = sessionId.trim();

  return trimmed === "" ? UNATTRIBUTED : trimmed;
}

function warn(message: string, error: unknown): void {
  const now = Date.now();

  if (now - lastWarnedAt < WARN_INTERVAL_MS) {
    suppressedWarnings += 1;
    return;
  }

  const suppressed = suppressedWarnings;

  lastWarnedAt = now;
  suppressedWarnings = 0;
  // process.stderr rather than the app logger: this module is imported by the engine,
  // and handing it a logger would make a diagnostics failure look like an application
  // error in the very stream it is meant to supplement.
  process.stderr.write(
    `${JSON.stringify({
      event: "diagnostics_write_failed",
      message,
      error: error instanceof Error ? error.message : String(error),
      suppressed_since_last: suppressed
    })}\n`
  );
}

function serialise(record: EventFields): string {
  const line = `${JSON.stringify(record)}\n`;

  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) {
    return line;
  }

  // Over the atomic-append size. Keep the identity of the event and say plainly that
  // fields were dropped, rather than writing a line that two processes could tear.
  return `${JSON.stringify({
    ts: record.ts,
    event: record.event,
    session_id: record.session_id,
    service: record.service,
    pid: record.pid,
    host: record.host,
    diagnostics_line_oversized: true,
    original_bytes: Buffer.byteLength(line)
  })}\n`;
}

async function ensureDir(dir: string): Promise<void> {
  if (ensuredDirs.has(dir)) {
    return;
  }

  await mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

async function currentSize(file: string): Promise<number> {
  const known = bytesByFile.get(file);

  if (known !== undefined) {
    return known;
  }

  try {
    const info = await stat(file);

    bytesByFile.set(file, info.size);

    return info.size;
  } catch {
    bytesByFile.set(file, 0);

    return 0;
  }
}

async function appendLine(file: string, line: string): Promise<void> {
  if (cappedFiles.has(file)) {
    return;
  }

  const size = await currentSize(file);
  const lineBytes = Buffer.byteLength(line);

  if (size + lineBytes > options.maxFileBytes) {
    // STOP, do not rotate. A session that can produce 32MB of these events is emitting
    // something per-URL, which is a bug in a call site — and rotating would hide it
    // while quietly consuming the volume. The final line makes the truncation explicit
    // so nobody reads the end of the file as the end of the story.
    cappedFiles.add(file);
    await appendFile(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event: "diagnostics_truncated",
        service: options.service,
        pid: process.pid,
        max_file_bytes: options.maxFileBytes,
        note: "file cap reached — no further events for this session on this day from this process"
      })}\n`,
      "utf8"
    );

    return;
  }

  await appendFile(file, line, "utf8");
  bytesByFile.set(file, size + lineBytes);
}

// A session worth KEEPING even if a later cleanup would otherwise remove it: one whose
// host refused us, or whose patterns were skipped. Those are the runs this whole feature
// exists for, and a successful publish says nothing about whether the checker could see
// the site.
//
// A marker FILE rather than a scan: the success-triggered delete then answers "is this
// interesting" with one existence check instead of reading up to 32MB per session, and
// `ls */*.keep` doubles as the list of interesting runs.
// private_route_failed is here, and private_route_selected deliberately is NOT: a
// working private route is the normal case for the whole fleet, and marking every
// session interesting would make the marker mean nothing. An ABANDONED route is the
// opposite — it silently moved a site family back onto the public path, which is
// exactly the run someone needs the diagnostics for a week later.
function isInteresting(event: string, fields: EventFields): boolean {
  return (
    event === "host_strategy_skipped" ||
    event === "private_route_failed" ||
    fields.verdict === "REFUSED"
  );
}

async function markInteresting(dir: string, key: string): Promise<void> {
  const marker = path.join(dir, `${key}.keep`);

  if (markedSessions.has(marker)) {
    return;
  }

  markedSessions.add(marker);
  await writeFile(
    marker,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      reason: "host refused us, or patterns were skipped — keep this session's diagnostics"
    })}\n`,
    "utf8"
  );
}

// THE ENTRY POINT. Fire and forget, and it CANNOT throw.
//
// Everything this module does is optional work: it is a record of what happened, not
// part of making it happen. An unmounted /diagnostics, a full disk or a permissions
// mistake must all be non-events for the caller — the same rule the host-strategy
// pre-flight had to learn the hard way, where an optional subsystem was able to mark a
// whole session FAILED.
//
// session_id is REQUIRED by the signature because every call site provably has one.
export function logDiagnosticEvent(
  event: string,
  sessionId: string,
  fields: EventFields = {},
  at: Date = new Date()
): void {
  if (!options.enabled) {
    return;
  }

  const key = sessionKey(sessionId);
  const record: EventFields = {
    ts: at.toISOString(),
    event,
    session_id: key === UNATTRIBUTED ? null : key,
    service: options.service,
    pid: process.pid,
    ...fields
  };
  const dir = path.join(hostStrategyRoot(), dayStamp(at));
  const file = path.join(dir, `${key}.jsonl`);
  const line = serialise(record);
  const interesting = isInteresting(event, fields);

  tail = tail
    .then(async () => {
      await ensureDir(dir);
      await appendLine(file, line);

      if (interesting) {
        await markInteresting(dir, key);
      }
    })
    .catch((error) => {
      warn(`could not write ${file}`, error);
    });
}

export type DeleteSessionResult = {
  filesRemoved: number;
  bytesFreed: number;
  kept: number;
};

// Remove one session's diagnostics, for the success-triggered cleanup in s3PublishJob.
//
// ACROSS EVERY DAY DIRECTORY, not just today's. A session legitimately spans days — a
// run that crosses midnight, or a per-pattern re-check days after the original
// analysis — so a delete scoped to today would leave most of a session behind and
// report success.
//
// Two things protect the evidence: a .keep marker (the host refused us, or patterns
// were skipped) makes a session untouchable here, and minAgeMs keeps the most recent
// runs regardless, so "it published five minutes ago" never means "and the record of it
// is already gone".
export async function deleteSessionDiagnostics(
  sessionId: string,
  deleteOptions: { minAgeMs?: number; now?: number; dir?: string } = {}
): Promise<DeleteSessionResult> {
  const result: DeleteSessionResult = {
    filesRemoved: 0,
    bytesFreed: 0,
    kept: 0
  };
  const key = sessionKey(sessionId);

  if (key === UNATTRIBUTED) {
    return result;
  }

  const root = hostStrategyRoot(deleteOptions.dir ?? options.dir);
  const minAgeMs = deleteOptions.minAgeMs ?? 0;
  const now = deleteOptions.now ?? Date.now();
  let days: string[];

  try {
    days = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return result;
  }

  for (const day of days) {
    const dir = path.join(root, day);
    const file = path.join(dir, `${key}.jsonl`);

    try {
      await stat(path.join(dir, `${key}.keep`));
      result.kept += 1;
      continue;
    } catch {
      // No marker — nothing about this session was interesting, so it is eligible.
    }

    try {
      const info = await stat(file);

      if (now - info.mtimeMs < minAgeMs) {
        result.kept += 1;
        continue;
      }

      await unlink(file);
      result.filesRemoved += 1;
      result.bytesFreed += info.size;
      bytesByFile.delete(file);
      cappedFiles.delete(file);
    } catch {
      // Not there, or not ours to remove. Either way there is nothing to reclaim.
    }
  }

  return result;
}
