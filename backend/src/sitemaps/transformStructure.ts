// Per-segment transformation for pattern-scoped URL structure rewrites.
//
// A "structure" string like "/manufacturer/{A|-parts-catalog|}/{B}/" describes,
// segment by segment, how to rebuild a URL path: static text is emitted
// verbatim and {Name...} captures (current structure) or emits (new structure)
// a named param value, optionally applying a transform. This is the layer above
// the plain order-based rename rewriter (buildPatternTemplateRewriter) — it can
// modify the param VALUES themselves, not just move them between templates.
//
// Used by the pattern transform endpoint and mirrored verbatim in
// frontend/lib/transform-structure.ts for the client-side preview; keep the two
// in sync.

export type ParamTransform =
  | { kind: "none" }
  | { kind: "replace"; find: string; replace: string }
  | { kind: "upper" }
  | { kind: "lower" };

export type SegmentRule =
  | { type: "static"; value: string }
  | { type: "param"; name: string; transform: ParamTransform };

export type ParsedStructure = {
  segments: SegmentRule[];
  trailingSlash: boolean;
};

// Thrown for malformed structure syntax so callers can surface the message
// inline before allowing a preview/apply.
export class StructureSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructureSyntaxError";
  }
}

const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

// Parse the inner text of one "{...}" token (braces already stripped) into a
// param rule. Grammar:
//   {A}          → keep value as-is
//   {A|text|}    → strip: replace "text" with "" (or upper/lower directive)
//   {A|old|new|} → replace "old" with "new"
//   {A|upper|}   → uppercase
//   {A|lower|}   → lowercase
function parseParamToken(inner: string): SegmentRule {
  const parts = inner.split("|");
  const name = parts[0];

  if (!PARAM_NAME.test(name)) {
    throw new StructureSyntaxError(
      `invalid param name "${name}" — name segments like {A}, {B}, {C}`
    );
  }

  // {A}
  if (parts.length === 1) {
    return { type: "param", name, transform: { kind: "none" } };
  }

  // {A|X|} — upper/lower directive, or strip X (replace X with "").
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

  // {A|old|new|} — replace old with new.
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

  throw new StructureSyntaxError(
    `{${inner}} is not a valid transform — use {A}, {A|text|}, {A|old|new|}, {A|upper|} or {A|lower|}`
  );
}

// Parse a full structure string into ordered segment rules plus whether the
// structure ends with a trailing slash (captured separately since split("/")
// drops the empty trailing segment).
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
      // Replace every occurrence (split/join avoids regex-escaping the needle).
      return value.split(transform.find).join(transform.replace);
  }
}

// The ordered param names referenced by a structure (e.g. ["A", "B"]).
export function structureParamNames(parsed: ParsedStructure): string[] {
  return parsed.segments
    .filter(
      (rule): rule is Extract<SegmentRule, { type: "param" }> =>
        rule.type === "param"
    )
    .map((rule) => rule.name);
}

// Validate a current/new structure pair against the pattern's {param} count.
// Returns an error message, or null when the pair is valid. (Syntax errors are
// raised earlier by parseStructure.)
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

// Transform one absolute URL from the `current` layout to the `next` layout.
// Returns the rewritten URL, or null when the URL does not match `current`
// (segment count or a static segment differs) so callers leave it byte-for-byte.
// Host, scheme, query string and hash are preserved; only the path changes.
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

  // Capture each named param's concrete value; bail if a static segment differs.
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
