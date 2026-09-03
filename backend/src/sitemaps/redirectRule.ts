import { normalizeDigitsPath } from "./digitNormalization.js";

// Distil a pattern's confirmed redirect samples into ONE reusable rewrite rule
// so the "Fix Redirect URLs" modal can widen from the sampled subset to every
// URL in the pattern (v1.42). The sampled source→destination pairs are the
// evidence; the derived find→replace rule (e.g. strip "-parts-catalog") is
// applied to the unsampled URLs as an inference. This is server-authoritative:
// the client says WHICH urls to change, the server recomputes the destinations.

// "replace": a find→replace edit applied everywhere `find` occurs (a strip,
// or a substring swap) — position-independent, so it generalises safely
// across URLs whose {param} segments differ in length.
// "insert": nothing was removed, only a static segment was added (e.g.
// "/rfq/x" -> "/aviation/rfq/x"). There is no non-empty substring to anchor a
// global replace on, so this is anchored on the literal, fixed `prefix` text
// shared by every sample instead — the same prefix every URL in the pattern
// carries up to its first {param} segment, so it generalises just as safely.
// "normalizeDigits": strip zero padding from numeric path tokens
// ("page-1-003" -> "page-1-3"), optionally dropping a token that is left as plain
// zero ("page-3-00" -> "page-3"). Unlike the other two kinds this is NOT a literal
// string edit — it is a function of each digit run's VALUE — which is exactly why
// diffPair cannot express it: the two examples above derive `strip "-00"` and
// `strip "00"`, and each is wrong for the other's URL. See digitNormalization.ts.
export type RedirectRule =
  | { kind: "replace"; find: string; replace: string }
  | { kind: "insert"; prefix: string; insert: string }
  | { kind: "normalizeDigits"; dropZeroTokens: boolean };

// EXPORTED for redirectRuleCandidates (v1.71), which offers a human the
// readings of a sample that deriveRedirectRule below REFUSES to choose
// between. It has to diff and compare rules identically or the options on
// screen would not be the ones the automatic path considered.
//
// Diff one source→dest pair into the substring that changed, by peeling off the
// longest common prefix and suffix. When nothing was removed (the whole source
// survives as a suffix of dest) this is a pure insertion, anchored on the
// literal common prefix rather than a find/replace pair (v1.43).
export function diffPair(
  source: string,
  dest: string
): RedirectRule | null {
  const max = Math.min(source.length, dest.length);
  let prefix = 0;

  while (prefix < max && source[prefix] === dest[prefix]) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < max - prefix &&
    source[source.length - 1 - suffix] === dest[dest.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const find = source.slice(prefix, source.length - suffix);
  const replace = dest.slice(prefix, dest.length - suffix);

  if (find === "") {
    // Nothing removed. If nothing was inserted either, source === dest and
    // there is no rule to derive.
    if (replace === "") {
      return null;
    }

    return { kind: "insert", prefix: source.slice(0, prefix), insert: replace };
  }

  return { kind: "replace", find, replace };
}

// A SWITCH, not the old two-branch ternary. That ternary treated "not insert" as
// "must be replace", so two normalizeDigits rules with DIFFERENT dropZeroTokens
// would have compared their (undefined) find/replace fields and reported EQUAL —
// silently merging the two readings this feature exists to keep apart.
export function sameRule(a: RedirectRule, b: RedirectRule): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "insert": {
      const other = b as Extract<RedirectRule, { kind: "insert" }>;

      return a.prefix === other.prefix && a.insert === other.insert;
    }
    case "normalizeDigits": {
      const other = b as Extract<RedirectRule, { kind: "normalizeDigits" }>;

      return a.dropZeroTokens === other.dropZeroTokens;
    }
    default: {
      const other = b as Extract<RedirectRule, { kind: "replace" }>;

      return a.find === other.find && a.replace === other.replace;
    }
  }
}

// Normalize ONLY the path of a URL, leaving the origin byte-identical.
//
// applyRedirectRule receives whole <loc> values, and a host can legitimately carry
// a zero-padded label ("web-007.example.com") or a port. Rewriting those would
// point the sitemap at a different SERVER, not a different page. String surgery
// rather than `new URL().toString()` so the untouched half stays byte-for-byte
// what it was — this value is written into sitemap files.
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(.*)$/i;

export function normalizeDigitsUrl(url: string, dropZeroTokens: boolean): string {
  const match = ABSOLUTE_URL.exec(url);

  if (!match) {
    // Not an absolute URL: templates and paths reach this too, and for those the
    // whole string IS the path.
    return normalizeDigitsPath(url, dropZeroTokens);
  }

  return `${match[1]}${normalizeDigitsPath(match[2], dropZeroTokens)}`;
}

// Derive the single rule shared by every sampled pair. Returns null when
// there are no usable pairs OR the pairs disagree (different edits) — in that
// case we must NOT infer, and the caller falls back to sampled-only.
export function deriveRedirectRule(
  pairs: { source: string; dest: string }[]
): RedirectRule | null {
  const usable = pairs.filter(
    (pair) => pair.source && pair.dest && pair.source !== pair.dest
  );
  let rule: RedirectRule | null = null;
  let agreed = true;

  for (const pair of usable) {
    const diff = diffPair(pair.source, pair.dest);

    if (!diff) {
      agreed = false;
      break;
    }

    if (rule === null) {
      rule = diff;
    } else if (!sameRule(rule, diff)) {
      agreed = false;
      break;
    }
  }

  if (agreed) {
    // Unchanged behaviour for every case that already worked, including the
    // no-usable-pairs case, which still yields null.
    return rule;
  }

  // THE LITERAL READINGS DISAGREE — which is where this used to give up.
  //
  // Before falling back to sampled-only, try the value-based readings: zero-padded
  // pairs are the known reason diffPair produces mutually contradictory rules
  // ("page-3-00 -> page-3" says strip "-00"; "page-1-003 -> page-1-3" says strip
  // "00"), and a single normalization explains both. Only adopted when it explains
  // EVERY pair, so this can never widen on a partial match.
  return deriveNormalizationRule(usable);
}

// The value-based readings, tried narrowest-first: plain zero-stripping before the
// one that also deletes a zero-valued token, so the rule that changes less wins a
// tie.
export function deriveNormalizationRule(
  pairs: { source: string; dest: string }[]
): RedirectRule | null {
  if (pairs.length === 0) {
    return null;
  }

  for (const dropZeroTokens of [false, true]) {
    const explainsEveryPair = pairs.every(
      (pair) => normalizeDigitsUrl(pair.source, dropZeroTokens) === pair.dest
    );

    if (explainsEveryPair) {
      return { kind: "normalizeDigits", dropZeroTokens };
    }
  }

  return null;
}

// Apply the rule to a URL, returning the rewritten URL or null when it does
// not apply / does not change the URL.
export function applyRedirectRule(
  url: string,
  rule: RedirectRule
): string | null {
  if (rule.kind === "normalizeDigits") {
    const next = normalizeDigitsUrl(url, rule.dropZeroTokens);

    // Returning null for "no change" is the contract every caller relies on, and
    // it matters more here than for the literal kinds: this rule is offered for a
    // whole pattern, and most URLs in that pattern carry no padding at all. They
    // must come back untouched, not merely unchanged-looking.
    return next === url ? null : next;
  }

  if (rule.kind === "insert") {
    if (!url.startsWith(rule.prefix)) {
      return null;
    }

    const next = rule.prefix + rule.insert + url.slice(rule.prefix.length);

    return next === url ? null : next;
  }

  if (rule.find === "" || !url.includes(rule.find)) {
    return null;
  }

  const next = url.split(rule.find).join(rule.replace);

  return next === url ? null : next;
}
