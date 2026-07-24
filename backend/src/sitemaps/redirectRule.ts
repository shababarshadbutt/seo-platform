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
export type RedirectRule =
  | { kind: "replace"; find: string; replace: string }
  | { kind: "insert"; prefix: string; insert: string };

// Diff one source→dest pair into the substring that changed, by peeling off the
// longest common prefix and suffix. When nothing was removed (the whole source
// survives as a suffix of dest) this is a pure insertion, anchored on the
// literal common prefix rather than a find/replace pair (v1.43).
function diffPair(source: string, dest: string): RedirectRule | null {
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

function sameRule(a: RedirectRule, b: RedirectRule): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  return a.kind === "insert"
    ? a.prefix === (b as { prefix: string }).prefix &&
        a.insert === (b as { insert: string }).insert
    : a.find === (b as { find: string }).find &&
        a.replace === (b as { replace: string }).replace;
}

// Derive the single rule shared by every sampled pair. Returns null when
// there are no usable pairs OR the pairs disagree (different edits) — in that
// case we must NOT infer, and the caller falls back to sampled-only.
export function deriveRedirectRule(
  pairs: { source: string; dest: string }[]
): RedirectRule | null {
  let rule: RedirectRule | null = null;

  for (const pair of pairs) {
    if (!pair.source || !pair.dest || pair.source === pair.dest) {
      continue;
    }

    const diff = diffPair(pair.source, pair.dest);

    if (!diff) {
      return null;
    }

    if (rule === null) {
      rule = diff;
    } else if (!sameRule(rule, diff)) {
      return null;
    }
  }

  return rule;
}

// Apply the rule to a URL, returning the rewritten URL or null when it does
// not apply / does not change the URL.
export function applyRedirectRule(
  url: string,
  rule: RedirectRule
): string | null {
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
