import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";

import { ZipArchive } from "archiver";

import { lazyStreamSitemapWithoutForeignLocs } from "../sitemaps/foreignLocFilter.js";

// piscina worker: builds one download ZIP to `outputPath` off the worker
// PROCESS's main thread, so a large multi-file archive build no longer blocks
// the BullMQ parse/extract/sample/maintenance queues that share that event loop.
//
// The archive is assembled exactly like the on-demand streamer
// (buildSessionZipArchive): each source file is appended through the LAZY
// foreign-loc filter (so archiver opens one file at a time — the v1.28 fix — and
// foreign-domain <loc>s are stripped), then a regenerated sitemap-index.xml is
// appended. Compression is kept (not stored), so downloads stay small; running
// off-thread is what removes the blocking, not dropping compression.
//
// Runs under tsx in a worker thread (the pool passes `--import tsx`), so it can
// import the project's .ts modules directly. Input must be plain, structured-
// clone-serialisable data (no streams) — see SessionZipPlan / ZipWorkerInput.

export type ZipWorkerInput = {
  sessionId: string;
  type: "all" | "edited";
  outputPath: string;
  zlibLevel: number;
  expectedHost: string;
  indexXml: string;
  indexName: string;
  files: Array<{ sourcePath: string; displayName: string; isGzip: boolean }>;
};

export type ZipWorkerResult = { entries: number; bytes: number };

export default async function buildZipFile(
  input: ZipWorkerInput
): Promise<ZipWorkerResult> {
  const {
    sessionId,
    type,
    outputPath,
    zlibLevel,
    expectedHost,
    indexXml,
    indexName,
    files
  } = input;

  const debugZip = process.env.DEBUG_ZIP === "1";
  const archive = new ZipArchive({ zlib: { level: zlibLevel } });
  const output = createWriteStream(outputPath);

  const done = new Promise<void>((resolve, reject) => {
    output.on("finish", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
  });

  archive.pipe(output);

  let entryIndex = 0;

  for (const file of files) {
    const index = entryIndex++;
    const sourceBytes = debugZip
      ? await stat(file.sourcePath).then((s) => s.size).catch(() => -1)
      : 0;

    archive.append(
      lazyStreamSitemapWithoutForeignLocs({
        inputPath: file.sourcePath,
        isGzip: file.isGzip,
        expectedHost,
        onComplete: debugZip
          ? (streamStats) => {
              // eslint-disable-next-line no-console
              console.log(
                `[DEBUG_ZIP][worker] session=${sessionId} type=${type} ` +
                  `#${index} name=${file.displayName} sourceBytes=${sourceBytes} ` +
                  `bytesOut=${streamStats.bytesOut} kept=${streamStats.keptCount} ` +
                  `removed=${streamStats.removedCount} host=${expectedHost}`
              );
            }
          : undefined
      }),
      { name: file.displayName }
    );
  }

  archive.append(indexXml, { name: indexName });

  await archive.finalize();
  await done;

  const { size } = await stat(outputPath);
  return { entries: files.length + 1, bytes: size };
}
