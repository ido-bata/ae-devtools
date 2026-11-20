/**
 * Symbol extraction from the community scripting guide (CAP005).
 *
 * Extraction is append-only and conservative. A member is only emitted when the
 * document itself makes its name, its owning class and its kind unambiguous
 * from a heading. Anything ambiguous is emitted with `status: "unresolved"` and
 * a machine-readable reason instead of being guessed, per the issue's instruction
 * that a guessed API shape is worse than an incomplete inventory.
 */

import { extractHeadings, slugify, sectionTrail } from "./markdown.ts";
import type { MdHeading } from "./markdown.ts";

export type MemberKind =
  | "attribute"
  | "method"
  | "enum"
  | "enum-value"
  | "global-function"
  | "constructor";

export type SymbolStatus =
  /** Heading Plus structured Type/Parameters block present. */
  | "documented"
  /** Community doc says Adobe does not document it. */
  | "undocumented-community-research"
  /** Heading exists but the entry could not be classified without guessing. */
  | "unresolved";

export type SymbolRecord = {
  /** Provisional id. The final grammar belongs to issue #11. */
  id: string;
  kind: MemberKind;
  /** Owning class, or "global" for globally available functions. */
  owner: string;
  member: string;
  /** Heading level section the entry was found under (Attributes/Methods/...). */
  section: string;
  sectionPath: string[];
  sourceKey: string;
  sourceTier: "community-reference";
  publisher: string;
  authority: "community-maintained";
  url: string;
  anchor: string;
  /** AE version range as stated by the source, or null when unstated. */
  versionAdded: string | null;
  versionRemoved: string | null;
  versionRangeStated: boolean;
  /** Whether the entry states read-only / read-write access. */
  access: "read" | "write" | "read-write" | null;
  /** Arguments as written in the entry's usage line, e.g. ["file"] or null. */
  signature: string[] | null;
  /**
   * Cross-reference target when the entry's Example section defers to
   * another member's example ("See the example in `Owner.member()`"),
   * recorded as "Owner.member". build.ts resolves it against the
   * referenced symbol's extracted signature when this entry's own
   * signature is the unresolved `()` stub.
   */
  signatureExampleRef?: string;
  /**
   * Documented parameter types from the entry's `#### Parameters` table,
   * in document order: { name, type } where `type` is a normalized token
   * ("string" | "number" | "boolean" | "array" | "enum:Name") or null
   * when the source does not state a checkable type. `null` when the
   * entry has no parameter table. Positional alignment with `signature`
   * is only meaningful when both lists have the same length — callers
   * must check that before using it (alternative signatures and
   * bracket-grouped params break alignment).
   */
  signatureParams: { name: string; type: string | null }[] | null;
  /** True when the doc marks the entry as undocumented by Adobe. */
  markedUndocumented: boolean;
  status: SymbolStatus;
  /** True when the entry carries an explicit version caveat from the doc. */
  hasVersionNote: boolean;
  notes: string[];
};

export type ClassRecord = {
  id: string;
  name: string;
  /** H1 title as written, which may differ from `name` (e.g. "Font object"). */
  pageTitle: string;
  /** Base class name as stated by the source, or null. */
  baseClass: string | null;
  /** Full chain of stated base classes, nearest first. Empty when unstated. */
  baseClasses: string[];
  /** Class is only a base class per the class-hierarchy page. */
  baseOnly: boolean;
  /** `instanceof` caveat symbol from the class hierarchy legend. */
  instanceofCaveat: "always-false" | "throws-undefined" | null;
  /** How the class name was resolved from the page. */
  ownerResolution: "page-title" | "member-prefix" | "globals-page";
  sourceKey: string;
  url: string;
  anchor: string;
  /** Number of members extracted for this class. */
  memberCount: number;
};

export type DocFile = {
  /** Path inside the fetched archive, e.g. `docs/layer/layer.md`. */
  path: string;
  /** Path used in the public site URL, e.g. `layer/layer`. */
  sitePath: string;
  text: string;
};

const SECTION_TO_KIND: Record<string, MemberKind> = {
  Attributes: "attribute",
  Methods: "method",
  "Team Projects": "method",
  "Global functions": "global-function",
};

// A few headings carry a trailing colon (e.g. `### LightLayer.lightSource:`), so
// trailing punctuation is tolerated rather than silently dropping the member.
const HEADING_TAIL = "[:\\s]*$";
const MEMBER_HEADING = new RegExp(
  `^([A-Za-z_][A-Za-z0-9_]*)\\.([A-Za-z_][A-Za-z0-9_]*)(\\(\\))?${HEADING_TAIL}`,
);
const GLOBAL_HEADING = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)\\(\\)${HEADING_TAIL}`);
const CLASS_HEADING = new RegExp(`^([A-Za-z_][A-Za-z0-9_]*) object${HEADING_TAIL}`);

/** Normalise "After Effects 26.5." / "After Effects 13.6 (CC 2015)" to `26.5`. */
function normaliseVersion(raw: string): string | null {
  const m = /After Effects\s+(\d+(?:\.\d+)*)/.exec(raw);
  return m?.[1] ?? null;
}

function detectAccess(block: string): SymbolRecord["access"] {
  const lower = block.toLowerCase();
  const readOnly = /read[- ]only/.test(lower);
  const readWrite = /read[-/ ]?write|read\/write/.test(lower);
  if (readOnly && readWrite) return "read-write";
  if (readWrite) return "read-write";
  if (readOnly) return "read";
  return null;
}

/**
 * Read the chunk of a document that belongs to one heading: every line until the
 * next heading at the same or a higher level. Deeper headings (`#### Description`,
 * `#### Type`, ...) belong to the entry and must stay inside the block, otherwise
 * a member's type/access note would be invisible to classification.
 */
function blockFor(
  lines: readonly string[],
  headings: readonly MdHeading[],
  index: number,
): { block: string; startLine: number; endLine: number } {
  const h = headings[index];
  if (!h) return { block: "", startLine: 0, endLine: 0 };
  let endLine = lines.length;
  for (let i = index + 1; i < headings.length; i += 1) {
    const next = headings[i];
    if (!next) continue;
    if (next.level <= h.level) {
      endLine = next.line - 1;
      break;
    }
  }
  // `h.line` is 1-based; the slice is 0-based.
  const block = lines.slice(h.line - 1, endLine).join("\n");
  return { block, startLine: h.line, endLine };
}

/**
 * Recover the declared parameter list from a member's usage line(s).
 *
 * Usage lines are full call chains — `` `app.project.item(index).layer(index)
 * .propertyGroupSpec.property(index)` `` — so the member's own argument
 * list is the argument list of the `memberName(...)` call inside the
 * expression, not of the whole line. Every usage line in the block is
 * scanned and every occurrence of the member call contributes an
 * alternative argument list.
 *
 * Returns `{ signature, alternatives }`:
 *   - `signature` is null when no usage line calls the member.
 *   - `alternatives` is the list of distinct raw argument texts found,
 *     in document order. When several alternatives exist they are merged
 *     position-wise with `|` (e.g. property(index) / property(name) ->
 *     "index|name") ONLY when they all have the same arity; differing
 *     arities cannot be represented in the flat signature shape and
 *     yield signature=null with a note-worthy alternatives count.
 */
function signaturesFromUsage(
  block: string,
  member: string,
): { signature: string[] | null; alternatives: number; fromExamples: boolean; conflict: boolean } {
  const callRe = new RegExp(`(?<![\\w$])${member.replace(/[$]/g, "\\$")}\\s*\\(`, "g");
  const collect = (expr: string, out: Set<string>) => {
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(expr)) !== null) {
      const open = expr.indexOf("(", m.index + m[0].length - 1);
      const args = balancedArgs(expr, open);
      if (args !== null) out.add(args);
    }
  };
  const usageArgs = new Set<string>();
  const exampleArgs = new Set<string>();
  let inFence = false;
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) {
      // Example code: any line may contain a member call.
      collect(line, exampleArgs);
      continue;
    }
    // Usage lines are a single backtick-quoted expression on their own
    // line; inline code mentions inside prose are not usage signatures.
    const um = /^`([^`]+)`\s*$/.exec(trimmed);
    if (!um?.[1]) continue;
    collect(um[1], usageArgs);
  }
  // Evidence precedence:
  //   - usage lines with real arguments are authoritative; examples are
  //     ignored (they may demonstrate optional-argument variants).
  //   - a `member()` usage stub CONTRADICTED by the entry's own example
  //     calls is ambiguous — the stub may be a template placeholder
  //     (the CC2014 getSettings/setSetting/setSettings family) or the
  //     example may show an optional-argument variant. Either way the
  //     arity is not decidable from the entry alone → signature null.
  //   - with no usage-line call at all, example calls are the only
  //     documented evidence and are used.
  const usageHasArgs = [...usageArgs].some((t) => t.trim() !== "");
  const exampleHasArgs = [...exampleArgs].some((t) => t.trim() !== "");
  const hasUsageCall = usageArgs.size > 0;
  let argTexts: Set<string>;
  let fromExamples = false;
  if (usageHasArgs || !exampleHasArgs) {
    argTexts = usageArgs;
  } else if (hasUsageCall) {
    // `()` stub vs example calls with arguments: conflicting evidence.
    return {
      signature: null,
      alternatives: usageArgs.size + exampleArgs.size,
      fromExamples: false,
      conflict: true,
    };
  } else {
    argTexts = exampleArgs;
    fromExamples = true;
  }
  if (argTexts.size === 0) return { signature: null, alternatives: 0, fromExamples, conflict: false };
  const alts = [...argTexts];
  const splitAlt = (t: string) =>
    t.trim() === "" ? [] : t.split(",").map((s) => s.trim());
  const parts = alts.map(splitAlt);
  const arity = parts[0]?.length ?? 0;
  const sameArity = parts.every((p) => p.length === arity);
  if (!sameArity) return { signature: null, alternatives: alts.length, fromExamples, conflict: false };
  // Position-wise merge: alternatives at the same position join with "|".
  const merged: string[] = [];
  for (let i = 0; i < arity; i++) {
    const names = [...new Set(parts.map((p) => p[i] ?? ""))];
    merged.push(names.join("|"));
  }
  return { signature: merged, alternatives: alts.length, fromExamples, conflict: false };
}

/** Extract the balanced-paren argument text starting at `open` (index of `(`). */
function balancedArgs(expr: string, open: number): string | null {
  if (open < 0 || expr[open] !== "(") return null;
  let depth = 1, j = open + 1, quote: string | null = null, esc = false;
  while (j < expr.length && depth > 0) {
    const c = expr[j];
    if (quote !== null) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    j++;
  }
  if (depth !== 0) return null;
  return expr.slice(open + 1, j - 1);
}

/**
 * Parse the `#### Parameters` table of a member block. Handles both
 * markdown pipe tables (`| `p` | Type | Desc |`) and the ASCII grid
 * tables (`| `p` | Type | ... |` between `+===+`/`+---+` borders);
 * continuation rows with an empty parameter cell are ignored.
 * Returns null when the section is absent or says "None.".
 */
function parametersFromBlock(block: string): { name: string; type: string | null }[] | null {
  const sec = /####\s+Parameters\s*\n([\s\S]*?)(?=\n####|\n---|$)/.exec(block);
  if (!sec?.[1]) return null;
  const body = sec[1];
  if (/^\s*None\.?\s*$/m.test(body)) return null;
  const params: { name: string; type: string | null }[] = [];
  for (const line of body.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m?.[1]) continue;
    // Parameter cell may group alternatives/brackets: `[width, height]`.
    const name = m[1].trim();
    if (name === "") continue;
    params.push({ name, type: normalizeParamType(m[2] ?? "") });
  }
  return params.length > 0 ? params : null;
}

/**
 * Normalize a dfad Parameters-table Type cell to a checkable token.
 * Only unambiguous primitive/array/enum types are returned; polymorphic
 * cells ("Value", "Any", class names, "String or Integer") yield null —
 * the audit must not invent types the source does not state.
 */
function normalizeParamType(cell: string): string | null {
  const t = cell.trim();
  if (t === "") return null;
  const enumM = /`([A-Z][A-Za-z0-9_]*)`\s*enum\b/.exec(t) ??
    /\b([A-Z][A-Za-z0-9_]*)\s+enum\b/.exec(t);
  if (enumM?.[1]) return `enum:${enumM[1]}`;
  const lower = t.toLowerCase();
  if (/\barray\b/.test(lower)) return "array";
  const hits = new Set<string>();
  if (/\binteger\b|\bint\b/.test(lower)) hits.add("number");
  if (/floating|\bfloat\b|\bnumber\b|\bdouble\b/.test(lower)) hits.add("number");
  if (/\bstring\b/.test(lower)) hits.add("string");
  if (/\bboolean\b/.test(lower)) hits.add("boolean");
  if (hits.size !== 1) return null;
  return [...hits][0] ?? null;
}

/**
 * Parse the class-hierarchy page's per-class `instanceof` caveats (CAP007).
 *
 * The page marks some classes with ⚠ (instanceof is always false) and others with ❌
 * (the class name is undefined, so instanceof throws). Those markers are the only
 * documented statement about type-check behaviour for those classes, so they are
 * captured rather than left implicit.
 */
export function extractHierarchyCaveats(
  text: string,
): Map<string, "always-false" | "throws-undefined"> {
  const out = new Map<string, "always-false" | "throws-undefined">();
  for (const line of text.split("\n")) {
    const m = /^\s*-\s*\[([A-Za-z][A-Za-z0-9_]*) object\][^(]*\([^)]*\)\s*(⚠|❌)?\s*$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const mark = m[2];
    if (!name) continue;
    if (mark === "⚠") out.set(name, "always-false");
    else if (mark === "❌") out.set(name, "throws-undefined");
  }
  return out;
}

/**
 * Extract symbols from one markdown document.
 *
 * `urlFor` maps a document to the public site URL, keeping URL construction out
 * of the parser so the same parser can be unit-tested on synthetic input.
 */
export function extractFromDoc(
  doc: DocFile,
  opts: {
    sourceKey: string;
    publisher: string;
    urlFor: (sitePath: string) => string;
  },
): { symbols: SymbolRecord[]; classes: ClassRecord[] } {
  const lines = doc.text.split("\n");
  const headings = extractHeadings(doc.text);
  const symbols: SymbolRecord[] = [];
  const classes: ClassRecord[] = [];

  const title = headings.find((h) => h.level === 1)?.text ?? "";
  const classMatch = CLASS_HEADING.exec(title);
  const isGlobalsPage = /^Global functions$/i.test(title);

  /**
   * Page titles and member prefixes disagree on some pages: the page is titled
   * "Font object" while its members are headed `FontObject.ctScripts`. Rather than
   * rewriting either, resolve the page owner from the dominant member prefix and
   * keep the title separately. The dominant prefix is only adopted when it is
   * unambiguous (exactly one distinct prefix across the page's member headings).
   */
  const memberPrefixes = new Set<string>();
  for (const h of headings) {
    if (h.level !== 3) continue;
    const m = MEMBER_HEADING.exec(h.text);
    if (m?.[1]) memberPrefixes.add(m[1]);
  }
  const titleOwner = classMatch?.[1] ?? "";
  let owner = titleOwner;
  let ownerResolution: ClassRecord["ownerResolution"] = "page-title";
  if (memberPrefixes.size === 1) {
    const only = [...memberPrefixes][0] ?? "";
    if (only && only !== titleOwner) {
      owner = only;
      ownerResolution = "member-prefix";
    }
  }
  if (isGlobalsPage) {
    owner = "global";
    ownerResolution = "globals-page";
  }

  if (owner && owner !== "global") {
    const h1Index = headings.findIndex((h) => h.level === 1);
    const { block } = blockFor(lines, headings, h1Index);
    // The guide states inheritance in several phrasings, e.g.
    // "subclass of [A object], which is a subclass of [B]" or
    // "subclass of [AVLayer](avlayer.md), which is a subclass of [Layer](layer.md)".
    const bases: string[] = [];
    for (const m of block.matchAll(/subclass of \[([A-Za-z]+)(?: object)?\]/g)) {
      const name = m[1];
      if (name && !bases.includes(name)) bases.push(name);
    }
    classes.push({
      id: `provisional.ae.scripting.class.${owner}`,
      name: owner,
      pageTitle: title,
      baseClass: bases[0] ?? null,
      baseClasses: bases,
      baseOnly: /is the base class for|is a base class for/.test(block),
      instanceofCaveat: null,
      ownerResolution,
      sourceKey: opts.sourceKey,
      url: opts.urlFor(doc.sitePath),
      anchor: slugify(title),
      memberCount: 0,
    });
  }

  let section = "";
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    if (!h) continue;
    if (h.level === 2) {
      section = h.text;
      continue;
    }
    if (h.level !== 3) continue;

    const memberMatch = MEMBER_HEADING.exec(h.text);
    const globalMatch = isGlobalsPage ? GLOBAL_HEADING.exec(h.text) : null;
    if (!memberMatch && !globalMatch) continue;

    const declaredOwner = memberMatch?.[1] ?? "global";
    const member = memberMatch?.[2] ?? globalMatch?.[1] ?? "";
    // Globals are headed `writeLn()` — the parentheses live in GLOBAL_HEADING.
    const hasParens = Boolean(memberMatch?.[3]) || globalMatch !== null;

    // Guard: only accept entries whose declared owner is the page owner.
    if (declaredOwner !== owner) continue;

    const { block } = blockFor(lines, headings, i);
    const sectionKind = SECTION_TO_KIND[section];
    let kind: MemberKind | null = sectionKind ?? null;
    if (isGlobalsPage) kind = "global-function";

    const notes: string[] = [];
    let status: SymbolStatus = "documented";

    if (kind === null) {
      // A `Class.member()` heading outside Attributes/Methods is still a member
      // definition if it has a parameter list, but we do not assert its kind.
      if (hasParens) {
        kind = "method";
        notes.push("kind inferred from empty-argument heading syntax outside a known section");
        status = "unresolved";
      } else {
        continue;
      }
    } else if (sectionKind === "method" && !hasParens) {
      kind = "attribute";
      notes.push(`heading lacks "()" but appeared under "${section}"`);
      status = "unresolved";
    }

    const versionRaw =
      /added in After Effects\s+(\d+(?:\.\d+)*)/i.exec(block)?.[1] ?? null;
    const markedUndocumented = /officially undocumented/i.test(block);
    if (markedUndocumented) {
      status = "undocumented-community-research";
      notes.push("community guide states Adobe does not document this entry");
    }

    const anchor = slugify(h.text);
    const idOwner = declaredOwner === "global" ? "global" : declaredOwner;
    // Signature: usage-line argument lists are the authoritative arity
    // source (headings only carry `()`). Alternative usage signatures
    // with equal arity merge position-wise with `|`; differing arities
    // stay unrepresented rather than guessed.
    let signature: string[] | null = null;
    if (hasParens) {
      const usage = signaturesFromUsage(block, member);
      // `null` = no usage-line signature found (unknown arity — dfad
      // headings always write `()` regardless of parameters, so the
      // heading cannot confirm zero args). `[]` = a usage line literally
      // shows `member()` — documented zero-argument signature.
      signature = usage.signature;
      if (usage.conflict) {
        notes.push(
          "usage line shows `()` but the entry's examples call the member with arguments; arity unresolved",
        );
      } else if (usage.fromExamples) {
        notes.push(
          "no documented usage-line call; signature taken from the entry's example calls",
        );
      }
      if (usage.alternatives > 1) {
        notes.push(
          usage.signature
            ? `signature merged from ${usage.alternatives} alternative usage signatures`
            : `${usage.alternatives} alternative usage signatures with differing arity; not represented`,
        );
      }
    }
    // dfad stub entries ("See the example in `Owner.member()`") carry no
    // argument evidence of their own; record the target so build.ts can
    // inherit the referenced member's extracted signature.
    let signatureExampleRef: string | undefined;
    if (hasParens && signature !== null && signature.length === 0) {
      const ref = /example in [`\[]?([A-Za-z_]\w*)\.([A-Za-z_]\w*)\(\)/.exec(block);
      if (ref) signatureExampleRef = `${ref[1]}.${ref[2]}`;
    }
    symbols.push({
      id: `provisional.ae.scripting.${idOwner}.${member}`,
      kind,
      owner: idOwner,
      member,
      section,
      sectionPath: sectionTrail(headings, i),
      sourceKey: opts.sourceKey,
      sourceTier: "community-reference",
      publisher: opts.publisher,
      authority: "community-maintained",
      url: opts.urlFor(doc.sitePath),
      anchor,
      versionAdded: versionRaw,
      versionRemoved: null,
      versionRangeStated: versionRaw !== null,
      access: kind === "attribute" ? detectAccess(block) : null,
      signature,
      ...(signatureExampleRef ? { signatureExampleRef } : {}),
      signatureParams: parametersFromBlock(block),
      markedUndocumented,
      status,
      hasVersionNote: versionRaw !== null,
      notes,
    });
  }

  const counts = new Map<string, number>();
  for (const s of symbols) counts.set(s.owner, (counts.get(s.owner) ?? 0) + 1);
  for (const c of classes) c.memberCount = counts.get(c.name) ?? 0;

  return { symbols, classes };
}
