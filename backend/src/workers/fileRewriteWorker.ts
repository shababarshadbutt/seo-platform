import {
  buildLocMapRewriter,
  buildPatternTemplateRewriter,
  buildRedirectApplyRewriter,
  buildTrailingSlashRewriter,
  rewriteSitemapLocFile,
  type LocUrlRewriter
} from "../sitemaps/rewriteLocs.js";
import type { RedirectRule } from "../sitemaps/redirectRule.js";
import {
  parseStructure,
  transformUrl
} from "../sitemaps/transformStructure.js";

// piscina worker: streams ONE sitemap file through a <loc> rewriter from
// inputPath to outputPath (copy-on-write) off the worker PROCESS's main thread,
// so a large multi-file trailing-slash / bulk-replace run processes several
// files in parallel instead of one at a time (v1.32). Pure disk work — it does
// NO database access; the caller keeps every DB write on its own thread so the
// undo bookkeeping stays single-threaded and correct.
//
// The rewriter is rebuilt inside the worker from a serialisable spec (functions
// can't cross the thread boundary). Both rewriters are deterministic, so this
// produces byte-identical output to the inline path.
//
// Runs under tsx in a worker thread (the pool passes `--import tsx`), so it can
// import the project's .ts modules directly. Input must be plain, structured-
// clone-serialisable data (no streams / functions).

export type FileRewriteSpec =
  | { kind: "trailingSlash" }
  | { kind: "patternTemplate"; from: string; to: string }
  // Exact whole-URL replacements (apply-redirects, v1.42). Passed as [old, new]
  // pairs because a Map isn't structured-clone friendly across the thread edge.
  | { kind: "locMap"; replacements: [string, string][] }
  // Whole-pattern redirect widening (v1.45.1): confirmed exact pairs PLUS a
  // general derived rule applied to every matching <loc>. The rule is a plain
  // structured-clone-friendly object; `replacements` win per-URL.
  | {
      kind: "redirectApply";
      replacements: [string, string][];
      rule: RedirectRule | null;
    }
  // Pattern-scoped per-segment structure transform (Update Pattern modal). The
  // rewriter is a closure over two ParsedStructures and can't cross the thread
  // boundary, but the RAW structure strings can — and parseStructure /
  // transformUrl are pure and deterministic, so rebuilding here yields a
  // byte-identical result to the inline path.
  | { kind: "patternStructure"; currentStructure: string; nextStructure: string };

export type FileRewriteInput = {
  inputPath: string;
  outputPath: string;
  isGzip: boolean;
  spec: FileRewriteSpec;
};

export type FileRewriteResult = { rewrittenCount: number };

function buildRewriter(spec: FileRewriteSpec): LocUrlRewriter {
  if (spec.kind === "patternTemplate") {
    return buildPatternTemplateRewriter(spec.from, spec.to);
  }

  if (spec.kind === "locMap") {
    return buildLocMapRewriter(new Map(spec.replacements));
  }

  if (spec.kind === "redirectApply") {
    return buildRedirectApplyRewriter(new Map(spec.replacements), spec.rule);
  }

  if (spec.kind === "patternStructure") {
    // Parsed once per worker task, not once per URL — parseStructure throws
    // StructureSyntaxError on malformed input, which piscina propagates back to
    // the caller as a rejected pool.run(). The route already rejects bad syntax
    // with a 400 long before enqueueing, so reaching here is a real fault and
    // must not be swallowed.
    const current = parseStructure(spec.currentStructure);
    const next = parseStructure(spec.nextStructure);

    return (url) => transformUrl(url, current, next);
  }

  return buildTrailingSlashRewriter();
}

export default async function fileRewrite(
  input: FileRewriteInput
): Promise<FileRewriteResult> {
  const rewrittenCount = await rewriteSitemapLocFile({
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    isGzip: input.isGzip,
    rewriteUrl: buildRewriter(input.spec)
  });

  return { rewrittenCount };
}
