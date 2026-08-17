import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cleanSitemaps, type CleanerStage } from "./cleaner.js";
import { createCleanerMetrics } from "./cleanerMetrics.js";

// The contract every Sitemap Cleaner run must satisfy for its progress to be
// renderable — and, just as importantly, for its stage timing to be trustworthy.
//
// This is the regression guard for the v1.49 bug. Back then `dedup`, `index`
// and `zip` carried no current/total, which made the frontend null its progress
// state and blank the bar mid-run; and `select`, the duplicates-CSV write and
// `rm -rf in/` announced NOTHING at all, so StageTimer silently charged their
// cost to whichever stage happened to precede them. A stage going quiet again
// would reintroduce both problems at once, and nothing else in the suite
// notices — the byte-identical output test passes either way.

const HOST = "https://site.com";
const TODAY = "2026-08-17";

type Frame = {
  stage: CleanerStage;
  message: string;
  current?: number;
  total?: number;
};

function urlset(locs: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs.map((loc) => `  <url><loc>${loc}</loc></url>`),
    "</urlset>"
  ].join("\n");
}

async function runClean() {
  const inDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-contract-in-"));
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-contract-out-"));

  // Deliberately includes cross-file duplicates so the duplicates report is
  // non-empty and the `report` stage has real rows to count, plus an
  // off-domain file so `select` has something to drop.
  const fixtures: { filename: string; locs: string[] }[] = [
    { filename: "a.xml", locs: [`${HOST}/x`, `${HOST}/y`, `${HOST}/dup`] },
    { filename: "b.xml", locs: [`${HOST}/z`, `${HOST}/dup`, `${HOST}/w`] },
    { filename: "c.xml", locs: [`${HOST}/dup`, `${HOST}/v`] },
    { filename: "foreign.xml", locs: ["https://other.com/a", "https://other.com/b"] }
  ];

  const files = fixtures.map((fixture) => {
    const filePath = path.join(inDir, fixture.filename);

    writeFileSync(filePath, urlset(fixture.locs), "utf8");

    return { filename: fixture.filename, path: filePath };
  });

  const frames: Frame[] = [];
  const metrics = createCleanerMetrics();

  const { result } = await cleanSitemaps({
    files,
    domain: HOST,
    subfolder: "sitemaps",
    today: TODAY,
    outDir,
    metrics,
    onProgress: (event) => frames.push(event as Frame)
  });

  return {
    frames,
    result,
    metrics,
    cleanup: () => {
      rmSync(inDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  };
}

test("every engine stage announces itself at least once", async () => {
  const { frames, cleanup } = await runClean();

  try {
    const seen = new Set(frames.map((frame) => frame.stage));

    // `select` and `report` are the two that were previously silent. If either
    // disappears from this list, its wall-clock cost becomes invisible again.
    for (const stage of ["parse", "select", "dedup", "output", "index", "report"]) {
      assert.ok(
        seen.has(stage as CleanerStage),
        `stage "${stage}" never announced itself — its time will be misattributed to the previous stage`
      );
    }
  } finally {
    cleanup();
  }
});

test("every counted frame carries both current and total, and current <= total", async () => {
  const { frames, cleanup } = await runClean();

  try {
    for (const frame of frames) {
      if (frame.current === undefined) {
        continue;
      }

      assert.equal(
        typeof frame.total,
        "number",
        `stage "${frame.stage}" reported current with no total — the UI cannot compute a percentage`
      );
      assert.ok(
        (frame.current as number) <= (frame.total as number),
        `stage "${frame.stage}" reported ${frame.current} of ${frame.total}`
      );
      assert.ok(frame.current >= 0, `stage "${frame.stage}" reported a negative current`);
    }
  } finally {
    cleanup();
  }
});

test("current is monotonically non-decreasing within each stage", async () => {
  const { frames, cleanup } = await runClean();

  try {
    const highest = new Map<string, number>();

    for (const frame of frames) {
      if (typeof frame.current !== "number") {
        continue;
      }

      const previous = highest.get(frame.stage);

      if (previous !== undefined) {
        assert.ok(
          frame.current >= previous,
          `stage "${frame.stage}" went backwards: ${previous} -> ${frame.current}`
        );
      }

      highest.set(frame.stage, frame.current);
    }
  } finally {
    cleanup();
  }
});

test("every frame carries a non-empty human-readable message", async () => {
  const { frames, cleanup } = await runClean();

  try {
    for (const frame of frames) {
      assert.ok(
        typeof frame.message === "string" && frame.message.trim().length > 0,
        `stage "${frame.stage}" emitted an empty message`
      );
    }
  } finally {
    cleanup();
  }
});

test("the run records explicit spans for each phase", async () => {
  const { metrics, cleanup } = await runClean();

  try {
    const { totals } = metrics.snapshot();

    // Explicit spans are what make the timing authoritative where StageTimer
    // cannot be — assert they exist rather than trusting the stage names.
    for (const span of ["stage.pass1_ms", "stage.select_ms", "stage.pass2_ms", "stage.index_ms", "stage.report_ms"]) {
      assert.ok(span in totals, `missing span "${span}"`);
    }
  } finally {
    cleanup();
  }
});

test("an aborted signal stops the run between files", async () => {
  const inDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-abort-in-"));
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cleaner-abort-out-"));

  try {
    const files = Array.from({ length: 6 }, (_, i) => {
      const filename = `f${i}.xml`;
      const filePath = path.join(inDir, filename);

      writeFileSync(filePath, urlset([`${HOST}/p${i}`]), "utf8");

      return { filename, path: filePath };
    });

    const controller = new AbortController();

    controller.abort();

    // Without the signal threaded through cleanSitemaps, an abandoned run would
    // keep working to completion with nobody watching and the watchdog would be
    // purely decorative.
    await assert.rejects(
      cleanSitemaps({
        files,
        domain: HOST,
        subfolder: "sitemaps",
        today: TODAY,
        outDir,
        signal: controller.signal
      })
    );
  } finally {
    rmSync(inDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
