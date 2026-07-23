// Distil a pattern's confirmed redirect samples into ONE reusable rewrite rule
// so the "Fix Redirect URLs" modal can widen from the sampled subset to every
// URL in the pattern (v1.42). The sampled source→destination pairs are the
// evidence; the derived find→replace rule (e.g. strip "-parts-catalog") is
// applied to the unsampled URLs as an inference. This is server-authoritative:
// the client says WHICH urls to change, the server recomputes the destinations.

export type RedirectRule = { find: string; replace: string };

// Diff one source→dest pair into the substring that changed, by peeling off the
// longest common prefix and suffix. Returns null when nothing was removed
// (find === "") — a pure insertion is not a strip/replace we can generalise.
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
    return null;
  }

  return { find, replace };
}

// Derive the single find→replace rule shared by every sampled pair. Returns
// null when there are no usable pairs OR the pairs disagree (different edits) —
// in that case we must NOT infer, and the caller falls back to sampled-only.
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
    } else if (rule.find !== diff.find || rule.replace !== diff.replace) {
      return null;
    }
  }

  return rule;
}

// Apply the rule to a URL (all occurrences of `find`), returning the rewritten
// URL or null when it does not apply / does not change the URL.
export function applyRedirectRule(
  url: string,
  rule: RedirectRule
): string | null {
  if (rule.find === "" || !url.includes(rule.find)) {
    return null;
  }

  const next = url.split(rule.find).join(rule.replace);

  return next === url ? null : next;
}
