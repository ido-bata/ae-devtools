/**
 * Markdown heading extraction that mirrors the subset of the community guide
 * structure this inventory depends on.
 *
 * Only headings are read. Body prose, examples and tables are deliberately not
 * captured, both to keep the committed artifact free of mirrored documentation
 * and because a heading plus a small structured note is enough to identify a
 * symbol and its provenance.
 */

export type MdHeading = {
  readonly level: 1 | 2 | 3 | 4;
  readonly text: string;
  /** 1-based line number in the source file. */
  readonly line: number;
};

const FENCE = "```";

/**
 * Strip fenced code blocks before heading detection. The guide contains ExtendScript
 * comments that begin with `//` and, more importantly, markdown tables whose cells
 * may contain `#`. Fence removal keeps heading detection from matching content.
 */
function stripCodeFences(lines: readonly string[]): string[] {
  let inFence = false;
  return lines.map((line) => {
    if (line.trimStart().startsWith(FENCE)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

export function extractHeadings(source: string): MdHeading[] {
  const rawLines = source.split("\n");
  const lines = stripCodeFences(rawLines);
  const out: MdHeading[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = /^(#{1,4}) (.+?)\s*$/.exec(line);
    if (!m) continue;
    const hashes = m[1] ?? "";
    const text = m[2] ?? "";
    out.push({
      level: hashes.length as 1 | 2 | 3 | 4,
      text,
      line: i + 1,
    });
  }
  return out;
}

/**
 * Reproduce the anchor slug that mkdocs-material (used by the community guide)
 * generates for a heading, so provenance links land on the right section.
 *
 * Verified against the live site: `app.beginUndoGroup()` -> `appbeginundogroup`,
 * `Font object` -> `font-object`, `Property.propertyValueType` ->
 * `propertypropertyvaluetype`. Punctuation is removed, not replaced with a hyphen;
 * only whitespace and existing hyphens collapse to hyphens.
 */
export function slugify(heading: string): string {
  const plain = heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .toLowerCase()
    .trim();
  return plain
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Return the text of every heading level at or above `stopAt`, in order. */
export function sectionTrail(
  headings: readonly MdHeading[],
  index: number,
): string[] {
  const trail: string[] = [];
  const target = headings[index];
  if (!target) return trail;
  for (let i = index - 1; i >= 0; i -= 1) {
    const h = headings[i];
    if (!h) continue;
    if (h.level < target.level) {
      trail.unshift(h.text);
      if (h.level === 2) break;
    }
  }
  return trail;
}
