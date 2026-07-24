import {
  buildLocMapRewriter,
  buildPatternTemplateRewriter,
  buildRedirectApplyRewriter,
  buildTrailingSlashRewriter,
  rewriteSitemapLocFile,
  type LocUrlRewriter
} from "../sitemaps/rewriteLocs.js";
import type { RedirectRule } from "../sitemaps/redirectRule.js";

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
    };

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
