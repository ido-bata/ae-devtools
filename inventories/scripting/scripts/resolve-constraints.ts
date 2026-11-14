/**
 * Resolve constraint specs against the fetched sources (CAP007).
 *
 * Same discipline as the Adobe claim resolver: a constraint carries a detector that
 * must match the cited block, so it cannot outlive the wording it was derived from.
 * Community-tier constraints are resolved against the pinned guide archive; Adobe
 * constraints against the fetched Adobe pages.
 */

import { extractHeadings } from "./markdown.ts";
import { slugify } from "./markdown.ts";
import type { AdobePageText } from "./adobe-page.ts";
import { CONSTRAINTS } from "./constraints.ts";
import type { ConstraintEvidence, ConstraintSpec } from "./constraints.ts";
import type { DocFile } from "./extract-symbols.ts";

/** Return the text of one heading's section, or null when the heading is absent. */
function sectionBody(doc: DocFile, heading: string): string | null {
  const lines = doc.text.split("\n");
  const headings = extractHeadings(doc.text);
  const index = headings.findIndex(
    (h) => h.text.trim().toLowerCase() === heading.toLowerCase(),
  );
  if (index < 0) return null;
  const h = headings[index];
  if (!h) return null;
  let endLine = lines.length;
  for (let i = index + 1; i < headings.length; i += 1) {
    const next = headings[i];
    if (next && next.level <= h.level) {
      endLine = next.line - 1;
      break;
    }
  }
  return lines.slice(h.line - 1, endLine).join("\n");
}

export function resolveConstraints(
  docs: readonly DocFile[],
  adobePages: ReadonlyMap<string, AdobePageText>,
  urls: {
    dfad: (sitePath: string, anchor: string | null) => string;
    adobe: (key: string) => string;
  },
): { evidence: ConstraintEvidence[]; failures: string[] } {
  const evidence: ConstraintEvidence[] = [];
  const failures: string[] = [];

  for (const spec of CONSTRAINTS) {
    const anchor = spec.anchorHeading ? slugFor(spec.anchorHeading) : "";

    if (spec.tier === "community-reference") {
      const doc = docs.find((d) => d.sitePath === spec.page);
      if (!doc) {
        failures.push(`${spec.id}: guide page "${spec.page}" not found in archive`);
        continue;
      }
      const body = spec.anchorHeading ? sectionBody(doc, spec.anchorHeading) : doc.text;
      if (body === null) {
        failures.push(
          `${spec.id}: heading "${spec.anchorHeading}" not found in ${spec.page}`,
        );
        continue;
      }
      if (!spec.detector.test(body)) {
        failures.push(
          `${spec.id}: detector /${spec.detector.source}/ does not match "${spec.anchorHeading}" in ${spec.page}`,
        );
        continue;
      }
      evidence.push(toEvidence(spec, {
        publisher: "docsforadobe (community)",
        authority: "community-maintained",
        url: urls.dfad(spec.page, anchor || null),
        anchor,
      }));
      continue;
    }

    const page = adobePages.get(spec.page);
    if (!page) {
      failures.push(`${spec.id}: Adobe page "${spec.page}" not fetched`);
      continue;
    }
    if (!spec.detector.test(page.text)) {
      failures.push(
        `${spec.id}: detector /${spec.detector.source}/ does not match Adobe page ${spec.page}`,
      );
      continue;
    }
    evidence.push(toEvidence(spec, {
      publisher: "Adobe",
      authority: "primary",
      url: urls.adobe(spec.page),
      anchor,
    }));
  }

  return { evidence, failures };
}

function slugFor(heading: string): string {
  return slugify(heading);
}

function toEvidence(
  spec: ConstraintSpec,
  src: {
    publisher: string;
    authority: "primary" | "community-maintained";
    url: string;
    anchor: string;
  },
): ConstraintEvidence {
  return {
    id: spec.id,
    category: spec.category,
    statement: spec.statement,
    tier: spec.tier,
    publisher: src.publisher,
    authority: src.authority,
    url: src.url,
    anchor: src.anchor,
    aeVersionScope: spec.aeVersionScope,
    osScope: spec.osScope,
    versionStated: spec.aeVersionScope !== null,
    implication: spec.implication,
  };
}
