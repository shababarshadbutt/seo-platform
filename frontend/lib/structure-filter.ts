// Client-side mirror of the structure-filter matcher in
// backend/src/sitemaps/structureClusters.ts — used by the Update Pattern
// modal to show which of the pattern's real URLs a chosen combination of
// sub-structures actually covers, before anything is sent to the backend.
// KEEP IN SYNC with the backend module (same token-boundary semantics), so the
// preview and the count match exactly what the server will rewrite.
//
// Same arrangement, and the same reason, as lib/transform-structure.ts.

export type StructureFilter = {
  // 0-based ordinal among the template's {param} slots.
  param_index: number;
  anchor: "prefix" | "suffix";
  value: string;
};

export type ResolvedStructureFilter = {
  segmentIndex: number;
  anchor: "prefix" | "suffix";
  value: string;
};

function tokenize(value: string): string[] {
  return value.split(/[-_.]+/).filter(Boolean);
}

function templateSegments(template: string): string[] {
  const trimmed = template.trim();
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  return path === "" ? [] : path.split("/").filter(Boolean);
}

function isParamSlot(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

// Token-boundary anchor test: "niin-parts" matches "niin-parts-24" as a prefix
// but NOT "niin-partsx-24" — raw startsWith would take the latter.
export function segmentMatchesAnchor(
  segment: string,
  anchor: "prefix" | "suffix",
  anchorValue: string
): boolean {
  const segmentTokens = tokenize(segment);
  const anchorTokens = tokenize(anchorValue);

  if (anchorTokens.length === 0 || segmentTokens.length < anchorTokens.length) {
    return false;
  }

  const offset =
    anchor === "prefix" ? 0 : segmentTokens.length - anchorTokens.length;

  return anchorTokens.every(
    (token, index) => segmentTokens[offset + index] === token
  );
}

export function structureFilterSegmentIndex(
  template: string,
  paramIndex: number
): number | null {
  const segments = templateSegments(template);
  let seen = 0;

  for (let index = 0; index < segments.length; index += 1) {
    if (!isParamSlot(segments[index])) {
      continue;
    }

    if (seen === paramIndex) {
      return index;
    }

    seen += 1;
  }

  return null;
}

// Resolve a whole list against a template. Returns null if ANY filter fails to
// resolve — mirrors the backend's all-or-nothing rule, so the modal can never
// preview a scope narrower than the one the server would refuse.
export function resolveStructureFilters(
  filters: StructureFilter[],
  template: string
): ResolvedStructureFilter[] | null {
  const resolved: ResolvedStructureFilter[] = [];

  for (const filter of filters) {
    const segmentIndex = structureFilterSegmentIndex(
      template,
      filter.param_index
    );

    if (segmentIndex === null) {
      return null;
    }

    resolved.push({
      segmentIndex,
      anchor: filter.anchor,
      value: filter.value
    });
  }

  return resolved;
}

// Does this URL fall inside EVERY scoped structure? An empty list means
// unscoped and matches everything.
export function urlMatchesStructureFilters(
  rawUrl: string,
  filters: ResolvedStructureFilter[]
): boolean {
  if (filters.length === 0) {
    return true;
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const segments = url.pathname.split("/").filter(Boolean);

  return filters.every((filter) => {
    const segment = segments[filter.segmentIndex];

    if (segment === undefined) {
      return false;
    }

    return segmentMatchesAnchor(segment, filter.anchor, filter.value);
  });
}
