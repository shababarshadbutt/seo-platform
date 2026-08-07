import type { LocUrlRewriter } from "./rewriteLocs.js";

// Distinct URL structures INSIDE one pattern (v1.49).
//
// The extractor's positional cardinality heuristic collapses genuinely
// different URL families into one template: /nsn/niin-parts-24/,
// /nsn/part-types-825/ and /nsn/nsn-parts-620/ all become /nsn/{param}. On the
// real nsnstocks.com those families redirect to DIFFERENT new layouts
// (niin-parts-24 → /nsn/niin-parts/page-2-4/), so a pattern-wide edit is
// genuinely wrong — each family needs its own scoped rename/transform.
//
// Detection: for a {param} position, tokenize every observed segment value on
// [-_.] and find the maximal LITERAL token run anchored at the LEFT (prefix)
// or RIGHT (suffix). A token level is literal when its distinct-value count is
// low relative to how many values reach that depth — the inverse of the
// extractor's shouldParameterize test. Once token values turn high-cardinality
// that's the variable remainder, and each literal anchor is one structure.
//
// BIDIRECTIONAL anchoring is load-bearing, verified on real data:
//   * nsnstocks /nsn/{param} values are prefix-anchored → 4 structures
//     (niin-parts-{var}, part-types-{var}, nsn-parts-{var}, cage-codes-{var});
//   * acquireelectrical /manufacturer/{param} values are SUFFIX-anchored →
//     exactly one structure ({var}-parts-catalog) — prefix-only clustering
//     would shatter it into 500 singletons;
//   * /rfq/{param}/{param} (both positions free-form) must NOT split at all.

const PARAM_SEGMENT = "{param}";

// A structure needs at least this many URLs, else it folds into the residual
// bucket — a single stray value is noise, not a structure.
const MIN_CLUSTER_SUPPORT = 2;

// A token level is literal when it has at most this many distinct values...
const LITERAL_MAX_DISTINCT = 20;

// ...AND distinct/covered stays at or below this ratio. Both are the inverse
// of extractPatternsJob's parameterize thresholds, tuned on the validation
// data sets above.
const LITERAL_MAX_RATIO = 0.5;

// Token runs longer than this stop extending the anchor — an anchor that long
// is a sign the values are near-identical, not a family boundary.
const MAX_ANCHOR_TOKENS = 8;

export type StructureAnchor = {
  direction: "prefix" | "suffix";
  // Hyphen-joined literal tokens, e.g. "niin-parts" or "parts-catalog".
  value: string;
};

export type StructureCluster = {
  // Display label: "niin-parts-{var}", "{var}-parts-catalog", or "{param}" /
  // "{param} (other)" for the residual bucket.
  label: string;
  // null for the residual bucket (no literal anchor to scope an edit by).
  anchor: StructureAnchor | null;
  urlCount: number;
  examples: string[];
};

export type PatternStructurePosition = {
  // 0-based path-segment index of the {param} slot these clusters describe.
  segmentIndex: number;
  // 0-based ordinal among the template's {param} slots (stable across renames
  // that move the slot to a different path position).
  paramIndex: number;
  clusters: StructureCluster[];
};

function tokenize(value: string): string[] {
  return value.split(/[-_.]+/).filter(Boolean);
}

// Literal-vs-variable decision for one token depth across the value set.
function levelIsLiteral(
  tokenArrays: string[][],
  depth: number,
  fromRight: boolean
): boolean {
  const seen = new Set<string>();
  let covered = 0;

  for (const tokens of tokenArrays) {
    if (tokens.length <= depth) {
      continue;
    }

    covered += 1;
    seen.add(fromRight ? tokens[tokens.length - 1 - depth] : tokens[depth]);
  }

  if (covered === 0) {
    return false;
  }

  return (
    seen.size <= LITERAL_MAX_DISTINCT &&
    seen.size / covered <= LITERAL_MAX_RATIO
  );
}

function groupsAtDepth(
  values: string[],
  arrays: string[][],
  depth: number,
  fromRight: boolean
): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  values.forEach((value, index) => {
    const tokens = arrays[index];
    const take = Math.min(depth, tokens.length);
    const anchor = fromRight
      ? tokens.slice(tokens.length - take).join("-")
      : tokens.slice(0, take).join("-");
    const group = groups.get(anchor);

    if (group) {
      group.push(value);
    } else {
      groups.set(anchor, [value]);
    }
  });

  return groups;
}

// Group values by a literal anchor in one direction; null when the very first
// token level is already variable (no anchor exists).
//
// The anchor depth is CHOSEN BY SCORE, not greedily maxed: on a small sample a
// variable tail can scrape under the literal thresholds (10 distinct page
// numbers over 20 URLs is exactly ratio 0.5), and a greedily-extended anchor
// then swallows the tail and shatters every family into singletons. Scoring
// each candidate depth and keeping the best split recovers the real boundary;
// ties prefer the DEEPER (more specific) anchor so "niin-parts" beats "niin".
function clusterOneDirection(
  values: string[],
  fromRight: boolean
): Map<string, string[]> | null {
  const arrays = values.map(tokenize);
  let maxDepth = 0;

  while (
    maxDepth < MAX_ANCHOR_TOKENS &&
    levelIsLiteral(arrays, maxDepth, fromRight)
  ) {
    maxDepth += 1;
  }

  if (maxDepth === 0) {
    return null;
  }

  let best: Map<string, string[]> | null = null;
  let bestScore = -1;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const groups = groupsAtDepth(values, arrays, depth, fromRight);
    const score = splitScore(groups);

    if (score >= bestScore) {
      best = groups;
      bestScore = score;
    }
  }

  return bestScore >= 0 ? best : null;
}

// Quality of a candidate split: the MEAN size of its supported groups, or -1
// when nothing meets support. Mean group size — not group count — is what
// separates a real family split from a degenerate one: grouping packed slugs
// by their shared page-number SUFFIX ("{var}-24" holding niin-parts-24 +
// cage-codes-24, two URLs each) yields many tiny groups, while the true
// section-prefix split yields few large ones. Bigger mean = the anchor that
// actually explains the data.
function splitScore(groups: Map<string, string[]> | null): number {
  if (!groups) {
    return -1;
  }

  let supportedGroups = 0;
  let supportedValues = 0;

  for (const values of groups.values()) {
    if (values.length >= MIN_CLUSTER_SUPPORT) {
      supportedGroups += 1;
      supportedValues += values.length;
    }
  }

  return supportedGroups >= 1 ? supportedValues / supportedGroups : -1;
}

// Cluster the observed values of ONE {param} slot into structures.
export function clusterParamValues(values: string[]): StructureCluster[] {
  if (values.length === 0) {
    return [];
  }

  const left = clusterOneDirection(values, false);
  const right = clusterOneDirection(values, true);
  const leftScore = splitScore(left);
  const rightScore = splitScore(right);
  const direction: "prefix" | "suffix" =
    leftScore >= rightScore ? "prefix" : "suffix";
  const chosen = direction === "prefix" ? left : right;

  if (!chosen || splitScore(chosen) < 0) {
    // No literal anchor at either end — the whole slot is one free-form
    // structure (e.g. /rfq/{param}'s manufacturer slugs).
    return [
      {
        label: PARAM_SEGMENT,
        anchor: null,
        urlCount: values.length,
        examples: values.slice(0, 3)
      }
    ];
  }

  const clusters: StructureCluster[] = [];
  const residual: string[] = [];

  for (const [anchorValue, groupValues] of chosen) {
    if (groupValues.length < MIN_CLUSTER_SUPPORT) {
      residual.push(...groupValues);
      continue;
    }

    // A group whose every value IS the anchor (no variable remainder) is a
    // fully-literal value, labelled as itself.
    const fullyLiteral = groupValues.every(
      (value) => tokenize(value).join("-") === anchorValue
    );
    const label = fullyLiteral
      ? anchorValue
      : direction === "prefix"
        ? `${anchorValue}-{var}`
        : `{var}-${anchorValue}`;

    clusters.push({
      label,
      anchor: { direction, value: anchorValue },
      urlCount: groupValues.length,
      examples: groupValues.slice(0, 3)
    });
  }

  clusters.sort((a, b) => b.urlCount - a.urlCount);

  if (residual.length > 0) {
    clusters.push({
      label: `${PARAM_SEGMENT} (other)`,
      anchor: null,
      urlCount: residual.length,
      examples: residual.slice(0, 3)
    });
  }

  return clusters;
}

function templateSegments(template: string): string[] {
  const trimmed = template.trim();
  const path = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  return path === "" ? [] : path.split("/").filter(Boolean);
}

// Detect structures for every {param} slot of a pattern from its observed URL
// paths (the pattern_urls candidate pool — real URLs, not synthetic samples).
export function detectPatternStructures(
  template: string,
  paths: string[]
): PatternStructurePosition[] {
  const segments = templateSegments(template);
  const positions: PatternStructurePosition[] = [];
  let paramIndex = 0;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    if (segments[segmentIndex] !== PARAM_SEGMENT) {
      continue;
    }

    const values: string[] = [];

    for (const path of paths) {
      const pathSegments = path.split("/").filter(Boolean);

      if (pathSegments.length === segments.length && pathSegments[segmentIndex]) {
        values.push(pathSegments[segmentIndex]);
      }
    }

    positions.push({
      segmentIndex,
      paramIndex,
      clusters: clusterParamValues(values)
    });
    paramIndex += 1;
  }

  return positions;
}

// ---- Scoping a rename/transform to one structure ---------------------------

// The filter a scoped edit carries: constrain ONE {param} slot (addressed by
// its ordinal among the template's params, which survives the slot moving to a
// different path position across a rename) to values carrying the literal
// anchor. Persisted in pattern_structure_jobs.params and pattern_renames.
export type StructureFilter = {
  // 0-based ordinal among the from-template's {param} slots.
  param_index: number;
  anchor: "prefix" | "suffix";
  value: string;
};

export function isValidStructureFilter(
  value: unknown
): value is StructureFilter {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const filter = value as Record<string, unknown>;

  return (
    typeof filter.param_index === "number" &&
    Number.isInteger(filter.param_index) &&
    filter.param_index >= 0 &&
    (filter.anchor === "prefix" || filter.anchor === "suffix") &&
    typeof filter.value === "string" &&
    filter.value.trim().length > 0
  );
}

// A parameter slot in either grammar: a pattern template's "{param}" or a
// transform structure's named segment ("{A}", "{A|find|new|}", "{A|upper|}").
function isParamSlot(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

// Resolve which path-segment index the filter's param ordinal points at in
// `template` — which may be a pattern template ({param} slots) or a transform
// structure string (named {A…} slots). null when there are too few slots.
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

// The fully-resolved form that crosses the piscina thread edge: the segment
// index is precomputed against the op's from-template so the worker never
// needs template parsing to apply the guard.
export type ResolvedStructureFilter = {
  segmentIndex: number;
  anchor: "prefix" | "suffix";
  value: string;
};

export function resolveStructureFilter(
  filter: StructureFilter,
  fromTemplate: string
): ResolvedStructureFilter | null {
  const segmentIndex = structureFilterSegmentIndex(
    fromTemplate,
    filter.param_index
  );

  if (segmentIndex === null) {
    return null;
  }

  return { segmentIndex, anchor: filter.anchor, value: filter.value };
}

// Does this URL fall inside the scoped structure? Parse failures return false
// (the wrapped rewriter would return null for them anyway).
export function urlMatchesStructureFilter(
  rawUrl: string,
  filter: ResolvedStructureFilter
): boolean {
  return urlMatchesStructureFilters(rawUrl, [filter]);
}

// Does this URL fall inside EVERY scoped structure? (v1.51)
//
// A pattern with several {param} slots has independently detected structures at
// each one — /rfq/{param}/{param}/{param} can be scoped to niin-parts-{var} at
// segment A AND {var}-catalog at segment C — so the guard takes a LIST and ANDs
// it. One filter is just the one-element case; an EMPTY list means unscoped and
// matches everything, which keeps "no scope" and "scope to nothing" from being
// the same value.
//
// The URL is parsed ONCE for the whole list rather than per filter. At three
// filters over a multi-million-loc pattern that is millions of avoided URL
// constructions, and this runs inside the per-loc hot path of every rewrite.
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

// AND the structure guard into an existing rewriter: URLs outside the scoped
// structure pass through byte-for-byte (null), exactly like template
// non-matches do today.
//
// Accepts a single filter or a list so every existing call site keeps working
// while multi-position scoping is added around it.
export function applyStructureFilterToRewriter(
  rewriter: LocUrlRewriter,
  filter: ResolvedStructureFilter | ResolvedStructureFilter[] | null
): LocUrlRewriter {
  const filters = filter === null ? [] : Array.isArray(filter) ? filter : [filter];

  if (filters.length === 0) {
    return rewriter;
  }

  return (url: string) =>
    urlMatchesStructureFilters(url, filters) ? rewriter(url) : null;
}

// Resolve a whole list against a template. Returns null if ANY filter fails to
// resolve — a partially-applied scope would silently widen the edit to include
// the position that dropped out, which is the one failure mode a scoped edit
// must never have.
export function resolveStructureFilters(
  filters: StructureFilter[],
  fromTemplate: string
): ResolvedStructureFilter[] | null {
  const resolved: ResolvedStructureFilter[] = [];

  for (const filter of filters) {
    const one = resolveStructureFilter(filter, fromTemplate);

    if (!one) {
      return null;
    }

    resolved.push(one);
  }

  return resolved;
}

// Upper bound on filters in one request. A pattern has one filter per {param}
// slot at most; this is a guard against a hand-crafted body, not a real limit.
export const MAX_STRUCTURE_FILTERS = 16;

// Read the persisted / request form into a list.
//
// BACK-COMPATIBLE BY NECESSITY, not by preference: pattern_renames rows written
// before v1.51 hold a single filter OBJECT in structure_filter, and undo
// replays a rename by reading that column back. If this only understood arrays,
// every scoped rename performed before this release would silently undo as an
// UNSCOPED rename and rewrite URLs it never touched. So a bare object is
// accepted and read as a one-element list, forever.
//
// null / undefined / [] all mean unscoped.
export function parseStructureFilters(raw: unknown): StructureFilter[] | null {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (Array.isArray(raw)) {
    if (raw.length > MAX_STRUCTURE_FILTERS) {
      return null;
    }

    const filters: StructureFilter[] = [];

    for (const entry of raw) {
      if (!isValidStructureFilter(entry)) {
        return null;
      }

      filters.push(entry);
    }

    return filters;
  }

  return isValidStructureFilter(raw) ? [raw] : null;
}
