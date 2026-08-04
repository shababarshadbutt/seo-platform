import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { Transform, type Readable, type TransformCallback } from "node:stream";

import sax from "sax";
import { request } from "undici";

import { config } from "../config.js";
import { isHttpUrl } from "./filenames.js";

export type ParsedSitemap = {
  rootElement: string | null;
  totalUrls: number;
  childSitemapUrls: string[];
  urlLocs?: string[];
  isValid: boolean;
  parseError: string | null;
  parseErrorOffset: number | null;
  hadPreambleStripped: boolean;
};

type ParseSitemapOptions = {
  collectUrlLocs?: boolean;
};

type SitemapSource = {
  stream: Readable;
  isGzip: boolean;
};

type SitemapUrlResponse = {
  stream: Readable;
  contentEncoding: string;
  finalUrl: string;
};

type LocCallback = (loc: string) => boolean | void;

const PREAMBLE_PEEK_BYTES = 500;
const NON_XML_PREAMBLE_ERROR =
  "File contains non-XML preamble and could not be recovered";

function localName(name: string) {
  return name.split(":").pop()?.toLowerCase() ?? name.toLowerCase();
}

function parserPosition(parser: unknown) {
  return (
    parser as {
      position?: number;
    }
  ).position;
}

function isGzipName(value: string) {
  return value.toLowerCase().endsWith(".gz");
}

function redirectLocation(value: unknown) {
  if (Array.isArray(value)) {
    return value[0] ? String(value[0]) : "";
  }

  return value ? String(value) : "";
}

function normalizeXmlStart(value: string) {
  return value.replace(/^[\uFEFF\s]+/u, "").toLowerCase();
}

function hasRecognizedSitemapStart(value: string) {
  const normalized = normalizeXmlStart(value);

  return (
    normalized.startsWith("<?xml") ||
    normalized.startsWith("<urlset") ||
    normalized.startsWith("<sitemapindex")
  );
}

class NonRecoverablePreambleError extends Error {
  constructor() {
    super(NON_XML_PREAMBLE_ERROR);
    this.name = "NonRecoverablePreambleError";
  }
}

function isNonRecoverablePreambleError(error: unknown) {
  return error instanceof NonRecoverablePreambleError;
}

class PreambleStrippingTransform extends Transform {
  hadPreambleStripped = false;

  private buffer = Buffer.alloc(0);
  private inspected = false;

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback
  ) {
    if (this.inspected) {
      callback(null, chunk);
      return;
    }

    const nextBuffer = Buffer.concat([
      this.buffer,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    ]);

    if (nextBuffer.length < PREAMBLE_PEEK_BYTES) {
      this.buffer = nextBuffer;
      callback();
      return;
    }

    this.flushInitialBuffer(nextBuffer, callback);
  }

  override _flush(callback: TransformCallback) {
    if (this.inspected) {
      callback();
      return;
    }

    this.flushInitialBuffer(this.buffer, callback);
  }

  private flushInitialBuffer(
    buffer: Buffer,
    callback: TransformCallback
  ) {
    this.inspected = true;

    try {
      const preparedBuffer = this.prepareInitialBuffer(buffer);

      if (preparedBuffer.length > 0) {
        this.push(preparedBuffer);
      }

      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private prepareInitialBuffer(buffer: Buffer) {
    const peekBuffer = buffer.subarray(0, PREAMBLE_PEEK_BYTES);

    if (hasRecognizedSitemapStart(peekBuffer.toString("utf8"))) {
      return buffer;
    }

    const firstTagIndex = peekBuffer.indexOf("<");

    if (firstTagIndex === -1) {
      throw new NonRecoverablePreambleError();
    }

    if (firstTagIndex === 0) {
      return buffer;
    }

    const strippedBuffer = buffer.subarray(firstTagIndex);

    if (
      !hasRecognizedSitemapStart(
        strippedBuffer.subarray(0, PREAMBLE_PEEK_BYTES).toString("utf8")
      )
    ) {
      throw new NonRecoverablePreambleError();
    }

    this.hadPreambleStripped = true;

    return strippedBuffer;
  }
}

function createSitemapInput(source: Readable, isGzip: boolean) {
  const decodedInput = isGzip ? source.pipe(createGunzip()) : source;
  const preambleStripper = new PreambleStrippingTransform();
  const input = decodedInput.pipe(preambleStripper);

  return {
    decodedInput,
    preambleStripper,
    input
  };
}

function destroySitemapInput(
  source: Readable,
  decodedInput: Readable,
  input: Readable
) {
  source.destroy();

  if (decodedInput !== source) {
    decodedInput.destroy();
  }

  if (input !== decodedInput) {
    input.destroy();
  }
}

export async function requestSitemapUrl(
  url: string,
  redirectCount = 0
): Promise<SitemapUrlResponse> {
  const response = await request(url, {
    method: "GET",
    headersTimeout: 10000,
    bodyTimeout: 30000,
    headers: {
      "user-agent": config.defaultHttpUserAgent,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9"
    }
  });

  if (
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    redirectCount < 1
  ) {
    const location = redirectLocation(response.headers.location);

    await response.body.text().catch(() => undefined);

    if (location) {
      return requestSitemapUrl(new URL(location, url).toString(), redirectCount + 1);
    }
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    await response.body.text().catch(() => undefined);
    throw new Error(`Failed to fetch sitemap URL: HTTP ${response.statusCode}`);
  }

  return {
    stream: response.body,
    contentEncoding: String(response.headers["content-encoding"] ?? "").toLowerCase(),
    finalUrl: url
  };
}

async function openSitemapSource(filename: string): Promise<SitemapSource> {
  if (isHttpUrl(filename)) {
    const response = await requestSitemapUrl(filename);

    return {
      stream: response.stream,
      isGzip:
        response.contentEncoding.includes("gzip") || isGzipName(response.finalUrl)
    };
  }

  const filePath = `${config.uploadDir}/${filename}`;

  return {
    stream: createReadStream(filePath),
    isGzip: isGzipName(filename)
  };
}

export async function parseSitemapSource(
  filename: string,
  options: ParseSitemapOptions = {}
): Promise<ParsedSitemap> {
  try {
    const source = await openSitemapSource(filename);

    return await parseSitemapStream(source.stream, source.isGzip, options);
  } catch (error) {
    return {
      rootElement: null,
      totalUrls: 0,
      childSitemapUrls: [],
      urlLocs: options.collectUrlLocs ? [] : undefined,
      isValid: false,
      parseError: error instanceof Error ? error.message : String(error),
      parseErrorOffset: null,
      hadPreambleStripped: false
    };
  }
}

type StreamLocOptions = {
  // When true, <loc> values inside a <sitemapindex> (child sitemap URLs) are
  // reported in addition to <urlset> page URLs. Defaults to urlset-only so the
  // pattern-extraction / rewrite callers keep seeing page URLs exclusively.
  includeIndexLocs?: boolean;
};

export async function streamSitemapUrlLocs(
  filename: string,
  onUrl: LocCallback,
  options: StreamLocOptions = {}
): Promise<void> {
  const source = await openSitemapSource(filename);

  return streamSitemapUrlLocsFromSource(
    source.stream,
    source.isGzip,
    onUrl,
    options
  );
}

async function streamSitemapUrlLocsFromSource(
  source: Readable,
  isGzip: boolean,
  onUrl: LocCallback,
  options: StreamLocOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, {});
    const { decodedInput, input, preambleStripper } = createSitemapInput(
      source,
      isGzip
    );
    let rootElement: string | null = null;
    let inLoc = false;
    let locText = "";
    let settled = false;

    function settle(error?: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      destroySitemapInput(source, decodedInput, input);

      if (error) {
        reject(
          preambleStripper.hadPreambleStripped &&
            !isNonRecoverablePreambleError(error)
            ? new NonRecoverablePreambleError()
            : error
        );
        return;
      }

      resolve();
    }

    parser.onopentag = (node) => {
      const name = localName(node.name);

      if (!rootElement) {
        rootElement = name;
      }

      if (name === "loc") {
        inLoc = true;
        locText = "";
      }
    };

    parser.ontext = (text) => {
      if (inLoc) {
        locText += text;
      }
    };

    parser.oncdata = (text) => {
      if (inLoc) {
        locText += text;
      }
    };

    parser.onclosetag = (name) => {
      if (localName(name) !== "loc") {
        return;
      }

      const loc = locText.trim();
      const rootAccepted =
        rootElement === "urlset" ||
        (options.includeIndexLocs === true && rootElement === "sitemapindex");

      if (loc && rootAccepted) {
        const shouldContinue = onUrl(loc);

        if (shouldContinue === false) {
          settle();
          return;
        }
      }

      inLoc = false;
      locText = "";
    };

    parser.onerror = (error) => {
      settle(error);
    };

    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      if (settled) {
        return;
      }

      try {
        parser.write(chunk);
      } catch (error) {
        settle(error);
      }
    });

    source.on("error", settle);
    if (decodedInput !== source) {
      decodedInput.on("error", settle);
    }
    input.on("error", settle);
    input.on("end", () => {
      if (settled) {
        return;
      }

      try {
        parser.close();
      } catch (error) {
        settle(error);
        return;
      }

      settle();
    });
  });
}

export type CleanerLocStreamResult = {
  rootElement: string | null;
  isValid: boolean;
};

// Streaming <loc> reader for the Sitemap Cleaner. Fires `onLoc` for every URL
// inside a <urlset> WITHOUT ever accumulating the full URL list in memory (the
// caller decides per-URL what to keep and writes it straight to disk), and
// resolves with the detected root element + validity. Never throws on a parse
// error — it resolves with `isValid: false`, mirroring parseSitemapStream so
// the cleaner can classify the file as "unparsable" without a try/catch.
// <sitemapindex> files report their root element with no `onLoc` calls (the
// cleaner rebuilds the index from scratch, so their child locs are irrelevant).
export async function streamUrlsetLocs(
  source: Readable,
  isGzip: boolean,
  onLoc: (loc: string) => void
): Promise<CleanerLocStreamResult> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, {});
    const { decodedInput, input } = createSitemapInput(source, isGzip);
    let rootElement: string | null = null;
    let isValid = true;
    let inLoc = false;
    let locText = "";
    let settled = false;
    // An error thrown by onLoc, kept apart from parse errors. The two must NOT be
    // conflated: `parser.write` below is wrapped in a try that treats anything
    // escaping it as a malformed document. onLoc runs considerLoc, which raises
    // CleanerCapacityError on a ledger sync boundary — and that was being
    // swallowed by exactly that try, marking the FILE unparsable and resolving
    // normally. The run then reported success having silently written only part
    // of its URLs (measured: 12,286 of 32,768, with no error and no dropped
    // file), so a user would publish a truncated sitemap believing it complete.
    // A caller error is the caller's to handle, so it is rejected instead.
    let callbackError: unknown = null;

    function settle() {
      if (settled) {
        return;
      }

      settled = true;
      destroySitemapInput(source, decodedInput, input);
      resolve({ rootElement, isValid });
    }

    // Reject rather than resolve-as-invalid. Used only for an onLoc failure.
    function failHard(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      destroySitemapInput(source, decodedInput, input);
      reject(error);
    }

    function fail() {
      if (settled) {
        return;
      }

      // An onLoc failure reaches here via the parser.write / parser.close catch
      // below, because unwinding sax is how it escapes the callback. Route it to
      // the rejection path instead of reporting a parse failure that never
      // happened.
      if (callbackError !== null) {
        failHard(callbackError);

        return;
      }

      isValid = false;
      // Neutralise sax's sticky error so close()/resume() don't rethrow, then
      // settle with whatever root element we managed to read.
      (parser as unknown as { error: Error | null }).error = null;
      try {
        parser.resume();
      } catch {
        // ignore — we are tearing down regardless
      }

      settle();
    }

    parser.onopentag = (node) => {
      const name = localName(node.name);

      if (!rootElement) {
        rootElement = name;
      }

      if (name === "loc") {
        inLoc = true;
        locText = "";
      }
    };

    parser.ontext = (text) => {
      if (inLoc) {
        locText += text;
      }
    };

    parser.oncdata = (text) => {
      if (inLoc) {
        locText += text;
      }
    };

    parser.onclosetag = (name) => {
      if (localName(name) !== "loc") {
        return;
      }

      const loc = locText.trim();

      if (loc && rootElement === "urlset") {
        try {
          onLoc(loc);
        } catch (error) {
          // Record it, then rethrow: unwinding sax is the only way out of this
          // callback, and `fail()` reads callbackError to tell a caller failure
          // apart from a genuine parse error.
          callbackError = error;

          throw error;
        }
      }

      inLoc = false;
      locText = "";
    };

    parser.onerror = fail;

    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      if (settled) {
        return;
      }

      try {
        parser.write(chunk);
      } catch {
        fail();
      }
    });

    source.on("error", fail);
    if (decodedInput !== source) {
      decodedInput.on("error", fail);
    }
    input.on("error", fail);
    input.on("end", () => {
      if (settled) {
        return;
      }

      try {
        parser.close();
      } catch {
        fail();
        return;
      }

      settle();
    });
  });
}

export async function parseSitemapStream(
  source: Readable,
  isGzip: boolean,
  options: ParseSitemapOptions = {}
): Promise<ParsedSitemap> {
  return new Promise((resolve) => {
    const result: ParsedSitemap = {
      rootElement: null,
      totalUrls: 0,
      childSitemapUrls: [],
      urlLocs: options.collectUrlLocs ? [] : undefined,
      isValid: true,
      parseError: null,
      parseErrorOffset: null,
      hadPreambleStripped: false
    };
    const parser = sax.parser(true, {});
    const { decodedInput, input, preambleStripper } = createSitemapInput(
      source,
      isGzip
    );
    let inLoc = false;
    let locText = "";
    let settled = false;

    function settle() {
      if (settled) {
        return;
      }

      settled = true;
      result.hadPreambleStripped = preambleStripper.hadPreambleStripped;
      destroySitemapInput(source, decodedInput, input);
      resolve(result);
    }

    function fail(error: unknown) {
      if (settled) {
        return;
      }

      result.isValid = false;
      result.hadPreambleStripped = preambleStripper.hadPreambleStripped;
      result.parseError =
        preambleStripper.hadPreambleStripped ||
        isNonRecoverablePreambleError(error)
          ? NON_XML_PREAMBLE_ERROR
          : error instanceof Error
            ? error.message
            : String(error);
      result.parseErrorOffset = parserPosition(parser) ?? null;
      (parser as unknown as { error: Error | null }).error = null;
      parser.resume();
      settle();
    }

    parser.onopentag = (node) => {
      const name = localName(node.name);

      if (!result.rootElement) {
        result.rootElement = name;
      }

      if (name === "loc") {
        inLoc = true;
        locText = "";
      }
    };

    parser.ontext = (text) => {
      if (inLoc) {
        locText += text;
      }
    };

    parser.oncdata = (text) => {
      if (inLoc) {
        locText += text;
      }
    };

    parser.onclosetag = (name) => {
      if (localName(name) !== "loc") {
        return;
      }

      const loc = locText.trim();

      if (loc && result.rootElement === "urlset") {
        result.totalUrls += 1;
        result.urlLocs?.push(loc);
      }

      if (loc && result.rootElement === "sitemapindex") {
        result.childSitemapUrls.push(loc);
      }

      inLoc = false;
      locText = "";
    };

    parser.onerror = fail;

    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      if (settled) {
        return;
      }

      try {
        parser.write(chunk);
      } catch (error) {
        fail(error);
      }
    });

    source.on("error", fail);
    if (decodedInput !== source) {
      decodedInput.on("error", fail);
    }
    input.on("error", fail);
    input.on("end", () => {
      if (settled) {
        return;
      }

      try {
        parser.close();
      } catch (error) {
        fail(error);
        return;
      }

      settle();
    });
  });
}
