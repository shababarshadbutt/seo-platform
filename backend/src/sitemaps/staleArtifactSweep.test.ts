import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  CLEANER_RUN_MAX_AGE_MS,
  sweepStaleArtifacts
} from "./staleArtifactSweep.js";

// Real directories, real files, real mtimes (backdated with utimes). The whole
// behaviour under test IS filesystem age, so nothing here is stubbed.
//
// The two properties that matter in opposite directions:
//   * a run dir orphaned by a crash MUST eventually go, or the volume fills;
//   * a run still being written MUST NOT go, or a live clean loses its working
//     files mid-flight. A run dir's own mtime does not change when a file deep
//     inside it is written, which is exactly the trap that would make an active
//     run look ancient.

let uploadDir: string;

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {}
} as never;

const HOUR = 60 * 60 * 1000;

async function backdate(target: string, ageMs: number) {
  const when = new Date(Date.now() - ageMs);

  await utimes(target, when, when);
}

// A run dir shaped like the real thing: in/, out/, out/.cleaner-scratch/ spill
// files, and the generated ZIP.
async function makeRunDir(runId: string, ageMs: number) {
  const dir = path.join(uploadDir, "cleaner", runId);
  const scratch = path.join(dir, "out", ".cleaner-scratch");

  await mkdir(path.join(dir, "in"), { recursive: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(dir, "in", "src.xml"), "<urlset/>", "utf8");
  await writeFile(path.join(dir, "out", "cleaned.xml"), "<urlset/>", "utf8");
  await writeFile(path.join(scratch, ".bucket0.spill"), "k\tv\n", "utf8");
  await writeFile(path.join(dir, "cleaned.zip"), "PK", "utf8");

  // Deepest first: backdating a child must not re-touch its parent afterwards.
  for (const target of [
    path.join(scratch, ".bucket0.spill"),
    scratch,
    path.join(dir, "out", "cleaned.xml"),
    path.join(dir, "out"),
    path.join(dir, "in", "src.xml"),
    path.join(dir, "in"),
    path.join(dir, "cleaned.zip"),
    dir
  ]) {
    await backdate(target, ageMs);
  }

  return dir;
}

beforeEach(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "stale-sweep-"));
});

afterEach(async () => {
  await rm(uploadDir, { recursive: true, force: true });
});

describe("sweepStaleArtifacts — cleaner run directories", () => {
  it("removes a run directory orphaned past its TTL, spill files and all", async () => {
    const dir = await makeRunDir("orphaned-run", CLEANER_RUN_MAX_AGE_MS + HOUR);

    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(existsSync(dir), false, "the orphaned run directory survived");
    assert.equal(result.cleanerRunsRemoved, 1);
    assert.ok(
      result.cleanerBytesFreed > 0,
      "should report the bytes it actually reclaimed"
    );
  });

  it("LEAVES a run directory that is still young", async () => {
    const dir = await makeRunDir("fresh-run", 5 * 60 * 1000);

    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(existsSync(dir), true, "a fresh run directory was deleted");
    assert.equal(result.cleanerRunsRemoved, 0);
  });

  it("LEAVES an old directory whose inner files are being actively written", async () => {
    // The trap: the run dir and its in/ + out/ were created hours ago, but the
    // clean is still producing output. Judging by the run dir's own mtime alone
    // would delete a live run's working files.
    const dir = await makeRunDir("long-run", CLEANER_RUN_MAX_AGE_MS + HOUR);

    await writeFile(path.join(dir, "out", "just-written.xml"), "<urlset/>", "utf8");

    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(
      existsSync(dir),
      true,
      "a long-running clean was swept out from under itself"
    );
    assert.equal(result.cleanerRunsRemoved, 0);
  });

  it("sweeps only the stale runs when both kinds are present", async () => {
    const stale = await makeRunDir("stale", CLEANER_RUN_MAX_AGE_MS + HOUR);
    const fresh = await makeRunDir("fresh", 60 * 1000);

    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(result.cleanerRunsRemoved, 1);
  });

  it("does not touch session upload files in the same directory", async () => {
    // The sweep shares uploadDir with every session's stored sitemaps, which have
    // their own 48h owner. Deleting one of those would destroy live user data.
    const sessionFile = path.join(
      uploadDir,
      "11111111-2222-4333-8444-555555555555-current-sitemap.xml"
    );

    await writeFile(sessionFile, "<urlset/>", "utf8");
    await backdate(sessionFile, 30 * 24 * HOUR);
    await makeRunDir("stale", CLEANER_RUN_MAX_AGE_MS + HOUR);

    await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(
      existsSync(sessionFile),
      true,
      "the sweep deleted a session's stored sitemap"
    );
  });

  it("is a no-op when nothing has ever run", async () => {
    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.deepEqual(result, {
      cleanerRunsRemoved: 0,
      cleanerBytesFreed: 0,
      partFilesRemoved: 0,
      partBytesFreed: 0,
      // Reported as zero rather than omitted even when no diagnostics limits were
      // passed, so the "sweep complete" log line always has the same shape and
      // "is the diagnostics sweep running at all?" stays answerable from the logs.
      diagnosticFilesRemoved: 0,
      diagnosticBytesFreed: 0
    });
  });
});

describe("sweepStaleArtifacts — abandoned .part copies", () => {
  it("removes a .part file older than the cutoff", async () => {
    const part = path.join(
      uploadDir,
      "11111111-2222-4333-8444-555555555555-current-a.xml.abc123.part"
    );

    await writeFile(part, "half a file", "utf8");
    await backdate(part, CLEANER_RUN_MAX_AGE_MS + HOUR);

    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(existsSync(part), false, "the abandoned partial copy survived");
    assert.equal(result.partFilesRemoved, 1);
    assert.ok(result.partBytesFreed > 0);
  });

  it("LEAVES a .part file from a copy that may still be in flight", async () => {
    const part = path.join(uploadDir, "sess-current-b.xml.def456.part");

    await writeFile(part, "in progress", "utf8");

    const result = await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(existsSync(part), true, "deleted a copy that was still running");
    assert.equal(result.partFilesRemoved, 0);
  });

  it("does not mistake a real sitemap for a partial copy", async () => {
    const real = path.join(uploadDir, "sess-current-not-a-part.xml");

    await writeFile(real, "<urlset/>", "utf8");
    await backdate(real, 30 * 24 * HOUR);

    await sweepStaleArtifacts(uploadDir, silent);

    assert.equal(existsSync(real), true);
  });
});

// --- host-strategy diagnostics retention ------------------------------------
//
// The VM has already had one disk-growth incident from logs nobody bounded
// (d8ca7df4, uncapped container logs). Writing per-session JSONL without a sweep
// would be the same mistake with a different filename, so these are the tests
// that keep the promise.
describe("diagnostics retention", () => {
  let diagnosticsDir: string;

  beforeEach(async () => {
    diagnosticsDir = await mkdtemp(path.join(tmpdir(), "diag-sweep-"));
  });

  afterEach(async () => {
    await rm(diagnosticsDir, { recursive: true, force: true });
  });

  // Day directories are named YYYY-MM-DD in UTC, so seeding one is just a name.
  async function seedDay(day: string, bytes: number, sessions = 1) {
    const dir = path.join(diagnosticsDir, "host-strategy", day);

    await mkdir(dir, { recursive: true });

    for (let index = 0; index < sessions; index += 1) {
      await writeFile(
        path.join(dir, `session-${index}.jsonl`),
        "x".repeat(Math.max(1, Math.floor(bytes / sessions))),
        "utf8"
      );
    }

    return dir;
  }

  function dayOffset(days: number) {
    return new Date(Date.now() - days * 24 * HOUR).toISOString().slice(0, 10);
  }

  const limits = { retentionDays: 7, maxTotalBytes: 1024 * 1024 };

  it("removes days past the retention window and keeps the rest", async () => {
    const old = await seedDay(dayOffset(30), 100);
    const edge = await seedDay(dayOffset(8), 100);
    const fresh = await seedDay(dayOffset(1), 100);
    const today = await seedDay(dayOffset(0), 100);

    const result = await sweepStaleArtifacts(uploadDir, silent, {
      dir: diagnosticsDir,
      ...limits
    });

    assert.equal(existsSync(old), false);
    assert.equal(existsSync(edge), false);
    assert.equal(existsSync(fresh), true);
    // TODAY's file is the one someone is most likely to be reading right now. A sweep
    // that touched it would delete the evidence out from under an investigation.
    assert.equal(existsSync(today), true);
    assert.equal(result.diagnosticFilesRemoved, 2);
    assert.ok(result.diagnosticBytesFreed > 0);
  });

  it("keeps a day exactly at the edge of the window", async () => {
    const boundary = await seedDay(dayOffset(7), 100);

    await sweepStaleArtifacts(uploadDir, silent, {
      dir: diagnosticsDir,
      ...limits
    });

    // Compared as ISO date STRINGS, so "7 days old" is kept and only day 8 goes —
    // no partial-day arithmetic, and nothing disappears at 00:01.
    assert.equal(existsSync(boundary), true);
  });

  it("enforces the total ceiling oldest-first, even inside the window", async () => {
    // THE BACKSTOP, for the one bug that would matter: a call site regressing to
    // per-URL logging. At 1.3M URLs a volume fills long before anything is seven days
    // old, so age alone is not enough.
    const oldest = await seedDay(dayOffset(5), 4000);
    const middle = await seedDay(dayOffset(3), 4000);
    const newest = await seedDay(dayOffset(1), 4000);

    const result = await sweepStaleArtifacts(uploadDir, silent, {
      dir: diagnosticsDir,
      retentionDays: 7,
      maxTotalBytes: 9000
    });

    // Oldest goes first and it stops as soon as it is under the ceiling: whatever is
    // most likely to be under investigation survives.
    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(middle), true);
    assert.equal(existsSync(newest), true);
    assert.equal(result.diagnosticFilesRemoved, 1);
  });

  it("does nothing when the diagnostics directory was never written", async () => {
    const result = await sweepStaleArtifacts(uploadDir, silent, {
      dir: path.join(diagnosticsDir, "not-mounted"),
      ...limits
    });

    // The usual case on a box where the volume is not mounted. Not an error.
    assert.equal(result.diagnosticFilesRemoved, 0);
    assert.equal(result.diagnosticBytesFreed, 0);
  });

  it("leaves diagnostics completely alone when no limits are passed", async () => {
    const ancient = await seedDay(dayOffset(90), 100);

    const result = await sweepStaleArtifacts(uploadDir, silent);

    // The uploads sweep predates this and must keep working on its own. A caller that
    // does not ask for diagnostics retention must not get it as a side effect.
    assert.equal(existsSync(ancient), true);
    assert.equal(result.diagnosticFilesRemoved, 0);
  });
});
