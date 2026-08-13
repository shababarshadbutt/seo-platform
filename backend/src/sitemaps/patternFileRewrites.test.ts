import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { FastifyBaseLogger } from "fastify";

// The bugs these tests exist for, all of which the OLD code shipped:
//
//   try { await access(inputPath); } catch { continue; }
//   if (rewrittenLocCount === 0) { await unlink(outputPath).catch(() => {}); continue; }
//
// Both dropped a file with zero logging and zero counting, so a transform that
// rewrote NOTHING still answered 200 and the UI showed a green toast. Note that
// a "does not throw" test would have PASSED against that code — which is how it
// survived. These assert the returned accounting and the files on disk instead.

const dirs: string[] = [];
const SESSION = "11111111-2222-3333-4444-555555555555";

// rewritePatternFiles reads config.uploadDir, which is captured at module load,
// so UPLOAD_DIR must be set before the module graph is imported.
let uploadDir = "";
let rewritePatternFiles: typeof import("./patternFileRewrites.js")["rewritePatternFiles"];
let zeroWorkReason: typeof import("./patternFileRewrites.js")["zeroWorkReason"];
let destroyFileRewritePool: typeof import("../jobs/fileRewritePool.js")["destroyFileRewritePool"];

before(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "pattern-files-"));
  dirs.push(uploadDir);
  process.env.UPLOAD_DIR = uploadDir;

  ({ rewritePatternFiles, zeroWorkReason } = await import(
    "./patternFileRewrites.js"
  ));
  ({ destroyFileRewritePool } = await import("../jobs/fileRewritePool.js"));
});

after(async () => {
  // The piscina pool keeps the process alive otherwise.
  await destroyFileRewritePool();

  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.com/manufacturer/jamco-parts-catalog/widget-1</loc></url>
  <url><loc>https://site.com/manufacturer/acme-parts-catalog/widget-2</loc></url>
</urlset>
`;

const UNRELATED_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.com/blog/hello-world</loc></url>
</urlset>
`;

const TRANSFORM = {
  kind: "transform" as const,
  currentStructure: "/manufacturer/{A}/{B}",
  newStructure: "/manufacturer/{A|-parts-catalog||}/{B}/"
};

type LogLine = { level: string; payload: unknown; message: string };

function recordingLogger(lines: LogLine[]): FastifyBaseLogger {
  const record =
    (level: string) =>
    (payload: unknown, message?: string) => {
      lines.push({ level, payload, message: message ?? String(payload) });
    };

  const logger = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    trace: record("trace"),
    fatal: record("fatal"),
    silent: () => {},
    level: "info",
    child: () => logger
  };

  return logger as unknown as FastifyBaseLogger;
}

// Minimal stand-in for the caller's transaction client. rewritePatternFiles
// does exactly two things with it: read sitemap_files, and repoint filenames.
function fakeTx(rows: Array<{ id: string; filename: string }>) {
  const updates: Array<{ filename: string; id: string }> = [];

  return {
    updates,
    client: {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes("FROM sitemap_files")) {
          return { rows, rowCount: rows.length };
        }

        if (text.includes("UPDATE sitemap_files")) {
          updates.push({
            filename: values?.[0] as string,
            id: values?.[1] as string
          });
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`unexpected query: ${text}`);
      }
    }
  };
}

function context(rows: Array<{ id: string; filename: string }>) {
  const tx = fakeTx(rows);
  const progress: Array<[number, number, number]> = [];

  return {
    tx,
    progress,
    ctx: {
      tx: tx.client as never,
      progress: async (done: number, total: number, urls: number) => {
        progress.push([done, total, urls]);
      }
    }
  };
}

async function seed(name: string, body: string) {
  // displaySourceFilename strips the session-id prefix and the edit markers
  // (renamed-/fixed-/transformed-/...), NOT a source_role segment — so this
  // shape yields `name` as the display label.
  const stored = `${SESSION}-${name}`;
  await writeFile(path.join(uploadDir, stored), body, "utf-8");
  return { id: `id-${name}`, filename: stored };
}

test("a file missing from disk is COUNTED and LOGGED, not silently dropped", async () => {
  const present = await seed("present.xml", SITEMAP);
  const missing = { id: "id-gone", filename: `${SESSION}-gone.xml` };
  const lines: LogLine[] = [];
  const { ctx } = context([present, missing]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: [],
    operation: TRANSFORM,
    logger: recordingLogger(lines),
    keepZeroMatchRewrites: false
  });

  assert.equal(outcome.filesRewritten, 1);
  assert.deepEqual(outcome.skipped, [
    { file: "gone.xml", reason: "missing-on-disk" }
  ]);
  assert.ok(
    lines.some(
      (line) =>
        line.level === "warn" && line.message.includes("no longer on disk")
    ),
    "the skip was not logged"
  );
});

test("a file whose URLs do not match is counted as no-urls-matched and its copy is deleted", async () => {
  const matching = await seed("match.xml", SITEMAP);
  const unrelated = await seed("unrelated.xml", UNRELATED_SITEMAP);
  const before = (await readdir(uploadDir)).length;
  const { ctx, tx } = context([matching, unrelated]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: ["match.xml", "unrelated.xml"],
    operation: TRANSFORM,
    logger: recordingLogger([]),
    keepZeroMatchRewrites: false
  });

  assert.equal(outcome.filesRewritten, 1);
  assert.deepEqual(outcome.skipped, [
    { file: "unrelated.xml", reason: "no-urls-matched" }
  ]);
  // Only the matching file was repointed...
  assert.equal(tx.updates.length, 1);
  // ...and the discarded copy really is gone: one net new file, not two.
  assert.equal((await readdir(uploadDir)).length, before + 1);
});

test("a URL-sourced sitemap is reported as remote-source, not treated as missing", async () => {
  const remote = { id: "id-remote", filename: "https://site.com/sitemap.xml" };
  const { ctx } = context([remote]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: [],
    operation: TRANSFORM,
    logger: recordingLogger([]),
    keepZeroMatchRewrites: false
  });

  assert.equal(outcome.filesRewritten, 0);
  assert.deepEqual(outcome.skipped, [
    { file: "https://site.com/sitemap.xml", reason: "remote-source" }
  ]);
});

test("rename keeps a zero-match file (its undo replays over the same set)", async () => {
  const unrelated = await seed("rename-unrelated.xml", UNRELATED_SITEMAP);
  const { ctx, tx } = context([unrelated]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: [],
    operation: {
      kind: "rename",
      // Deliberately matches nothing in UNRELATED_SITEMAP (which is /blog/...),
      // so this really exercises the zero-match branch.
      oldTemplate: "/manufacturer/{param}",
      newTemplate: "/vendor/{param}"
    },
    logger: recordingLogger([]),
    keepZeroMatchRewrites: true
  });

  // Repointed despite matching nothing — but still reported as a skip so the
  // user is not told URLs changed when none did.
  assert.equal(tx.updates.length, 1);
  assert.equal(outcome.rewrittenLocCount, 0);
  assert.deepEqual(outcome.skipped, [
    { file: "rename-unrelated.xml", reason: "no-urls-matched" }
  ]);
});

test("progress is reported and ends on the exact final counts", async () => {
  const a = await seed("p1.xml", SITEMAP);
  const b = await seed("p2.xml", SITEMAP);
  const { ctx, progress } = context([a, b]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: [],
    operation: TRANSFORM,
    logger: recordingLogger([]),
    keepZeroMatchRewrites: false
  });

  assert.ok(progress.length >= 2);
  // The parallel callbacks race, so the LAST call is what has to be exact.
  assert.deepEqual(progress[progress.length - 1], [
    2,
    2,
    outcome.rewrittenLocCount
  ]);
});

test("zeroWorkReason names the reason rather than reporting success", async () => {
  const missing = { id: "id-x", filename: `${SESSION}-x.xml` };
  const { ctx } = context([missing]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: [],
    operation: TRANSFORM,
    logger: recordingLogger([]),
    keepZeroMatchRewrites: false
  });

  assert.equal(outcome.filesRewritten, 0);
  assert.match(
    zeroWorkReason(outcome) ?? "",
    /missing from storage/,
    "a run that changed nothing must say why"
  );
});

test("zeroWorkReason returns null when real work happened", async () => {
  const file = await seed("real.xml", SITEMAP);
  const { ctx } = context([file]);

  const outcome = await rewritePatternFiles(ctx, {
    sessionId: SESSION,
    patternId: "pattern-1",
    sourceRole: "current",
    selectedDisplayFiles: [],
    operation: TRANSFORM,
    logger: recordingLogger([]),
    keepZeroMatchRewrites: false
  });

  assert.ok(outcome.filesRewritten > 0);
  assert.equal(zeroWorkReason(outcome), null);
});

// Windows chmod cannot revoke read access, so this only runs where it can.
test(
  "a NON-ENOENT stat failure throws instead of being skipped",
  { skip: process.platform === "win32" ? "chmod cannot deny read on win32" : false },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pattern-denied-"));
    dirs.push(dir);

    const stored = `${SESSION}-denied.xml`;
    await writeFile(path.join(dir, stored), SITEMAP, "utf-8");
    await chmod(dir, 0o000);

    try {
      const { ctx } = context([{ id: "id-denied", filename: stored }]);

      // The old bare `catch { continue }` would have swallowed EACCES and
      // reported a clean run over zero files.
      await assert.rejects(
        rewritePatternFiles(ctx, {
          sessionId: SESSION,
          patternId: "pattern-1",
          sourceRole: "current",
          selectedDisplayFiles: [],
          operation: TRANSFORM,
          logger: recordingLogger([]),
          keepZeroMatchRewrites: false
        })
      );
    } finally {
      await chmod(dir, 0o700).catch(() => {});
    }
  }
);
