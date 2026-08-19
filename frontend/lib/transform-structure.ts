// Client-side mirror of backend/src/sitemaps/transformStructure.ts — used to
// render the Preview step of the Update Pattern modal by applying the same
// transform to a handful of real sampled URLs before anything is sent to the
// backend. KEEP IN SYNC with the backend module (same parsing + semantics), so
// the preview matches exactly what the server will write.

export type ParamTransform =
  | { kind: "none" }
  | { kind: "replace"; find: string; replace: string }
  | { kind: "upper" }
  | { kind: "lower" }
  // Insert `separator` at `position` characters into the value: "24" with
  // position 1 and separator "-" gives "2-4". Positional rather than
  // content-matched, which is the whole point — `replace` acts on every
  // occurrence of a needle, so it cannot target ONE of several identical
  // characters ("niin-parts-24" with find "-" hits both hyphens).
  | { kind: "insertAt"; position: number; separator: string };

export type SegmentRule =
  | { type: "static"; value: string }
  | { type: "param"; name: string; transform: ParamTransform };

export type ParsedStructure = {
  segments: SegmentRule[];
  trailingSlash: boolean;
};

export class StructureSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructureSyntaxError";
  }
}

const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function parseParamToken(inner: string): SegmentRule {
  const parts = inner.split("|");
  const name = parts[0];

  if (!PARAM_NAME.test(name)) {
    throw new StructureSyntaxError(
      `invalid param name "${name}" — name segments like {A}, {B}, {C}`
    );
  }

  if (parts.length === 1) {
    return { type: "param", name, transform: { kind: "none" } };
  }

  if (parts.length === 3 && parts[2] === "") {
    const op = parts[1];

    if (op === "upper") {
      return { type: "param", name, transform: { kind: "upper" } };
    }

    if (op === "lower") {
      return { type: "param", name, transform: { kind: "lower" } };
    }

    if (op === "") {
      throw new StructureSyntaxError(
        `{${inner}} is missing text to strip — write {${name}|text|}`
      );
    }

    return {
      type: "param",
      name,
      transform: { kind: "replace", find: op, replace: "" }
    };
  }

  if (parts.length === 4 && parts[3] === "") {
    if (parts[1] === "") {
      throw new StructureSyntaxError(
        `{${inner}} has an empty search term — write {${name}|old|new|}`
      );
    }

    return {
      type: "param",
      name,
      transform: { kind: "replace", find: parts[1], replace: parts[2] }
    };
  }

  // {A|split|N|sep|} — insert sep after N characters.
  if (parts.length === 5 && parts[4] === "" && parts[1] === "split") {
    const rawPosition = parts[2];

    // Digits only. Number.parseInt alone would silently accept "1.5" and "1abc"
    // as 1, so the structure would apply a transform the user did not write.
    if (!/^\d+$/.test(rawPosition)) {
      throw new StructureSyntaxError(
        `{${inner}} has an invalid split position "${rawPosition}" — write a whole number of characters, e.g. {${name}|split|1|-|}`
      );
    }

    return {
      type: "param",
      name,
      // Empty separator is allowed and is a documented no-op, rather than an
      // error: it is unambiguous about what it does, and rejecting it would
      // mean a half-typed expression errors mid-keystroke.
      transform: {
        kind: "insertAt",
        position: Number.parseInt(rawPosition, 10),
        separator: parts[3]
      }
    };
  }

  throw new StructureSyntaxError(
    `{${inner}} is not a valid transform — use {A}, {A|text|}, {A|old|new|}, {A|upper|}, {A|lower|} or {A|split|N|sep|}`
  );
}

export function parseStructure(structure: string): ParsedStructure {
  const trimmed = structure.trim();
  const withoutLeading = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const trailingSlash =
    withoutLeading.length > 0 && withoutLeading.endsWith("/");
  const body = trailingSlash ? withoutLeading.slice(0, -1) : withoutLeading;
  const rawSegments = body === "" ? [] : body.split("/");

  const segments = rawSegments.map<SegmentRule>((segment) => {
    if (segment.startsWith("{") && segment.endsWith("}")) {
      return parseParamToken(segment.slice(1, -1));
    }

    if (segment.includes("{") || segment.includes("}")) {
      throw new StructureSyntaxError(
        `segment "${segment}" mixes a brace with static text — keep each {param} in its own /segment/`
      );
    }

    return { type: "static", value: segment };
  });

  return { segments, trailingSlash };
}

function applyTransform(value: string, transform: ParamTransform): string {
  switch (transform.kind) {
    case "none":
      return value;
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "replace":
      return value.split(transform.find).join(transform.replace);
    case "insertAt": {
      // Clamped rather than rejected: a position past the end appends, which is a
      // sensible reading of "insert here" and keeps a transform that is correct
      // for most values from failing the whole run on one short outlier.
      const at = Math.max(0, Math.min(transform.position, value.length));

      return `${value.slice(0, at)}${transform.separator}${value.slice(at)}`;
    }
  }
}

export function structureParamNames(parsed: ParsedStructure): string[] {
  return parsed.segments
    .filter(
      (rule): rule is Extract<SegmentRule, { type: "param" }> =>
        rule.type === "param"
    )
    .map((rule) => rule.name);
}

export function validateStructures(
  current: ParsedStructure,
  next: ParsedStructure,
  patternParamCount: number
): string | null {
  const currentNames = structureParamNames(current);
  const nextNames = structureParamNames(next);

  if (currentNames.length !== patternParamCount) {
    // The zero-param case is overwhelmingly "typed a literal example URL
    // instead of the {A} template syntax" (e.g. /nsn/niin-parts-567/ for a
    // /nsn/{param} pattern). The bare count mismatch is accurate but offers no
    // way out, and Preview stays disabled — so this case gets the instruction.
    // A literal can never be valid here: it matches only the one URL it names.
    if (currentNames.length === 0 && patternParamCount > 0) {
      return (
        `current structure defines 0 params but the pattern has ${patternParamCount} — ` +
        `put {A}${patternParamCount > 1 ? ", {B}…" : ""} where the URL varies ` +
        `instead of a literal value`
      );
    }

    return `current structure defines ${currentNames.length} param${
      currentNames.length === 1 ? "" : "s"
    } but the pattern has ${patternParamCount}`;
  }

  const currentSet = new Set(currentNames);

  if (currentSet.size !== currentNames.length) {
    return "current structure repeats a param name — each of {A}, {B}, ... must be unique";
  }

  for (const name of nextNames) {
    if (!currentSet.has(name)) {
      return `new structure references {${name}}, which is not defined in the current structure`;
    }
  }

  const nextSet = new Set(nextNames);

  for (const name of currentNames) {
    if (!nextSet.has(name)) {
      return `new structure drops {${name}} — every param from the current structure must be kept`;
    }
  }

  return null;
}

// The per-param values a URL yields when matched against `current`.
//
// transformUrl builds exactly this map internally and then throws it away,
// returning only the rewritten string. Callers that need to reason about the
// captured VALUES — e.g. warning that a new static segment duplicates text
// already inside {A} — would otherwise have to re-implement the segment walk and
// the static-equality check, and drift from it. Returns null when the URL does
// not match, on the same conditions transformUrl returns null for.
export function captureStructureValues(
  rawUrl: string,
  current: ParsedStructure
): Map<string, string> | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const urlSegments = url.pathname.split("/").filter(Boolean);

  if (urlSegments.length !== current.segments.length) {
    return null;
  }

  const values = new Map<string, string>();

  for (let index = 0; index < current.segments.length; index += 1) {
    const rule = current.segments[index];
    const segment = urlSegments[index];

    if (rule.type === "static") {
      if (rule.value !== segment) {
        return null;
      }
    } else {
      values.set(rule.name, segment);
    }
  }

  return values;
}

export function transformUrl(
  rawUrl: string,
  current: ParsedStructure,
  next: ParsedStructure
): string | null {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const urlSegments = url.pathname.split("/").filter(Boolean);

  if (urlSegments.length !== current.segments.length) {
    return null;
  }

  const values = new Map<string, string>();

  for (let index = 0; index < current.segments.length; index += 1) {
    const rule = current.segments[index];
    const segment = urlSegments[index];

    if (rule.type === "static") {
      if (rule.value !== segment) {
        return null;
      }
    } else {
      values.set(rule.name, segment);
    }
  }

  const rebuilt = next.segments.map((rule) => {
    if (rule.type === "static") {
      return rule.value;
    }

    return applyTransform(values.get(rule.name) ?? "", rule.transform);
  });

  let nextPath = `/${rebuilt.join("/")}`;

  if (next.trailingSlash && !nextPath.endsWith("/")) {
    nextPath += "/";
  }

  url.pathname = nextPath;

  const result = url.toString();

  return result === rawUrl ? null : result;
}

// Convert a pattern template's {param} placeholders to positional {A}, {B},
// {C}… names for the Update Pattern modal's structure fields, so the SEO team
// doesn't have to retype a structure that's already on screen. Every static
// segment and the trailing slash are preserved untouched. (v1.40)
//   /manufacturer/{param}/{param}/        -> /manufacturer/{A}/{B}/
//   /rfq/{param}/{param}/{param}/{param}/ -> /rfq/{A}/{B}/{C}/{D}/
//
// Lives here rather than in the page so the modal's "Use this structure"
// recovery affordance and the v1.40 pre-fill share one implementation, and so
// the result is guaranteed to satisfy validateStructures for its own template.
export function convertParamToABC(template: string): string {
  let index = 0;

  return template.replace(/\{param\}/g, () => {
    const letter = String.fromCharCode(65 + index);

    index += 1;

    return `{${letter}}`;
  });
}

// Count "{param}" placeholders in a pattern template (mirror of the backend
// countTemplateParams) so the modal can validate the current structure's param
// count against the pattern before allowing a preview.
export function countTemplateParams(template: string): number {
  const trimmed = template.trim();
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  if (path === "") {
    return 0;
  }

  return path.split("/").filter((segment) => segment === "{param}").length;
}

// --- by-example inference ----------------------------------------------------
//
// Everything below turns a BEFORE/AFTER pair of real URLs into a new-structure
// string, so the SEO team can retype a URL instead of learning the
// {A|split|N|sep|} grammar. The grammar itself is unchanged; this only writes it.
//
// Mirrored verbatim in the other copy and byte-compared by the sync guard: the
// modal infers the rule locally as the user types and the API re-infers it
// before applying, so the two MUST agree on what an example means.

export type StructureAlternative = {
  // A complete new-structure string, differing from the chosen one at exactly
  // one segment.
  structure: string;
  // That segment, already formatted, so the UI can name the choice without
  // re-deriving it.
  segment: string;
};

export type StructureInference =
  | {
      ok: true;
      structure: string;
      alternatives: StructureAlternative[];
      warnings: string[];
    }
  | { ok: false; error: string };

// Render one segment rule back into the grammar parseStructure accepts. The
// round trip parseStructure(formatStructure(...)) is what the inference uses to
// validate its own output, so this must stay the exact inverse of
// parseParamToken.
export function formatSegmentRule(rule: SegmentRule): string {
  if (rule.type === "static") {
    return rule.value;
  }

  const transform = rule.transform;

  if (transform.kind === "none") {
    return "{" + rule.name + "}";
  }

  if (transform.kind === "upper") {
    return "{" + rule.name + "|upper|}";
  }

  if (transform.kind === "lower") {
    return "{" + rule.name + "|lower|}";
  }

  if (transform.kind === "insertAt") {
    return (
      "{" +
      rule.name +
      "|split|" +
      String(transform.position) +
      "|" +
      transform.separator +
      "|}"
    );
  }

  return transform.replace === ""
    ? "{" + rule.name + "|" + transform.find + "|}"
    : "{" + rule.name + "|" + transform.find + "|" + transform.replace + "|}";
}

export function formatStructure(
  segments: SegmentRule[],
  trailingSlash: boolean
): string {
  const body = segments.map(formatSegmentRule).join("/");

  return body === "" ? "/" : "/" + body + (trailingSlash ? "/" : "");
}

// How good an explanation a transform is, higher meaning "more likely to be what
// the user meant". Used ONLY to choose between readings of one example, never to
// decide whether a rule is correct.
function transformQuality(transform: ParamTransform): number {
  switch (transform.kind) {
    case "none":
      return 100;
    case "upper":
    case "lower":
      return 60;
    case "insertAt":
      return 50;
    case "replace":
      return 30;
  }
}

// Prefix offsets to try when reading the change as a `replace`: the maximal
// shared prefix first, then back off to each "-" token boundary inside it, then
// the whole value. Backing off is what makes a replace candidate possible at
// all — the maximal decomposition of "part-720" to "part-7-20" leaves NOTHING
// removed, so the needle has to start earlier to exist.
function replaceOffsets(value: string, maximalPrefix: number): number[] {
  const offsets = [maximalPrefix];

  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (value[index] === "-" && index + 1 < maximalPrefix) {
      offsets.push(index + 1);
    }
  }

  if (maximalPrefix > 0) {
    offsets.push(0);
  }

  return offsets;
}

// Every transform in the grammar that turns `value` into `segment`, best first.
//
// ORDERING IS DELIBERATE AND IS NOT BY HOW MANY URLS A CANDIDATE WOULD TOUCH.
// "part-720" to "part-7-20" is explained equally well by {A|split|6|-|} and by
// {A|7|7-|}, and the second changes strictly MORE URLs — including turning
// "part-777" into "part-7-7-7-", because `replace` acts on EVERY occurrence of
// its needle. That is the exact failure the positional operator was added to
// avoid, so a positional reading always outranks a content-matched one and
// "more general" is never the tie-breaker.
export function candidateTransforms(
  value: string,
  segment: string
): ParamTransform[] {
  if (value === segment) {
    return [{ kind: "none" }];
  }

  const candidates: ParamTransform[] = [];

  if (value.toUpperCase() === segment) {
    candidates.push({ kind: "upper" });
  }

  if (value.toLowerCase() === segment) {
    candidates.push({ kind: "lower" });
  }

  // Shared material, measured from both ends. Every reading below is a slice of
  // this one decomposition: the value's middle is what went away, the segment's
  // middle is what took its place.
  let prefix = 0;

  while (
    prefix < value.length &&
    prefix < segment.length &&
    value[prefix] === segment[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;

  while (
    suffix < value.length - prefix &&
    suffix < segment.length - prefix &&
    value[value.length - 1 - suffix] === segment[segment.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  // Nothing in common at either end means the user typed an unrelated literal
  // where a param used to sit. That is a STATIC segment, not a transform of the
  // param: reading it as {A|part-720|nsnpart|} would produce a rule matching
  // exactly the one URL it was derived from.
  if (prefix === 0 && suffix === 0) {
    return candidates;
  }

  const valueMiddle = value.slice(prefix, value.length - suffix);
  const segmentMiddle = segment.slice(prefix, segment.length - suffix);

  if (valueMiddle === "" && segmentMiddle !== "") {
    candidates.push({
      kind: "insertAt",
      position: prefix,
      separator: segmentMiddle
    });
  }

  // A needle occurring more than once is not rejected up front — it is APPLIED
  // and checked. split/join over every occurrence is what the grammar actually
  // does, so only the result can say whether hitting them all was harmless.
  const tried = new Set<string>();

  for (const offset of replaceOffsets(value, prefix)) {
    const keep = Math.min(
      suffix,
      value.length - offset,
      segment.length - offset
    );
    const find = value.slice(offset, value.length - keep);
    const replace = segment.slice(offset, segment.length - keep);

    if (find === "" || tried.has(find)) {
      continue;
    }

    tried.add(find);

    if (value.split(find).join(replace) === segment) {
      candidates.push({ kind: "replace", find, replace });
    }
  }

  return candidates;
}

// Assign new-URL segments to the current structure's params, in order, choosing
// the alignment with the best total explanation quality.
//
// NOT GREEDY, and the difference is load-bearing. For {A} = "niin-parts-503"
// rewritten to /nsn/niin-parts/niin-parts-503/, a left-to-right first-match walk
// binds {A} to the "niin-parts" segment as {A|-503|} and leaves the real value
// as a static literal — a rule that reproduces this one example perfectly and is
// wrong for every other URL in the pattern. Scoring the whole alignment picks
// the exact match instead, because 100 beats 30.
function alignSegments(
  segments: string[],
  names: string[],
  values: Map<string, string>
): Array<{ rule: SegmentRule; options: ParamTransform[] }> | null {
  const segmentCount = segments.length;
  const nameCount = names.length;
  const optionsFor: ParamTransform[][][] = [];

  for (let i = 0; i < segmentCount; i += 1) {
    const row: ParamTransform[][] = [];

    for (let j = 0; j < nameCount; j += 1) {
      const value = values.get(names[j]);

      row.push(value === undefined ? [] : candidateTransforms(value, segments[i]));
    }

    optionsFor.push(row);
  }

  // best[i][j]: score for the first i segments having consumed the first j
  // params. -1 marks unreachable.
  const best: number[][] = [];
  const cameFromParam: boolean[][] = [];

  for (let i = 0; i <= segmentCount; i += 1) {
    best.push(new Array<number>(nameCount + 1).fill(-1));
    cameFromParam.push(new Array<boolean>(nameCount + 1).fill(false));
  }

  best[0][0] = 0;

  for (let i = 0; i < segmentCount; i += 1) {
    for (let j = 0; j <= nameCount; j += 1) {
      if (best[i][j] < 0) {
        continue;
      }

      // This segment is a static literal.
      if (best[i][j] > best[i + 1][j]) {
        best[i + 1][j] = best[i][j];
        cameFromParam[i + 1][j] = false;
      }

      // Or it carries the next unconsumed param.
      if (j < nameCount && optionsFor[i][j].length > 0) {
        const score = best[i][j] + transformQuality(optionsFor[i][j][0]);

        if (score > best[i + 1][j + 1]) {
          best[i + 1][j + 1] = score;
          cameFromParam[i + 1][j + 1] = true;
        }
      }
    }
  }

  if (best[segmentCount][nameCount] < 0) {
    return null;
  }

  const assigned: Array<{ rule: SegmentRule; options: ParamTransform[] }> = [];
  let cursor = nameCount;

  for (let i = segmentCount; i > 0; i -= 1) {
    if (cameFromParam[i][cursor]) {
      const options = optionsFor[i - 1][cursor - 1];

      assigned.push({
        rule: { type: "param", name: names[cursor - 1], transform: options[0] },
        options
      });
      cursor -= 1;
    } else {
      assigned.push({
        rule: { type: "static", value: segments[i - 1] },
        options: []
      });
    }
  }

  return assigned.reverse();
}

// Infer a new-structure string from one real URL and the URL the user wants it
// to become.
//
// The CURRENT structure is never inferred: the modal pre-fills it from the
// pattern itself and `oldUrl` matches it by construction, which keeps the search
// space down to "what happened to each param value".
export function inferNewStructure(
  oldUrl: string,
  newUrl: string,
  current: ParsedStructure
): StructureInference {
  const values = captureStructureValues(oldUrl, current);

  if (!values) {
    return {
      ok: false,
      error:
        "the example URL does not match the current structure — reset the current structure first"
    };
  }

  let target: URL;

  try {
    // Resolved against the old URL so a bare path is accepted too, inheriting
    // the host rather than losing it.
    target = new URL(newUrl, oldUrl);
  } catch {
    return { ok: false, error: '"' + newUrl + '" is not a valid URL or path' };
  }

  const warnings: string[] = [];

  try {
    if (new URL(oldUrl).host !== target.host) {
      warnings.push(
        "the host differs from the example — a structure transform rewrites the path only, so the host is left as it is"
      );
    }
  } catch {
    // oldUrl already parsed inside captureStructureValues; nothing to add.
  }

  const segments = target.pathname.split("/").filter(Boolean);
  const trailingSlash =
    target.pathname.length > 1 && target.pathname.endsWith("/");
  const names = structureParamNames(current);
  const aligned = alignSegments(segments, names, values);

  if (!aligned) {
    return {
      ok: false,
      error:
        names.length === 1
          ? 'the new URL keeps nothing of "' +
            (values.get(names[0]) ?? "") +
            '", so every URL in this pattern would collapse to the same literal — keep the varying part somewhere in it'
          : "the new URL does not keep every varying part of the old one, in the same order"
    };
  }

  const structure = formatStructure(
    aligned.map((entry) => entry.rule),
    trailingSlash
  );

  // From here the inferred string is treated as untrusted input and pushed
  // through the SAME gates a hand-typed structure goes through, so an inference
  // bug surfaces as a refusal rather than as a wrong rewrite of a million URLs.
  let next: ParsedStructure;

  try {
    next = parseStructure(structure);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof StructureSyntaxError
          ? "inferred " + structure + ", which is not valid: " + error.message
          : "could not express that change as a structure (inferred " +
            structure +
            ")"
    };
  }

  const invalid = validateStructures(current, next, names.length);

  if (invalid) {
    return { ok: false, error: invalid };
  }

  // The self-check. Applying the inferred rule to the example must reproduce
  // exactly what the user typed; anything else means the inference is wrong, and
  // a wrong rule must never reach the apply path.
  const applied = transformUrl(oldUrl, current, next);

  if (applied === null) {
    return {
      ok: false,
      error: "the new URL is identical to the old one — nothing would change"
    };
  }

  const appliedPath = new URL(applied).pathname;

  if (appliedPath !== target.pathname) {
    return {
      ok: false,
      error:
        "could not work out a rule for that change — " +
        structure +
        " would produce " +
        appliedPath +
        ", not " +
        target.pathname
    };
  }

  // Alternatives vary ONE segment at a time from the chosen alignment. The full
  // cross-product of every ambiguous segment is exponential and unreadable; a
  // list of single substitutions is what a reviewer can actually check.
  const alternatives: StructureAlternative[] = [];

  for (let index = 0; index < aligned.length; index += 1) {
    const entry = aligned[index];

    if (entry.rule.type !== "param") {
      continue;
    }

    const name = entry.rule.name;

    for (let option = 1; option < entry.options.length; option += 1) {
      const rule: SegmentRule = {
        type: "param",
        name,
        transform: entry.options[option]
      };
      const swapped = aligned.map((other, otherIndex) =>
        otherIndex === index ? rule : other.rule
      );

      alternatives.push({
        structure: formatStructure(swapped, trailingSlash),
        segment: formatSegmentRule(rule)
      });
    }
  }

  return { ok: true, structure, alternatives, warnings };
}
