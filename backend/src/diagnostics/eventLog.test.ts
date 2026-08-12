import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  dayStamp,
  deleteSessionDiagnostics,
  flushEventLog,
  initEventLog,
  logDiagnosticEvent
} from "./eventLog.js";

// AGAINST A REAL DIRECTORY, with real files and real appends.
//
// The behaviour under test IS filesystem behaviour — concurrent O_APPEND writes, a size
// cap read back off disk, a delete that has to find files across day directories — so a
// mocked fs would prove nothing. Same discipline as staleArtifactSweep.test.ts.

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_SESSION = "11111111-2222-3333-4444-555555555555";

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "eventlog-test-"));
}

function sessionFile(dir: string, session = SESSION, at = new Date()) {
  return path.join(dir, "host-strategy", dayStamp(at), `${session}.jsonl`);
}

function readLines(file: string) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("an event lands as one JSONL line, stamped with who wrote it", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", SESSION, {
    host: "www.example.com",
    verdict: "REFUSED"
  });
  await flushEventLog();

  const lines = readLines(sessionFile(dir));

  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, "host_strategy_resolved");
  assert.equal(lines[0].session_id, SESSION);
  assert.equal(lines[0].verdict, "REFUSED");
  // service and pid answer "which of the two containers observed this", which is the
  // first question when the API and the worker disagree about a host.
  assert.equal(lines[0].service, "worker");
  assert.equal(lines[0].pid, process.pid);
  assert.match(String(lines[0].ts), /^\d{4}-\d{2}-\d{2}T/);
});

test("each session gets its own file, so concurrent users never interleave", async () => {
  const dir = tempDir();

  initEventLog({ service: "backend", dir, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", SESSION, { host: "a.example.com" });
  logDiagnosticEvent("host_strategy_resolved", OTHER_SESSION, { host: "b.example.com" });
  await flushEventLog();

  assert.equal(readLines(sessionFile(dir, SESSION)).length, 1);
  assert.equal(readLines(sessionFile(dir, OTHER_SESSION)).length, 1);
  assert.equal(readLines(sessionFile(dir, SESSION))[0].host, "a.example.com");
});

test("events are written in the order they were logged", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });

  for (let index = 0; index < 25; index += 1) {
    logDiagnosticEvent("host_strategy_rung_attempt", SESSION, { index });
  }

  await flushEventLog();

  // Callers do not await these writes, so ordering is the writer's job (a promise
  // chain). Out-of-order rung attempts would make a ladder unreadable — which rung
  // stopped it is the whole diagnosis.
  const lines = readLines(sessionFile(dir));

  assert.deepEqual(
    lines.map((line) => line.index),
    Array.from({ length: 25 }, (_unused, index) => index)
  );
});

test("nothing is written when diagnostics are disabled", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: false });
  logDiagnosticEvent("host_strategy_resolved", SESSION, { host: "www.example.com" });
  await flushEventLog();

  assert.equal(existsSync(path.join(dir, "host-strategy")), false);
});

// --- IT CANNOT THROW, and that is the point ---------------------------------
// Everything here is optional work: a record of what happened, not part of making it
// happen. An unmounted /diagnostics has to be a non-event for the caller — the same
// lesson the host-strategy pre-flight learned when an optional subsystem could mark a
// whole session FAILED.

test("an unwritable directory does not throw and does not stop later writes", async () => {
  const dir = tempDir();
  const blocked = path.join(dir, "blocked");

  // A FILE where the writer expects to create a directory: mkdir then fails with
  // ENOTDIR on every platform, including Windows, where chmod is largely advisory.
  await writeFile(blocked, "not a directory\n", "utf8");
  initEventLog({ service: "worker", dir: blocked, enabled: true });

  // The assertion is that this line does not reject and does not throw synchronously.
  logDiagnosticEvent("host_strategy_resolved", SESSION, { host: "www.example.com" });
  await flushEventLog();

  // And the writer is still usable afterwards — one failed write must not poison the
  // promise chain for every event that follows.
  const good = tempDir();

  initEventLog({ service: "worker", dir: good, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", SESSION, { host: "www.example.com" });
  await flushEventLog();

  assert.equal(readLines(sessionFile(good)).length, 1);
});

test("a missing session id lands in _unattributed rather than being dropped", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", "   ", { host: "www.example.com" });
  await flushEventLog();

  // This file should ALWAYS be empty in production: every caller provably has a session.
  // It exists so a plumbing mistake is LOUD instead of silently dropped — a fallback
  // that quietly absorbed them would become a junk drawer nobody reads.
  const lines = readLines(
    path.join(dir, "host-strategy", dayStamp(new Date()), "_unattributed.jsonl")
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].session_id, null);
});

// --- the size cap -----------------------------------------------------------

test("the file cap stops appending and says so once", async () => {
  const dir = tempDir();

  // Small enough that a handful of lines crosses it.
  initEventLog({ service: "worker", dir, enabled: true, maxFileBytes: 900 });

  for (let index = 0; index < 40; index += 1) {
    logDiagnosticEvent("host_strategy_rung_attempt", SESSION, {
      index,
      host: "www.example.com"
    });
  }

  await flushEventLog();

  const file = sessionFile(dir);
  const lines = readLines(file);
  const truncated = lines.filter((line) => line.event === "diagnostics_truncated");

  // A HARD STOP, not a rotation: reaching 32MB of these events in production means a
  // call site regressed to per-URL logging, and rotating would consume the volume while
  // hiding it.
  assert.equal(truncated.length, 1, "exactly one truncation notice");
  assert.equal(
    lines[lines.length - 1].event,
    "diagnostics_truncated",
    "the notice is the LAST line — nothing may follow it"
  );
  assert.ok(lines.length < 40, `expected some events dropped, wrote ${lines.length}`);
});

test("every line stays under the atomic-append size, even with a huge field", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", SESSION, {
    host: "www.example.com",
    // A pathological field. Two processes append to one file, and on Linux only writes
    // below PIPE_BUF (4096) are atomic — a longer line could be torn by the other
    // container mid-write, corrupting BOTH records.
    probe_url: `https://www.example.com/${"x".repeat(8000)}`
  });
  await flushEventLog();

  const file = sessionFile(dir);
  const raw = readFileSync(file, "utf8");

  for (const line of raw.split("\n").filter((entry) => entry.trim() !== "")) {
    assert.ok(
      Buffer.byteLength(`${line}\n`) <= 4096,
      `line of ${Buffer.byteLength(line)} bytes exceeds the atomic append size`
    );
  }

  const lines = readLines(file);

  // Clamped rather than dropped: the identity of the event survives and the loss is
  // stated, so a reader is never left guessing whether an event happened.
  assert.equal(lines[0].event, "host_strategy_resolved");
  assert.equal(lines[0].diagnostics_line_oversized, true);
  assert.equal(lines[0].host, "www.example.com");
});

test("two writers appending to one session file produce no torn lines", async () => {
  const dir = tempDir();

  initEventLog({ service: "backend", dir, enabled: true });

  // Interleaved from one process is the closest a unit test gets to the real case
  // (backend and worker appending at once); what it actually pins is that every write
  // is ONE appendFile of one complete line, which is the property the atomicity
  // guarantee rests on.
  for (let index = 0; index < 50; index += 1) {
    logDiagnosticEvent("host_strategy_rung_attempt", SESSION, { index });
    logDiagnosticEvent("host_strategy_skipped", SESSION, { index });
  }

  await flushEventLog();

  const raw = readFileSync(sessionFile(dir), "utf8");

  assert.ok(raw.endsWith("\n"), "the file must end on a line boundary");

  for (const line of raw.split("\n").filter((entry) => entry.trim() !== "")) {
    // A torn line fails to parse. That is the whole assertion.
    JSON.parse(line);
  }

  assert.equal(readLines(sessionFile(dir)).length, 100);
});

// --- the .keep marker -------------------------------------------------------

test("a REFUSED verdict marks the session as worth keeping", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", SESSION, {
    host: "www.example.com",
    verdict: "REFUSED"
  });
  await flushEventLog();

  const marker = path.join(
    dir,
    "host-strategy",
    dayStamp(new Date()),
    `${SESSION}.keep`
  );

  assert.equal(existsSync(marker), true);
});

test("a skipped pattern marks the session as worth keeping", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });
  logDiagnosticEvent("host_strategy_skipped", SESSION, { host: "www.example.com" });
  await flushEventLog();

  assert.equal(
    existsSync(
      path.join(dir, "host-strategy", dayStamp(new Date()), `${SESSION}.keep`)
    ),
    true
  );
});

test("an ordinary healthy session is NOT marked", async () => {
  const dir = tempDir();

  initEventLog({ service: "worker", dir, enabled: true });
  logDiagnosticEvent("host_strategy_resolved", SESSION, {
    host: "www.example.com",
    verdict: "OK"
  });
  await flushEventLog();

  assert.equal(
    existsSync(
      path.join(dir, "host-strategy", dayStamp(new Date()), `${SESSION}.keep`)
    ),
    false
  );
});

// --- the success-triggered delete -------------------------------------------

async function seedDay(dir: string, day: string, session: string, keep = false) {
  const dayDir = path.join(dir, "host-strategy", day);

  await mkdir(dayDir, { recursive: true });
  await writeFile(
    path.join(dayDir, `${session}.jsonl`),
    `${JSON.stringify({ event: "host_strategy_resolved", session_id: session })}\n`,
    "utf8"
  );

  if (keep) {
    await writeFile(path.join(dayDir, `${session}.keep`), "{}\n", "utf8");
  }

  return dayDir;
}

test("the delete reaches EVERY day directory, not just today's", async () => {
  const dir = tempDir();

  initEventLog({ service: "backend", dir, enabled: true });
  await seedDay(dir, "2026-08-10", SESSION);
  await seedDay(dir, "2026-08-11", SESSION);
  await seedDay(dir, "2026-08-12", SESSION);
  // Another session's files must be untouched.
  await seedDay(dir, "2026-08-12", OTHER_SESSION);

  const result = await deleteSessionDiagnostics(SESSION, { dir });

  // A session legitimately spans days — a run crossing midnight, or a per-pattern
  // re-check days after the original analysis. A delete scoped to today would leave
  // most of a session behind and report success.
  assert.equal(result.filesRemoved, 3);
  assert.ok(result.bytesFreed > 0);
  assert.equal(
    existsSync(path.join(dir, "host-strategy", "2026-08-10", `${SESSION}.jsonl`)),
    false
  );
  assert.equal(
    existsSync(
      path.join(dir, "host-strategy", "2026-08-12", `${OTHER_SESSION}.jsonl`)
    ),
    true
  );
});

test("a .keep marker makes a session untouchable", async () => {
  const dir = tempDir();

  await seedDay(dir, "2026-08-11", SESSION, true);

  const result = await deleteSessionDiagnostics(SESSION, { dir });

  // THE ASSERTION THAT MATTERS MOST. A successful S3 publish says nothing about whether
  // the checker could see the site, so "it published" must never erase "and we could not
  // check any of it" — which is the only run anyone will want to read later.
  assert.equal(result.filesRemoved, 0);
  assert.equal(result.kept, 1);
  assert.equal(
    existsSync(path.join(dir, "host-strategy", "2026-08-11", `${SESSION}.jsonl`)),
    true
  );
});

test("a minimum age keeps the most recent runs", async () => {
  const dir = tempDir();
  const day = dayStamp(new Date());

  await seedDay(dir, day, SESSION);

  const file = sessionFile(dir, SESSION);
  const kept = await deleteSessionDiagnostics(SESSION, {
    dir,
    minAgeMs: 24 * 60 * 60 * 1000
  });

  assert.equal(kept.filesRemoved, 0);
  assert.equal(kept.kept, 1);
  assert.equal(existsSync(file), true);

  // Same file, evaluated as if a day had passed: now eligible.
  const removed = await deleteSessionDiagnostics(SESSION, {
    dir,
    minAgeMs: 24 * 60 * 60 * 1000,
    now: statSync(file).mtimeMs + 25 * 60 * 60 * 1000
  });

  assert.equal(removed.filesRemoved, 1);
  assert.equal(existsSync(file), false);
});

test("deleting from a directory that does not exist is not an error", async () => {
  const result = await deleteSessionDiagnostics(SESSION, {
    dir: path.join(tempDir(), "never-written")
  });

  assert.deepEqual(result, { filesRemoved: 0, bytesFreed: 0, kept: 0 });
});

test("the delete refuses to act on an empty session id", async () => {
  const dir = tempDir();
  const dayDir = await seedDay(dir, "2026-08-11", "_unattributed");
  const result = await deleteSessionDiagnostics("  ", { dir });

  // Otherwise a caller with a missing id would wipe the very file that exists to make
  // that mistake visible.
  assert.equal(result.filesRemoved, 0);
  assert.equal(existsSync(path.join(dayDir, "_unattributed.jsonl")), true);
});

// Referenced so the import is not flagged unused on platforms where the chmod-based
// permission test is not meaningful; the ENOTDIR case above is the portable one.
void chmod;
void readdirSync;
