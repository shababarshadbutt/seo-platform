import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { rewriteSitemapLocFile, type LocUrlRewriter } from "./rewriteLocs.js";

// ONE sitemap file, transformed into a throwaway copy nobody's session points
// at, so the SEO team can open a real corrected file before authorising a
// rewrite of every file in the session.
//
// WHY A COPY AND NOT A SCOPED REAL APPLY. Applying to one real file first and
// undoing it if it looks wrong is the obvious cheaper design, and it is worse:
// the undo is one level deep and shares its bookkeeping with the full transform,
// so a sample that the user forgets to undo silently leaves the session in a
// half-transformed state — exactly what patternStructureJob's single-transaction
// shape exists to prevent. A copy has no such failure mode: nothing references
// it, and losing it costs nothing.
//
// The output therefore goes to EXPORT_DIR (alongside the generated ZIPs and
// CSVs, which are all disposable derived artifacts) and NEVER to UPLOAD_DIR,
// which is the session's real storage and where every "is this file edited?"
// lookup reads from. sitemap_files is not touched, so there is nothing to undo.

// Named so the periodic export sweep can recognise and reap these; see
// processCleanupZipsJob.
export const TRANSFORM_SAMPLE_PREFIX = "transform-sample-";

// How many before/after pairs to keep. The user asked to review ten, and ten
// from ONE file is deliberate: they are the ten they can then find in the file
// they download, which a sample spread across ten files could not offer.
export const TRANSFORM_SAMPLE_LIMIT = 10;

export type TransformSamplePair = { before: string; after: string };

export type TransformSampleFile = {
  // Opaque handle for the download route. Random rather than derived, so a
  // sample cannot be guessed from a session or pattern id.
  token: string;
  storedName: string;
  // Every <loc> in the file, whether or not the transform touched it — the
  // denominator that makes "1,873 rewritten" mean something.
  totalLocs: number;
  rewritten: number;
  samples: TransformSamplePair[];
  bytes: number;
};

export function transformSampleStoredName(
  sessionId: string,
  token: string,
  isGzip: boolean
): string {
  return `${TRANSFORM_SAMPLE_PREFIX}${sessionId}-${token}.xml${
    isGzip ? ".gz" : ""
  }`;
}

// Both halves are validated by the caller's route params, but this is the only
// place that turns them into a filesystem path, so it is the right place to
// refuse anything that could climb out of EXPORT_DIR.
const TOKEN_PATTERN = /^[0-9a-f-]{36}$/;
const SESSION_PATTERN = /^[0-9a-fA-F-]{36}$/;

export function transformSamplePath(
  sessionId: string,
  token: string,
  isGzip: boolean
): string | null {
  if (!SESSION_PATTERN.test(sessionId) || !TOKEN_PATTERN.test(token)) {
    return null;
  }

  return path.join(
    config.exportDir,
    transformSampleStoredName(sessionId, token, isGzip)
  );
}

export function isTransformSampleName(name: string): boolean {
  return (
    name.startsWith(TRANSFORM_SAMPLE_PREFIX) &&
    (name.endsWith(".xml") || name.endsWith(".xml.gz"))
  );
}

// Stream one file through `rewriteUrl` into a disposable copy, collecting the
// first `sampleLimit` changes as it goes.
//
// The rewriter is passed in rather than built here so it is the SAME closure the
// real job uses (applyStructureFilterToRewriter over transformUrl). A sample
// built from a separately-assembled rewriter could disagree with the apply about
// scope, which would make it worthless as a check.
export async function buildTransformSampleFile(options: {
  sessionId: string;
  inputPath: string;
  isGzip: boolean;
  rewriteUrl: LocUrlRewriter;
  sampleLimit?: number;
}): Promise<TransformSampleFile> {
  const token = randomUUID();
  const storedName = transformSampleStoredName(
    options.sessionId,
    token,
    options.isGzip
  );
  const outputPath = path.join(config.exportDir, storedName);
  const limit = options.sampleLimit ?? TRANSFORM_SAMPLE_LIMIT;

  await mkdir(config.exportDir, { recursive: true });

  let totalLocs = 0;
  const samples: TransformSamplePair[] = [];

  // Wraps rather than replaces the caller's rewriter: whatever it returns is
  // returned verbatim, so the bytes written here are identical to the bytes the
  // real transform would write for this file.
  const observed: LocUrlRewriter = (url) => {
    totalLocs += 1;

    const after = options.rewriteUrl(url);

    if (after !== null && samples.length < limit) {
      samples.push({ before: url, after });
    }

    return after;
  };

  const rewritten = await rewriteSitemapLocFile({
    inputPath: options.inputPath,
    outputPath,
    isGzip: options.isGzip,
    rewriteUrl: observed
  });

  const info = await stat(outputPath);

  return {
    token,
    storedName,
    totalLocs,
    rewritten,
    samples,
    bytes: info.size
  };
}
