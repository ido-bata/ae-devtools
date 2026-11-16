/**
 * Stable capability ID grammar — frozen by Issue #11 (CAP013).
 *
 * Shape: `ae.<namespace>.<segment>.<segment>+`
 *   ae.scripting.<class>.<member>   public scripting symbols (#9)
 *   ae.sdk.<header>.<symbol>        SDK symbols, supplied at build time only (#10)
 *   ae.operation.<semantic>         normalized semantic operation (#8)
 *   ae.tool.<project>.<operation>   one source-verified wrapper operation (#8)
 *
 * Segments are `[A-Za-z0-9_$-]+`. Source symbol spelling is preserved on the
 * record (`source.symbol`); IDs are normalized identities, never invented
 * remote method names.
 */

export const ID_NAMESPACES = ["scripting", "sdk", "operation", "tool"] as const;
export type IdNamespace = (typeof ID_NAMESPACES)[number];

const SEGMENT_RE = /^[A-Za-z0-9_$-]+$/;
/** Semantic IDs from the #8 inventory: lowercase dotted paths, ≥ 2 parts. */
const SEMANTIC_ID_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export type ParsedCapabilityId = {
  namespace: IdNamespace;
  segments: string[];
};

export function parseCapabilityId(id: string): ParsedCapabilityId | null {
  const parts = id.split(".");
  if (parts.length < 4 || parts[0] !== "ae") return null;
  const ns = parts[1];
  if (ns === undefined || !(ID_NAMESPACES as readonly string[]).includes(ns)) return null;
  const segments = parts.slice(2);
  if (segments.length < 2) return null;
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) return null;
  }
  return { namespace: ns as IdNamespace, segments };
}

function requireSegment(value: string, what: string): string {
  if (!SEGMENT_RE.test(value)) {
    throw new Error(`capability id ${what} is not representable: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Canonical ID for a #9 scripting symbol; input IDs carry a `provisional.` prefix. */
export function scriptingId(owner: string, member: string): string {
  return `ae.scripting.${requireSegment(owner, "owner")}.${requireSegment(member, "member")}`;
}

/** Normalized semantic operation ID from the #8 inventory (`app.version-info`). */
export function semanticOperationId(semanticId: string): string {
  if (!SEMANTIC_ID_RE.test(semanticId)) {
    throw new Error(`invalid semantic operation id: ${JSON.stringify(semanticId)}`);
  }
  return `ae.operation.${semanticId}`;
}

/**
 * Lowercased slug for identity-bearing segments that may contain repo path
 * punctuation (`ido-bata/ae-a8n`, `app.info`). Throws when nothing survives,
 * so an unmappable value fails instead of collapsing into a neighbor.
 */
export function slugSegment(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_$-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!SEGMENT_RE.test(slug)) {
    throw new Error(`cannot slug value into a capability id segment: ${JSON.stringify(value)}`);
  }
  return slug;
}

/** One source-verified wrapper operation (`#8` operations.json row). */
export function toolOperationId(toolId: string, operation: string): string {
  return `ae.tool.${slugSegment(toolId)}.${slugSegment(operation)}`;
}

/**
 * SDK symbol ID from locally supplied rows only. The header path is slugged;
 * the symbol keeps its C spelling. Never call this to produce committed rows —
 * capability-catalog §1.1 forbids publishing SDK symbol lists.
 */
export function sdkSymbolId(headerPath: string, symbol: string): string {
  const header = headerPath.replace(/\.h(?:pp)?$/i, "");
  return `ae.sdk.${slugSegment(header)}.${requireSegment(symbol, "sdk symbol")}`;
}
