import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createGzip } from "node:zlib";

import { applyRedirectRule, type RedirectRule } from "./redirectRule.js";

const PARAM_SEGMENT = "{param}";
const LOC_OPEN = "<loc>";
const LOC_CLOSE = "</loc>";

// A rewrite decision for a single <loc> URL: return the replacement URL, or
// null to leave the URL exactly as-is (so non-matching locs pass through byte
// for byte).
export type LocUrlRewriter = (url: string) => string | null;

function segmentsFromTemplate(template: string) {
  const trimmed = template.trim();
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  // filter(Boolean) drops empty segments from leading/trailing/double slashes,
  // matching how URL paths are tokenised in buildPatternTemplateRewriter
  // (`split("/").filter(Boolean)`). Without this, a template ending in "/" (as
  // the trailing-slash fix leaves patterns.template) carries a phantom empty
  // segment, so its segment count never matches its own URLs and a subsequent
  // rename / bulk-replace silently no-ops. The trailing slash is preserved
  // separately via the URL's own `hadTrailingSlash`, so ignoring it here is safe.
  return path === "" ? [] : path.split("/").filter(Boolean);
}

// Build a rewriter that replaces specific whole URLs, not path segments: each
// <loc> whose exact URL is a key in `replacements` is swapped for the mapped
// value. Used by apply-redirects, where individual sampled URLs are replaced by
// their concrete redirect destinations. Non-matching URLs pass through
// unchanged (returns null so the loc is emitted byte-for-byte).
export function buildLocMapRewriter(
  replacements: Map<string, string>
): LocUrlRewriter {
  return (url: string) => {
    const next = replacements.get(url);

    return next === undefined || next === url ? null : next;
  };
}

// Build the rewriter used by apply-redirects' whole-pattern widening. For each
// <loc> URL it applies, in order:
//   1. an EXACT confirmed replacement (the HTTP-verified sampled source→dest
//      pairs) — these carry an authoritative destination and win over the rule;
//   2. otherwise the general derived rule (deriveRedirectRule) via
//      applyRedirectRule, which reaches EVERY matching URL in a file — not just
//      a pre-enumerated subset;
//   3. otherwise null (the loc passes through byte-for-byte).
// This is the core of the fix for the capped-pattern_urls bug: because the rule
// is a pure transform over each <loc> streamed from disk, the rewrite reaches
// all real occurrences regardless of how many rows the bounded pattern_urls
// sample pool held. `rule` may be null (samples disagreed / none) — then this is
// exactly buildLocMapRewriter over the confirmed exact pairs.
export function buildRedirectApplyRewriter(
  exactReplacements: Map<string, string>,
  rule: RedirectRule | null
): LocUrlRewriter {
  return (url: string) => {
    const exact = exactReplacements.get(url);

    if (exact !== undefined) {
      return exact === url ? null : exact;
    }

    if (rule) {
      return applyRedirectRule(url, rule);
    }

    return null;
  };
}

// Does a URL pathname belong to a pattern template? The EXACT segment matcher
// buildPatternTemplateRewriter applies before rewriting, extracted so the
// full-population verifier classifies each streamed <loc> with the same rule the
// rewriters use: split on "/", filter(Boolean) (so trailing/double slashes never
// create phantom segments — see segmentsFromTemplate), segment counts must be
// equal, "{param}" positions match anything, static segments must be strictly
// equal. Kept as a pure predicate here (not a new module) so it can never drift
// from the rewriter's matching semantics.
export function pathMatchesTemplate(
  pathname: string,
  template: string
): boolean {
  const templateSegments = segmentsFromTemplate(template);
  const pathSegments = pathname.split("/").filter(Boolean);

  if (pathSegments.length !== templateSegments.length) {
    return false;
  }

  for (let index = 0; index < templateSegments.length; index += 1) {
    if (
      templateSegments[index] !== PARAM_SEGMENT &&
      templateSegments[index] !== pathSegments[index]
    ) {
      return false;
    }
  }

  return true;
}

// Number of "{param}" placeholders in a pattern template.
export function countTemplateParams(template: string): number {
  return segmentsFromTemplate(template).filter(
    (segment) => segment === PARAM_SEGMENT
  ).length;
}

// Build a rewriter that maps URLs matching `fromTemplate` onto `toTemplate`,
// carrying each concrete {param} value across IN ORDER (not by array index) so
// the two templates may differ in length/structure (e.g. inserting a static
// segment). Used by both pattern rename and bulk pattern replace.
// e.g. from=/manufacturer/{param}, to=/aviation/manufacturer/{param} turns
// .../manufacturer/jamco-parts into .../aviation/manufacturer/jamco-parts.
// The caller must ensure both templates have the same number of {param}
// placeholders. Host, scheme, query string and trailing slash are preserved.
// A URL whose path does not match `fromTemplate` (segment count or a static
// segment differs) returns null so the loc passes through byte-for-byte.
export function buildPatternTemplateRewriter(
  fromTemplate: string,
  toTemplate: string
): LocUrlRewriter {
  const fromSegments = segmentsFromTemplate(fromTemplate);
  const toSegments = segmentsFromTemplate(toTemplate);

  return (rawUrl: string) => {
    let url: URL;

    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    const hadTrailingSlash =
      url.pathname.length > 1 && url.pathname.endsWith("/");
    const urlSegments = url.pathname.split("/").filter(Boolean);

    if (urlSegments.length !== fromSegments.length) {
      return null;
    }

    // Capture the concrete value at each {param} position, and bail if any
    // static segment fails to match exactly.
    const params: string[] = [];

    for (let index = 0; index < fromSegments.length; index += 1) {
      if (fromSegments[index] === PARAM_SEGMENT) {
        params.push(urlSegments[index]);
      } else if (fromSegments[index] !== urlSegments[index]) {
        return null;
      }
    }

    // Refill {param} positions in the target template in capture order.
    let paramCursor = 0;
    const rebuiltSegments = toSegments.map((segment) =>
      segment === PARAM_SEGMENT ? params[paramCursor++] ?? segment : segment
    );
    let nextPath = `/${rebuiltSegments.join("/")}`;

    if (hadTrailingSlash && !nextPath.endsWith("/")) {
      nextPath += "/";
    }

    url.pathname = nextPath;

    const nextUrl = url.toString();

    return nextUrl === rawUrl ? null : nextUrl;
  };
}

// A path's last segment looks like a file when it ends in a short extension
// (".xml", ".html", ".pdf", ".jpg", …). Such URLs are left alone by the
// trailing-slash rule — you never append "/" after a file.
function lastSegmentHasFileExtension(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];

  return last !== undefined && /\.[A-Za-z0-9]{1,8}$/.test(last);
}

// Build a rewriter that appends a trailing slash to the path of any URL whose
// path is missing one, and returns null (no change) otherwise. Rules:
//   - path already ending in "/"                       -> skip
//   - path whose last segment is a file (has ext)      -> skip
//   - domain-only URL (path is "/" or empty)           -> skip
//   - a query string                                   -> slash goes BEFORE "?"
//     e.g. example.com/path?q=1 -> example.com/path/?q=1
// Host, scheme, query and fragment are otherwise preserved.
export function buildTrailingSlashRewriter(): LocUrlRewriter {
  return (rawUrl: string) => {
    let url: URL;

    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    // new URL() normalizes a bare host to pathname "/", so domain-only URLs are
    // covered by the endsWith("/") check.
    if (url.pathname.endsWith("/")) {
      return null;
    }

    if (lastSegmentHasFileExtension(url.pathname)) {
      return null;
    }

    url.pathname = `${url.pathname}/`;

    const nextUrl = url.toString();

    return nextUrl === rawUrl ? null : nextUrl;
  };
}

// Reverse of buildTrailingSlashRewriter for a full URL: strip exactly one
// trailing slash from a non-root path (moving it back before any query), used
// to undo a trailing-slash fix on sampled_urls.url. Returns null when there is
// nothing to strip.
export function stripTrailingSlashFromUrl(rawUrl: string): string | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.pathname === "/" || !url.pathname.endsWith("/")) {
    return null;
  }

  url.pathname = url.pathname.slice(0, -1);

  const nextUrl = url.toString();

  return nextUrl === rawUrl ? null : nextUrl;
}

// Path-string variant of the trailing-slash rule for pattern_urls.path /
// patterns.template (which hold a path, not a full URL). Same rules: skip a path
// already ending "/", skip a file-extension last segment, keep any query after
// the inserted slash. Returns null when unchanged.
export function addTrailingSlashToPathString(value: string): string | null {
  const queryIndex = value.indexOf("?");
  const pathPart = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);

  if (pathPart === "" || pathPart === "/" || pathPart.endsWith("/")) {
    return null;
  }

  if (lastSegmentHasFileExtension(pathPart)) {
    return null;
  }

  return `${pathPart}/${query}`;
}

// Reverse of addTrailingSlashToPathString: strip one trailing slash from the
// path part (before any query). Returns null when there is nothing to strip.
export function stripTrailingSlashFromPathString(value: string): string | null {
  const queryIndex = value.indexOf("?");
  const pathPart = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);

  if (pathPart === "/" || !pathPart.endsWith("/")) {
    return null;
  }

  return `${pathPart.slice(0, -1)}${query}`;
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXmlText(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Given the raw inner text of a <loc> element (which may be wrapped in CDATA
// and/or padded with whitespace), apply the rewriter and return the new raw
// inner text, or null if nothing should change.
function rewriteLocInner(rawInner: string, rewriteUrl: LocUrlRewriter) {
  const cdataMatch = rawInner.match(/^(\s*)<!\[CDATA\[([\s\S]*?)\]\]>(\s*)$/);

  if (cdataMatch) {
    const [, leading, inner, trailing] = cdataMatch;
    const nextUrl = rewriteUrl(inner.trim());

    if (nextUrl === null) {
      return null;
    }

    return `${leading}<![CDATA[${nextUrl}]]>${trailing}`;
  }

  const leading = rawInner.match(/^\s*/)?.[0] ?? "";
  const trailing = rawInner.match(/\s*$/)?.[0] ?? "";
  const core = rawInner.slice(leading.length, rawInner.length - trailing.length);
  const nextUrl = rewriteUrl(decodeXmlText(core));

  if (nextUrl === null) {
    return null;
  }

  return `${leading}${encodeXmlText(nextUrl)}${trailing}`;
}

// Streaming transform that rewrites only the text inside <loc>...</loc>
// elements and passes every other byte through unchanged, so the output is the
// original document with just the matching URLs updated.
class LocRewriteTransform extends Transform {
  private pending = "";
  private inLoc = false;
  private locText = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly rewriteUrl: LocUrlRewriter) {
    super({ decodeStrings: false, encoding: "utf8" });
  }

  rewrittenCount = 0;

  override _transform(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

    // StringDecoder buffers any partial multibyte sequence at the chunk
    // boundary so we never split a UTF-8 character mid-stream.
    this.pending += this.decoder.write(buffer);
    this.drain(false);
    callback();
  }

  override _flush(callback: TransformCallback) {
    this.pending += this.decoder.end();
    this.drain(true);

    if (this.inLoc) {
      // Unterminated <loc>: emit what we captured verbatim rather than lose it.
      this.push(this.locText);
      this.locText = "";
      this.inLoc = false;
    }

    if (this.pending) {
      this.push(this.pending);
      this.pending = "";
    }

    callback();
  }

  private drain(isEnd: boolean) {
    for (;;) {
      if (!this.inLoc) {
        const openIndex = this.pending.indexOf(LOC_OPEN);

        if (openIndex === -1) {
          // Hold back a tail that could be a partial "<loc>" straddling chunks.
          const keep = isEnd ? 0 : LOC_OPEN.length - 1;
          const safeLength = Math.max(0, this.pending.length - keep);

          if (safeLength > 0) {
            this.push(this.pending.slice(0, safeLength));
            this.pending = this.pending.slice(safeLength);
          }

          return;
        }

        this.push(this.pending.slice(0, openIndex + LOC_OPEN.length));
        this.pending = this.pending.slice(openIndex + LOC_OPEN.length);
        this.inLoc = true;
        this.locText = "";
      } else {
        const closeIndex = this.pending.indexOf(LOC_CLOSE);

        if (closeIndex === -1) {
          const keep = isEnd ? 0 : LOC_CLOSE.length - 1;
          const safeLength = Math.max(0, this.pending.length - keep);

          this.locText += this.pending.slice(0, safeLength);
          this.pending = this.pending.slice(safeLength);

          return;
        }

        this.locText += this.pending.slice(0, closeIndex);

        const rewritten = rewriteLocInner(this.locText, this.rewriteUrl);

        if (rewritten !== null) {
          this.rewrittenCount += 1;
          this.push(rewritten);
        } else {
          this.push(this.locText);
        }

        this.push(LOC_CLOSE);
        this.pending = this.pending.slice(closeIndex + LOC_CLOSE.length);
        this.inLoc = false;
        this.locText = "";
      }
    }
  }
}

// Stream `inputPath` through the loc rewriter into `outputPath`, decompressing
// and recompressing when the file is gzipped. Returns how many <loc> URLs were
// changed.
export async function rewriteSitemapLocFile(options: {
  inputPath: string;
  outputPath: string;
  isGzip: boolean;
  rewriteUrl: LocUrlRewriter;
}): Promise<number> {
  const transform = new LocRewriteTransform(options.rewriteUrl);
  const readable = createReadStream(options.inputPath);
  const writable = createWriteStream(options.outputPath);
  const stages = options.isGzip
    ? [readable, createGunzip(), transform, createGzip(), writable]
    : [readable, transform, writable];

  await pipeline(stages);

  return transform.rewrittenCount;
}

// Stream `inputPath` into `outputPath`, replacing each <loc> whose exact URL is
// a key in `replacements` with its mapped value (URL-level replacement, as used
// by apply-redirects). Gzip-aware, same as rewriteSitemapLocFile. Returns how
// many <loc> URLs were changed.
export async function rewriteSpecificLocs(options: {
  inputPath: string;
  outputPath: string;
  isGzip: boolean;
  replacements: Map<string, string>;
}): Promise<number> {
  return rewriteSitemapLocFile({
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    isGzip: options.isGzip,
    rewriteUrl: buildLocMapRewriter(options.replacements)
  });
}

// Stream every <loc> URL in a sitemap file past `visit`, WITHOUT writing
// anything anywhere — the read-only sibling of rewriteSitemapLocFile. Built on
// the exact same LocRewriteTransform (CDATA-aware, chunk-boundary-safe <loc>
// parsing) that the real rewrite uses, by giving it a rewriter that always
// returns null (never rewrites) but reports the URL first — so a read-only pass
// can never disagree with the real rewrite about what counts as a <loc>, or
// about which URLs inside one are well-formed.
//
// `visit` is called once per <loc>, in file order, and its return value is
// ignored. It must not throw: a throw destroys the pipeline mid-file and the
// caller cannot tell a parse failure from a visitor bug.
export async function scanSitemapLocs(options: {
  inputPath: string;
  isGzip: boolean;
  visit: (url: string) => void;
}): Promise<void> {
  const observeOnly: LocUrlRewriter = (url) => {
    options.visit(url);

    return null;
  };
  const transform = new LocRewriteTransform(observeOnly);
  const readable = createReadStream(options.inputPath);
  // Discards output — this call exists only for the visitor's side effects.
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const stages = options.isGzip
    ? [readable, createGunzip(), transform, sink]
    : [readable, transform, sink];

  await pipeline(stages);
}

// How many <loc> URLs in a sitemap file satisfy `matchesUrl` — for previewing
// how many URLs an edit would touch before it runs.
//
// A thin wrapper over scanSitemapLocs rather than its own pipeline, so the
// counting pass and the richer dry-run pass cannot drift on what they consider
// a <loc>.
export async function countSitemapLocMatches(options: {
  inputPath: string;
  isGzip: boolean;
  matchesUrl: (url: string) => boolean;
}): Promise<number> {
  let matched = 0;

  await scanSitemapLocs({
    inputPath: options.inputPath,
    isGzip: options.isGzip,
    visit: (url) => {
      if (options.matchesUrl(url)) {
        matched += 1;
      }
    }
  });

  return matched;
}
