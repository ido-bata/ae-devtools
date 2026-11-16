/**
 * Version-delta extraction from the community guide's scripting changelog (CAP006).
 *
 * The changelog is the only machine-readable statement of "what changed in which AE
 * release" available from either source tier. It is community maintained, so its
 * deltas are recorded as community claims and every row carries that provenance.
 *
 * Attributed symbols are cross-referenced against the extracted member set: a delta
 * that names a member the inventory does not contain is reported as `unresolved`
 * instead of being silently dropped or silently accepted.
 */

import { extractHeadings } from "./markdown.ts";
import type { MdHeading } from "./markdown.ts";
import type { DocFile } from "./extract-symbols.ts";

export type DeltaKind = "added" | "removed" | "updated" | "renamed";

export type VersionDelta = {
  /** AE version as written by the changelog, e.g. "26.5". */
  aeVersion: string;
  /** Release label when the changelog gives one, e.g. "CC 2017.1". */
  releaseLabel: string | null;
  /** Release date string as written, e.g. "September 2026". */
  releaseDate: string | null;
  /** Link the changelog attaches to the release heading, when present. */
  releaseUrl: string | null;
  kind: DeltaKind;
  /** Symbol as written, e.g. `Item.getGuideAsObject()` or `GuideOptions object`. */
  symbol: string;
  /** Resolved inventory id when the symbol matched an extracted member. */
  resolvedId: string | null;
  /** True when the changelog says this is a breaking change. */
  breaking: boolean;
  /** Raw changelog anchor target when the entry links into the guide. */
  anchor: string | null;
  /** Notes carried over from warnings inside the same release section. */
  notes: string[];
};

const RELEASE_HEADING =
  /^\[?After Effects (\d+(?:\.\d+)*)(?:\s*\(([^)]+)\))?\]?(?:\(([^)]*)\))?(?:\s*\(([^)]+)\))?$/;

/**
 * Parse the changelog into per-release deltas.
 *
 * Only the `###` release headings and `- Added: ...` / `- Removed: ...` style
 * bullets are read. Prose paragraphs are skipped; the one structured warning the
 * guide uses (a `!!! warning "Differences between versions"` block) is turned into a
 * note attached to the release it appears under, because it states a behavioural
 * version difference rather than a symbol addition.
 */
export function extractChangelog(
  doc: DocFile,
  symbols: readonly { id: string; owner: string; member: string }[],
  extra?: {
    classes?: readonly { id: string; name: string }[];
    enums?: readonly { id: string; name: string; values: readonly { value: string }[] }[];
  },
): { deltas: VersionDelta[]; notes: string[]; resolverMisses: string[] } {
  const lines = doc.text.split("\n");
  const headings = extractHeadings(doc.text);
  const deltas: VersionDelta[] = [];
  const globalNotes: string[] = [];

  const byOwnerMember = new Map<string, string>();
  for (const s of symbols) byOwnerMember.set(`${s.owner}.${s.member}`, s.id);
  /** Member-looking deltas that matched no extracted member; surfaced, not hidden. */
  const resolverMisses: string[] = [];
  const classIds = new Map<string, string>();
  for (const c of extra?.classes ?? []) classIds.set(c.name, c.id);
  const enumIds = new Map<string, string>();
  for (const e of extra?.enums ?? []) enumIds.set(e.name, e.id);

  // Resolve release sections from `## After Effects N` / `### [After Effects N.x](url) (Month Year)`.
  let current: {
    aeVersion: string;
    releaseLabel: string | null;
    releaseDate: string | null;
    releaseUrl: string | null;
    notes: string[];
    breaking: boolean;
  } | null = null;

  for (let i = 0; i < headings.length; i += 1) {
    const h = headings[i];
    if (!h || h.level !== 3) continue;
    const m = RELEASE_HEADING.exec(h.text);
    if (!m) continue;

    const startLine = h.line;
    const next = headings.slice(i + 1).find((x) => x.level <= 3);
    const endLine = next ? next.line - 1 : lines.length;
    const body = lines.slice(startLine, endLine).join("\n");

    current = {
      aeVersion: m[1] ?? "",
      releaseLabel: m[2] ?? m[4] ?? null,
      releaseDate: m[3] ?? m[4] ?? null,
      releaseUrl: /\((https?:\/\/[^)]+)\)/.exec(h.text)?.[1] ?? null,
      notes: [],
      breaking: false,
    };

    // Structured warnings become release-scoped notes. Stored as a short paraphrase
    // plus the note's own label, not as copied prose: the inventory records that a
    // warning exists and what it concerns, and a reader follows the link for wording.
    for (const note of body.matchAll(/!!!\s*warning\s*"([^"]*)"\s*\n([\s\S]*?)(?=\n[^\s]|\n*$)/g)) {
      const label = (note[1] ?? "").trim();
      const content = (note[2] ?? "").replace(/\s+/g, " ").trim();
      if (!content) continue;
      const breaking = /breaking change/i.test(content);
      // Identify which symbols the warning names, so the note is actionable.
      const named = [...content.matchAll(/`([A-Za-z_][\w.]*)`/g)]
        .map((m) => m[1])
        .filter((v): v is string => typeof v === "string")
        .slice(0, 6);
      const summary =
        `${label || "warning"}: ` +
        (breaking ? "declared a breaking change" : "declared a version caveat") +
        (named.length > 0 ? `; concerns ${[...new Set(named)].join(", ")}` : "");
      current.notes.push(summary);
      current.breaking = current.breaking || breaking;
    }

    let kind: DeltaKind | null = null;
    for (const line of body.split("\n")) {
      if (/Added:/.test(line)) kind = "added";
      else if (/Removed from|Removed:/.test(line)) kind = "removed";
      else if (/\bUpdated:/.test(line)) kind = "updated";
      else if (/\bRenamed:/.test(line)) kind = "renamed";

      const entry = /(?:Added|Removed|Updated|Renamed):?\s*\[?([^\]\n]+?)\]?(?:\(([^)]+)\))?\s*$/.exec(
        line.trim(),
      );
      if (!entry || !kind) continue;
      const rawSymbol = (entry[1] ?? "").trim();
      if (!rawSymbol) continue;
      // Ignore prose bullets such as "Added support for Paragraph Box Text".
      if (/\s{2,}|support for|ability|option to/i.test(rawSymbol)) continue;
      // Release notes occasionally embed an explanatory clause instead of a symbol.
      if (/\b(see|the following|related to|as well as)\b/i.test(rawSymbol)) continue;

      const anchor = entry[2] ?? null;
      const bare = rawSymbol
        .replace(/\s*object$/, "")
        .replace(/\(\)$/, "")
        .replace(/`/g, "")
        .trim();

      // Release notes also name whole objects ("Added: Font object") and mention
      // non-symbol artifacts ("Added relevant match names"). Those are kept only
      // when they resolve to a class; obvious prose is dropped.
      if (/\bmatch names?\b/i.test(bare)) continue;

      let owner: string;
      let member: string;
      if (bare.includes(".")) {
        const parts = bare.split(".");
        owner = parts[0] ?? "";
        member = parts.slice(1).join(".");
      } else {
        owner = bare;
        member = "";
      }

      // The changelog link target is the authoritative class page. When the entry
      // omits the class prefix (`baselineLocs`), recover the owner from the anchor,
      // which mkdocs builds as `<class><member>` lowercased.
      let resolved: string | undefined;
      if (member) {
        resolved = byOwnerMember.get(`${owner}.${member}`);
      }

      // A bare name is either a class ("Font object" -> class) or a member written
      // without its class prefix ("baselineLocs"). Try the anchor first, then a
      // unique member match. Ambiguity is left unresolved rather than guessed.
      if (!resolved && !member) {
        const slug = anchor?.split("#")[1] ?? "";
        if (slug) {
          for (const [key, id] of byOwnerMember) {
            const [o, m] = key.split(".") as [string, string];
            if (slug === `${o}${m}`.toLowerCase()) {
              resolved = id;
              owner = o;
              member = m;
              break;
            }
          }
        }
        if (!resolved) {
          const candidates = [...byOwnerMember.entries()].filter(
            ([key]) => key.split(".")[1] === bare,
          );
          if (candidates.length === 1) {
            const only = candidates[0];
            if (only) {
              resolved = only[1];
              const [o, m] = only[0].split(".") as [string, string];
              owner = o;
              member = m;
            }
          }
        }
      }

      if (member && !resolved) {
        resolverMisses.push(bare);
      }

      // Class and enum names are their own inventory entries, not members.
      if (!member) {
        const cls = classIds.get(bare);
        if (cls) resolved = cls;
        else {
          const en = enumIds.get(bare);
          if (en) resolved = en;
        }
      }

      deltas.push({
        aeVersion: current.aeVersion,
        releaseLabel: current.releaseLabel,
        releaseDate: current.releaseDate,
        releaseUrl: current.releaseUrl,
        kind,
        symbol: member ? `${owner}.${member}` : bare,
        resolvedId: resolved ?? null,
        breaking: false,
        anchor,
        notes: [],
      });
    }

    // Attach release notes to the deltas of that release.
    const releaseNotes = [...current.notes];
    const releaseBreaking = current.breaking;
    for (const d of deltas) {
      if (d.aeVersion === current.aeVersion && releaseNotes.length > 0) {
        d.notes = [...releaseNotes];
        if (releaseBreaking) d.breaking = true;
      }
    }
    globalNotes.push(...current.notes.map((n) => `AE ${current?.aeVersion}: ${n}`));
  }

  return { deltas, notes: globalNotes, resolverMisses };
}
