import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createGzip } from "node:zlib";

const URL_OPEN = "<url>";
const URL_CLOSE = "</url>";
const LOC_OPEN = "<loc>";
const LOC_CLOSE = "</loc>";

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Pull the decoded <loc> URL out of a fully-buffered <url>…</url> block, or null
// when the block has no usable <loc> (which means it is never a delete target).
function locFromBlock(block: string): string | null {
  const openIndex = block.indexOf(LOC_OPEN);

  if (openIndex === -1) {
    return null;
  }

  const closeIndex = block.indexOf(LOC_CLOSE, openIndex + LOC_OPEN.length);

  if (closeIndex === -1) {
    return null;
  }

  let inner = block.slice(openIndex + LOC_OPEN.length, closeIndex).trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);

  if (cdata) {
    inner = cdata[1].trim();
  }

  return decodeXmlText(inner);
}

// Longest suffix of `s` that is a proper prefix of `token` (0 when none). Used
// to hold back a tag that may be split across chunk boundaries.
function partialTokenSuffix(s: string, token: string): number {
  const max = Math.min(token.length - 1, s.length);

  for (let p = max; p > 0; p -= 1) {
    if (s.slice(s.length - p) === token.slice(0, p)) {
      return p;
    }
  }

  return 0;
}

// Length of the trailing whitespace run of `s`.
function trailingWhitespaceLength(s: string): number {
  let count = 0;

  while (count < s.length && /\s/.test(s[s.length - 1 - count])) {
    count += 1;
  }

  return count;
}

// Streaming transform that removes entire <url>…</url> blocks for which
// `shouldRemove(loc)` returns true, passing every other byte through unchanged.
// The indentation whitespace immediately preceding a removed block is dropped
// with it so the output has no orphaned blank lines. A <url> block is small and
// bounded, so at most one block is buffered at a time — the whole file is never
// held in memory. `loc` is the decoded <loc> URL, or null when the block has no
// usable <loc>.
export class UrlBlockFilterTransform extends Transform {
  private pending = "";
  private block = "";
  private inBlock = false;
  private readonly decoder = new StringDecoder("utf8");

  removedCount = 0;
  // <url> blocks emitted (kept) — the authoritative post-filter URL count for
  // this file, used to reset sitemap_files.total_urls without delta math.
  keptCount = 0;

  constructor(private readonly shouldRemove: (loc: string | null) => boolean) {
    super({ decodeStrings: false, encoding: "utf8" });
  }

  override _transform(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

    this.pending += this.decoder.write(buffer);
    this.drain(false);
    callback();
  }

  override _flush(callback: TransformCallback) {
    this.pending += this.decoder.end();
    this.drain(true);

    if (this.inBlock) {
      // Unterminated <url>: emit what we captured verbatim rather than lose it.
      this.push(this.block);
      this.block = "";
      this.inBlock = false;
    }

    if (this.pending) {
      this.push(this.pending);
      this.pending = "";
    }

    callback();
  }

  private drain(isEnd: boolean) {
    for (;;) {
      if (!this.inBlock) {
        const openIndex = this.pending.indexOf(URL_OPEN);

        if (openIndex === -1) {
          // Hold back a trailing whitespace run (a possible block lead) plus any
          // partial "<url>" straddling the chunk boundary; emit the rest.
          if (isEnd) {
            if (this.pending) {
              this.push(this.pending);
              this.pending = "";
            }

            return;
          }

          const partial = partialTokenSuffix(this.pending, URL_OPEN);
          const ws = trailingWhitespaceLength(
            this.pending.slice(0, this.pending.length - partial)
          );
          const held = ws + partial;
          const emit = this.pending.slice(0, this.pending.length - held);

          if (emit) {
            this.push(emit);
          }

          this.pending = this.pending.slice(this.pending.length - held);

          return;
        }

        // Split the run before "<url>" into content to emit and the block's
        // leading whitespace (dropped along with the block if it is removed).
        const before = this.pending.slice(0, openIndex);
        const leadLength = trailingWhitespaceLength(before);
        const keep = before.slice(0, before.length - leadLength);
        const lead = before.slice(before.length - leadLength);

        if (keep) {
          this.push(keep);
        }

        this.block = lead + URL_OPEN;
        this.inBlock = true;
        this.pending = this.pending.slice(openIndex + URL_OPEN.length);
      } else {
        const closeIndex = this.pending.indexOf(URL_CLOSE);

        if (closeIndex === -1) {
          const held = isEnd
            ? 0
            : partialTokenSuffix(this.pending, URL_CLOSE);

          this.block += this.pending.slice(0, this.pending.length - held);
          this.pending = this.pending.slice(this.pending.length - held);

          return;
        }

        this.block += this.pending.slice(0, closeIndex + URL_CLOSE.length);
        this.pending = this.pending.slice(closeIndex + URL_CLOSE.length);

        const loc = locFromBlock(this.block);

        if (this.shouldRemove(loc)) {
          this.removedCount += 1;
          // Drop the whole block (and its captured lead whitespace).
        } else {
          this.keptCount += 1;
          this.push(this.block);
        }

        this.block = "";
        this.inBlock = false;
      }
    }
  }
}

export type UrlBlockDeleteResult = {
  // <url> blocks removed from the document.
  removedCount: number;
  // <url> blocks kept — the file's post-delete URL count.
  keptCount: number;
};

// Stream `inputPath` into `outputPath`, removing every <url> block whose <loc> is
// one of `targetUrls`. Gzip-aware, same shape as rewriteSitemapLocFile. Returns
// how many <url> blocks were removed and how many remain.
export async function removeUrlBlocksFromFile(options: {
  inputPath: string;
  outputPath: string;
  isGzip: boolean;
  targetUrls: Iterable<string>;
}): Promise<UrlBlockDeleteResult> {
  const targets = new Set(options.targetUrls);
  const transform = new UrlBlockFilterTransform(
    (loc) => loc !== null && targets.has(loc)
  );
  const readable = createReadStream(options.inputPath);
  const writable = createWriteStream(options.outputPath);
  const stages = options.isGzip
    ? [readable, createGunzip(), transform, createGzip(), writable]
    : [readable, transform, writable];

  await pipeline(stages);

  return { removedCount: transform.removedCount, keptCount: transform.keptCount };
}
