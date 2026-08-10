// Client-side mirror of backend/src/sitemaps/transformStructure.ts — used to
// render the Preview step of the Update Pattern modal by applying the same
// transform to a handful of real sampled URLs before anything is sent to the
// backend. KEEP IN SYNC with the backend module (same parsing + semantics), so
// the preview matches exactly what the server will write.

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

  throw new StructureSyntaxError(
    `{${inner}} is not a valid transform — use {A}, {A|text|}, {A|old|new|}, {A|upper|} or {A|lower|}`
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
