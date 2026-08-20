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
import { applyShapeFilterToRewriter } from "../sitemaps/shapeFilter.js";
import {
  applyStructureFilterToRewriter,
  type ResolvedStructureFilter
} from "../sitemaps/structureClusters.js";

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
  // structureFilters (v1.49, list since v1.51) scopes the rewrite to the
  // detected URL structures inside the pattern — locs outside them pass through
  // byte-for-byte. A pattern with several {param} slots can be scoped at more
  // than one position at once and the list is ANDed. They cross the thread edge
  // FULLY RESOLVED (path-segment indexes, not param ordinals) so the worker
  // applies them without any template parsing.
  | {
      kind: "patternTemplate";
      from: string;
      to: string;
      structureFilters?: ResolvedStructureFilter[] | null;
    }
  // Exact whole-URL replacements (apply-redirects, v1.42). Passed as [old, new]
  // pairs because a Map isn't structured-clone friendly across the thread edge.
  | { kind: "locMap"; replacements: [string, string][] }
  // Whole-pattern redirect widening (v1.45.1): confirmed exact pairs PLUS a
  // general derived rule applied to every matching <loc>. The rule is a plain
  // structured-clone-friendly object; `replacements` win per-URL.
  // structureFilters (v1.66) scopes the widening to one detected structure, the
  // same way patternTemplate and structureTransform above are scoped. Without
  // it a derived rule sweeps EVERY <loc> it can transform, so a fix reviewed on
  // one structure rewrote every other structure under the pattern too.
  | {
      kind: "redirectApply";
      replacements: [string, string][];
      // One derived rule, or the LIST a human approved (v1.72) — applied in
      // order, first match winning. Plain objects either way, so the array
      // crosses the thread edge unchanged.
      rule: RedirectRule | RedirectRule[] | null;
      structureFilters?: ResolvedStructureFilter[] | null;
    }
  // Pattern structure transform (v1.48). The RAW structure strings cross the
  // thread edge, not the parsed form — parseStructure is cheap, deterministic and
  // total on strings the route already validated, so re-parsing per worker is
  // simpler than keeping ParsedStructure structured-clone-safe.
  // shapeFilter (v1.69) is a SECOND, independent scope: structureFilters is
  // token-boundary prefix/suffix matching ("only nsn-parts-*"), shapeFilter is
  // value shape ("only the 5-digit ones"). Neither can express the other, and
  // both can apply at once. Plain strings, so nothing has to be resolved before
  // crossing the thread edge.
  | {
      kind: "structureTransform";
      currentStructure: string;
      newStructure: string;
      structureFilters?: ResolvedStructureFilter[] | null;
      shapeFilter?: string[] | null;
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
    return applyStructureFilterToRewriter(
      buildPatternTemplateRewriter(spec.from, spec.to),
      spec.structureFilters ?? null
    );
  }

  if (spec.kind === "locMap") {
    return buildLocMapRewriter(new Map(spec.replacements));
  }

  if (spec.kind === "redirectApply") {
    // Guard wraps the WHOLE rewriter, exact replacements included: an
    // out-of-scope URL must pass through even if it happens to be one of the
    // confirmed sampled pairs, or "limit this edit to" would leak.
    return applyStructureFilterToRewriter(
      buildRedirectApplyRewriter(new Map(spec.replacements), spec.rule),
      spec.structureFilters ?? null
    );
  }

  if (spec.kind === "structureTransform") {
    const current = parseStructure(spec.currentStructure);
    const next = parseStructure(spec.newStructure);

    // Both guards, outermost first: a URL of an unselected shape returns null
    // before the structure guard or transformUrl ever see it.
    return applyShapeFilterToRewriter(
      applyStructureFilterToRewriter(
        (url) => transformUrl(url, current, next),
        spec.structureFilters ?? null
      ),
      spec.shapeFilter ?? null
    );
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
