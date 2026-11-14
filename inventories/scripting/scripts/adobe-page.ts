/**
 * Reader for Adobe helpx pages and Adobe developer pages.
 *
 * Those pages are HTML with heavy navigation chrome. Only the main article text is
 * needed, and only to (a) test a claim detector and (b) read heading anchors. The
 * extractor therefore reduces each page to normalised visible text plus headings,
 * and never stores the HTML or the prose.
 */

import { extractHeadings } from "./markdown.ts";
import type { MdHeading } from "./markdown.ts";

export type AdobePageText = {
  /** Normalised visible text, whitespace collapsed. Used only for detector tests. */
  readonly text: string;
  /** Headings discovered in the article body. */
  readonly headings: readonly MdHeading[];
  /** Absolute hrefs found in the article body, de-duplicated and sorted. */
  readonly links: readonly string[];
  /** Page-level "Last updated on ..." date when the page displays one. */
  readonly lastUpdated: string | null;
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const hit = ENTITIES[body];
    return hit ?? whole;
  });
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

export function normaliseText(html: string): string {
  return decodeEntities(stripTags(html))
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Extract `<h1>..<h4>` elements from the article region as markdown-style headings
 * so the shared heading/anchor helpers apply unchanged to both source tiers.
 */
function htmlHeadings(html: string): MdHeading[] {
  const out: MdHeading[] = [];
  const re = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const m of html.matchAll(re)) {
    const level = Number.parseInt(m[1] ?? "0", 10);
    const raw = m[2] ?? "";
    const text = normaliseText(raw).replace(/\n+/g, " ").trim();
    if (!text) continue;
    if (level < 1 || level > 4) continue;
    out.push({ level: level as 1 | 2 | 3 | 4, text, line: 0 });
  }
  // Deduplicate: helpx repeats headings in the site-wide navigation.
  const seen = new Set<string>();
  return out.filter((h) => {
    const key = `${h.level}:${h.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseAdobePage(html: string): AdobePageText {
  // Prefer the article container; fall back to the whole document when the page
  // has a different shell. Both branches only feed detector tests.
  const article =
    /<div[^>]+class="[^"]*cmp-text[^"]*"[^>]*>([\s\S]*)<\/div>\s*<\/div>/i.exec(html)?.[1] ??
    /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ??
    html;

  const text = normaliseText(article);
  const updated = /Last updated on\s*\n?\s*([A-Z][a-z]{2} \d{1,2}, \d{4})/.exec(
    normaliseText(html),
  );

  // Link targets carry statements the visible text drops (for example the target
  // of "refer to … After Effects Scripting Guide"). Only absolute http(s) targets
  // are kept, so a detector can assert a link exists without storing page prose.
  const links = new Set<string>();
  for (const m of article.matchAll(/href="([^"]+)"/g)) {
    const href = decodeEntities(m[1] ?? "").trim();
    if (/^https?:\/\//i.test(href)) links.add(href);
  }

  return {
    text,
    headings: htmlHeadings(article),
    links: [...links].sort(),
    lastUpdated: updated?.[1] ?? null,
  };
}
