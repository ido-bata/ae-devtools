/**
 * Enum extraction (CAP005).
 *
 * The community guide does not have a single canonical enum layout. Enum constants
 * appear in four shapes, all of which are handled here:
 *
 *   1. A dedicated `## EnumName` section whose table rows are `EnumName.VALUE`
 *      (e.g. GuideOrientationType).
 *   2. A `#### XxxType Enum` subsection with an unqualified bullet list.
 *   3. Inline mention of an enum type (`A \`FooType\` enumerated value; ... One of:`)
 *      followed by a bullet list of `FooType.VALUE` qualified entries.
 *   4. Table cells that mention `EnumName.VALUE` while describing another entry.
 *
 * Shapes 1-3 attribute values to an enum. Shape 4 only contributes a mention, and
 * is recorded as `mention-only` because the surrounding table does not define the
 * value set. Distinguishing the two keeps the enum-value count honest.
 */

import { extractHeadings, slugify } from "./markdown.ts";
import type { MdHeading } from "./markdown.ts";
import type { DocFile } from "./extract-symbols.ts";

export type EnumDefinitionKind =
  | "dedicated-section"
  | "typed-bullet-list"
  | "enum-subsection"
  /** Constants are qualified in a table/bullet list under a member entry. */
  | "inline-qualified-values";

export type EnumRecord = {
  id: string;
  name: string;
  sourceKey: string;
  url: string;
  anchor: string;
  /** How the enum's value set was established. */
  definition: EnumDefinitionKind;
  values: EnumValueRecord[];
};

export type EnumValueRecord = {
  id: string;
  enumName: string;
  value: string;
  /** Numeric value when the source states one, else null. */
  numericValue: number | null;
  sourceLine: number;
};

export type EnumMention = {
  enumName: string;
  value: string;
  sourceKey: string;
  url: string;
  anchor: string;
};

const QUALIFIED = /\b([A-Z][A-Za-z0-9_]*)\.([A-Z][A-Z0-9_]*[A-Z0-9])\b/;
const QUALIFIED_ALL = /\b([A-Z][A-Za-z0-9_]*)\.([A-Z][A-Z0-9_]*[A-Z0-9])\b/g;

/** Enum type names are written as `FooType`, `FooEnum` or plainly as a PascalCase noun. */
function looksLikeEnumName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(name) && !/^(ADBE|AfterEffects)$/.test(name);
}

type Chunk = { heading: MdHeading; body: string; startLine: number };

function chunkify(text: string, headings: readonly MdHeading[]): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    if (!h) continue;
    const next = headings[i + 1];
    const startLine = h.line;
    const endLine = next ? next.line - 1 : lines.length;
    out.push({ heading: h, body: lines.slice(startLine, endLine).join("\n"), startLine });
  }
  return out;
}

/**
 * Read a numeric value the source states for an enum constant, either as a bare
 * `` `0` `` cell or as a leading `0.` description. Returns null when unstated.
 */
function numericFrom(text: string): number | null {
  const ticked = /`(-?\d+)`/.exec(text);
  if (ticked?.[1] !== undefined) return Number.parseInt(ticked[1], 10);
  const leading = /^\s*(-?\d+)\s*\./.exec(text);
  if (leading?.[1] !== undefined) return Number.parseInt(leading[1], 10);
  return null;
}

function bulletValueLines(body: string): { raw: string; line: number }[] {
  const out: { raw: string; line: number }[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = /^\s*[-*]\s+`([^`]+)`(.*)$/.exec(line);
    if (m?.[1]) out.push({ raw: `${m[1]}${m[2] ?? ""}`, line: i });
  }
  return out;
}

export function extractEnums(
  doc: DocFile,
  opts: {
    sourceKey: string;
    urlFor: (sitePath: string) => string;
    /** Known class names, so `Property.COLOR`-style member refs are not read as enums. */
    knownClassNames?: readonly string[];
  },
): { enums: EnumRecord[]; mentions: EnumMention[] } {
  const headings = extractHeadings(doc.text);
  const chunks = chunkify(doc.text, headings);
  const url = opts.urlFor(doc.sitePath);
  const enums: EnumRecord[] = [];
  const mentions: EnumMention[] = [];
  const seenMention = new Set<string>();

  /**
   * Constants qualified under a member entry (a `| Value | Description |` table or a
   * bullet list of `Name.VALUE`) define an enum only when the qualifier is not a
   * known class name. This distinguishes `LayerInputStageType.SOURCE` (an enum
   * constant) from `Property.COLOR` (a member reference in prose).
   */
  const knownClasses = new Set(opts.knownClassNames ?? []);

  const addMention = (enumName: string, value: string, anchor: string) => {
    const key = `${enumName}.${value}`;
    if (seenMention.has(key)) return;
    seenMention.add(key);
    mentions.push({ enumName, value, sourceKey: opts.sourceKey, url, anchor });
  };

  for (const chunk of chunks) {
    const { heading, body } = chunk;
    const h = heading.text;

    // Shape 1: `## EnumName` (or `#### EnumName Enum`) dedicated section.
    const enumSub = /^([A-Z][A-Za-z0-9_]*)\s+Enum$/.exec(h);
    const dedicated =
      heading.level === 2 && looksLikeEnumName(h) && !h.includes(" ")
        ? h
        : enumSub?.[1] ?? null;

    if (dedicated) {
      const values: EnumValueRecord[] = [];
      const anchor = slugify(h);
      for (const line of body.split("\n")) {
        for (const m of line.matchAll(QUALIFIED_ALL)) {
          const owner = m[1];
          const value = m[2];
          if (!owner || !value || owner !== dedicated) continue;
          if (values.some((v) => v.value === value)) continue;
          values.push({
            id: `provisional.ae.scripting.enum.${dedicated}.${value}`,
            enumName: dedicated,
            value,
            numericValue: numericFrom(line),
            sourceLine: chunk.startLine,
          });
        }
      }
      if (values.length > 0) {
        enums.push({
          id: `provisional.ae.scripting.enum.${dedicated}`,
          name: dedicated,
          sourceKey: opts.sourceKey,
          url,
          anchor,
          definition: enumSub ? "enum-subsection" : "dedicated-section",
          values,
        });
        for (const v of values) addMention(dedicated, v.value, anchor);
        continue;
      }
    }

    // Shape 2/3: a paragraph declaring an enum type, then bullet values.
    const declared = new Set<string>();
    for (const m of body.matchAll(/`([A-Z][A-Za-z0-9_]*)`\s+(?:enum|enumerated value)/g)) {
      const name = m[1];
      if (name) declared.add(name);
    }

    // Shape 4: constants qualified in a table or bullet list under a member entry,
    // where the qualifier is an enum namespace rather than a known class name.
    if (declared.size === 0) {
      const grouped = new Map<string, EnumValueRecord[]>();
      for (const line of body.split("\n")) {
        for (const m of line.matchAll(QUALIFIED_ALL)) {
          const enumName = m[1];
          const value = m[2];
          if (!enumName || !value) continue;
          if (knownClasses.has(enumName)) continue;
          if (!/^[A-Z][A-Z0-9_]*$/.test(value)) continue;
          const bucket = grouped.get(enumName) ?? [];
          if (bucket.some((v) => v.value === value)) continue;
          bucket.push({
            id: `provisional.ae.scripting.enum.${enumName}.${value}`,
            enumName,
            value,
            numericValue: numericFrom(line),
            sourceLine: chunk.startLine,
          });
          grouped.set(enumName, bucket);
        }
      }
      for (const [enumName, values] of grouped) {
        // One constant alone is weaker evidence than a group; require at least two
        // distinct constants before calling the namespace an enum definition.
        if (values.length < 2) continue;
        const existing = enums.find((e) => e.name === enumName);
        if (existing) {
          for (const v of values) {
            if (!existing.values.some((x) => x.value === v.value)) existing.values.push(v);
          }
        } else {
          enums.push({
            id: `provisional.ae.scripting.enum.${enumName}`,
            name: enumName,
            sourceKey: opts.sourceKey,
            url,
            anchor: slugify(h),
            definition: "inline-qualified-values",
            values,
          });
        }
        for (const v of values) addMention(enumName, v.value, slugify(h));
      }
      continue;
    }

    const bullets = bulletValueLines(body);
    for (const enumName of declared) {
      const values: EnumValueRecord[] = [];
      for (const b of bullets) {
        const qualified = QUALIFIED.exec(b.raw);
        if (qualified && qualified[1] === enumName && qualified[2]) {
          if (values.some((v) => v.value === qualified[2])) continue;
          values.push({
            id: `provisional.ae.scripting.enum.${enumName}.${qualified[2]}`,
            enumName,
            value: qualified[2],
            numericValue: numericFrom(b.raw),
            sourceLine: chunk.startLine,
          });
        } else if (!qualified && /^[A-Z][A-Z0-9_]{1,}$/.test(b.raw.split(":")[0]?.trim() ?? "")) {
          const value = (b.raw.split(":")[0] ?? "").trim();
          if (values.some((v) => v.value === value)) continue;
          values.push({
            id: `provisional.ae.scripting.enum.${enumName}.${value}`,
            enumName,
            value,
            numericValue: numericFrom(b.raw),
            sourceLine: chunk.startLine,
          });
        }
      }
      if (values.length === 0) continue;
      const existing = enums.find((e) => e.name === enumName);
      if (existing) {
        for (const v of values) {
          if (!existing.values.some((x) => x.value === v.value)) existing.values.push(v);
        }
      } else {
        enums.push({
          id: `provisional.ae.scripting.enum.${enumName}`,
          name: enumName,
          sourceKey: opts.sourceKey,
          url,
          anchor: slugify(h),
          definition: "typed-bullet-list",
          values,
        });
      }
      for (const v of values) addMention(enumName, v.value, slugify(h));
    }
  }

  // Mentions that never resolved to a definition remain mention-only.
  for (const m of mentions) {
    const defined = enums.some(
      (e) => e.name === m.enumName && e.values.some((v) => v.value === m.value),
    );
    if (!defined) {
      const found = enums.find((e) => e.name === m.enumName);
      if (!found) {
        enums.push({
          id: `provisional.ae.scripting.enum.${m.enumName}`,
          name: m.enumName,
          sourceKey: opts.sourceKey,
          url: m.url,
          anchor: m.anchor,
          definition: "typed-bullet-list",
          values: [],
        });
      }
    }
  }

  return { enums: enums.filter((e) => e.values.length > 0), mentions };
}

export { looksLikeEnumName, QUALIFIED };
