// Leading-zero normalization of numeric URL tokens.
//
// WHY. The rebuilt site drops zero padding from numeric path tokens:
// "page-1-003/" is served as "page-1-3/", and "page-3-00/" as "page-3/". The old
// sitemaps still carry the padded spelling, so those <loc> values point at pages
// that no longer resolve.
//
// The tool could not express that fix. Redirect destinations for unprobed URLs
// come from RedirectRule, whose two kinds are both LITERAL, position-independent
// string edits — and this transformation is a function of a digit run's VALUE, not
// of any fixed substring. diffPair proves it: the two examples above derive
// `strip "-00"` and `strip "00"`, and each is wrong for the other's URL
// (page-1-003 -> "page-13", page-3-00 -> "page-3-"). So deriveRedirectRule
// correctly refuses, and the operator is offered two readings that are each right
// half the time.
//
// TWO READINGS, AND WE DO NOT GUESS BETWEEN THEM. "page-3-00" could normalize to
// "page-3-0" (strip the padding) or to "page-3" (strip it, and drop a token that
// is now just zero). Both are defensible from the URL alone. Rather than pick, the
// caller generates BOTH and probes them; the site decides. See
// jobs/normalizationProbeJob.ts.
//
// Pure — no I/O, no config, no clock — so its tests mock nothing.

// A token is zero-PADDED only when it is all digits, leads with 0, and has at
// least two digits.
//
// A bare "0" deliberately does NOT qualify. It is not padding, and treating it as
// such would turn "/page-0/" into "/page/" on every site that numbers from zero —
// a rewrite nobody asked for, on a URL that was never broken.
const PADDED_TOKEN = /^0\d+$/;

// Only "-" and "_". A "." is excluded on purpose: it is how file extensions and
// version numbers are spelled, and "v1.03" -> "v1.3" is a different claim than the
// one this module is making.
const SEPARATORS = new Set(["-", "_"]);

export type NormalizationKind = "strip" | "stripDropZero";

export type NormalizationVariant = {
  kind: NormalizationKind;
  path: string;
};

// Split a path segment into alternating tokens and separators, so that
// "page-1-003" becomes ["page", "-", "1", "-", "003"]. Even indices are tokens,
// odd indices are the separators between them; that invariant is what lets the
// rebuild below decide separator survival by looking at its two neighbours.
function splitTokens(segment: string): string[] {
  const parts: string[] = [];
  let current = "";

  for (const character of segment) {
    if (SEPARATORS.has(character)) {
      parts.push(current, character);
      current = "";
      continue;
    }

    current += character;
  }

  parts.push(current);

  return parts;
}

function normalizeSegment(segment: string, dropZeroTokens: boolean): string {
  if (!segment) {
    return segment;
  }

  const parts = splitTokens(segment);
  const keep = parts.map(() => true);

  for (let index = 0; index < parts.length; index += 2) {
    const token = parts[index];

    if (!PADDED_TOKEN.test(token)) {
      continue;
    }

    const stripped = token.replace(/^0+/, "");

    if (stripped === "") {
      // The token was all zeros, so its VALUE is zero. Either it becomes "0", or
      // — under stripDropZero — it disappears entirely, which is the reading that
      // turns "page-3-00" into "page-3".
      if (dropZeroTokens) {
        keep[index] = false;
        continue;
      }

      parts[index] = "0";
      continue;
    }

    parts[index] = stripped;
  }

  // A dropped token takes EXACTLY ONE separator with it: the one before it, or —
  // when it is the first token — the one after. Preferring the preceding separator
  // handles the common trailing case ("page-3-00" -> "page-3") and the leading one
  // ("00-page" -> "page") with the same rule.
  //
  // It has to be exactly one. Removing every separator adjacent to a dropped token
  // welds its neighbours together: "a-00-b" would become "ab" instead of "a-b",
  // silently inventing a URL that was never on either site.
  for (let index = 0; index < parts.length; index += 2) {
    if (keep[index]) {
      continue;
    }

    if (index > 0) {
      keep[index - 1] = false;
      continue;
    }

    if (index + 1 < parts.length) {
      keep[index + 1] = false;
    }
  }

  const rebuilt = parts.filter((_, index) => keep[index]).join("");

  // NEVER EMPTY A SEGMENT. "/00/" would otherwise become "//", which is a
  // different path with a different meaning — and one the site was never asked
  // about. Fall back to the non-dropping reading, which always keeps a token.
  if (rebuilt === "") {
    return dropZeroTokens ? normalizeSegment(segment, false) : segment;
  }

  return rebuilt;
}

// The core transform, shared by the variant generator below and by
// applyRedirectRule. One implementation, so the URL that gets PROBED and the URL
// the accepted rule later WRITES cannot drift apart.
export function normalizeDigitsPath(
  path: string,
  dropZeroTokens: boolean
): string {
  // Query and fragment are carried through untouched: they are not part of the
  // path identity this rule is about, and a padded id in a query string is a
  // different question.
  const marker = path.search(/[?#]/);
  const suffix = marker === -1 ? "" : path.slice(marker);
  const bare = marker === -1 ? path : path.slice(0, marker);

  // Splitting on "/" yields empty leading and trailing entries for a path that
  // starts and ends with one, and normalizeSegment returns those unchanged — so
  // the trailing slash survives without a special case.
  const normalized = bare
    .split("/")
    .map((segment) => normalizeSegment(segment, dropZeroTokens))
    .join("/");

  return `${normalized}${suffix}`;
}

// The ordered, de-duplicated set of paths worth PROBING for one URL.
//
// Empty when the path carries no zero-padded token, which is the cost guard: a URL
// like "page-4-17/" generates nothing and so spends no requests. Only URLs the
// rule could possibly apply to are ever probed.
//
// When both readings agree — "page-1-003" normalizes to "page-1-3" either way,
// because it has no zero-VALUED token — only one variant is emitted, so the
// common case costs a single extra request rather than two.
export function normalizationVariants(path: string): NormalizationVariant[] {
  const variants: NormalizationVariant[] = [];
  const seen = new Set<string>([path]);

  for (const kind of ["strip", "stripDropZero"] as const) {
    const candidate = normalizeDigitsPath(path, kind === "stripDropZero");

    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    variants.push({ kind, path: candidate });
  }

  return variants;
}

// Whether a path has anything for this module to do. Cheap enough to run over a
// whole pattern before deciding which URLs to sample for probing.
export function hasPaddedToken(path: string): boolean {
  return normalizationVariants(path).length > 0;
}
