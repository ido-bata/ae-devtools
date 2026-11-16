/**
 * Adobe-official scripting constraints (CAP006 / CAP007).
 *
 * Adobe publishes no symbol-level scripting reference page. What Adobe does publish
 * is a small set of operational constraints: where scripts load from, whether they
 * may touch the filesystem or the network, how they are invoked, and which
 * ECMAScript level the ExtendScript engine implements.
 *
 * Those statements are recorded here as explicit claims. Each claim carries a
 * `detector` — a regular expression that must match the fetched Adobe page — and the
 * heading whose section the claim belongs to. A build fails when a detector stops
 * matching, so a claim cannot silently outlive the wording it was derived from.
 * Only a short paraphrase and the anchor are stored; the page prose is not copied.
 */

import { extractHeadings, slugify } from "./markdown.ts";
import type { AdobePageText } from "./adobe-page.ts";

export type ClaimCategory =
  | "es3-language"
  | "script-loading"
  | "file-permission"
  | "network-permission"
  | "ui-invocation"
  | "command-line"
  | "host-lifecycle"
  | "documentation-scope";

export type ClaimSpec = {
  readonly id: string;
  readonly sourceKey: string;
  readonly category: ClaimCategory;
  /** Heading text the claim is attached to; anchor is derived from it. */
  readonly sectionHeading: string;
  /** Must match the normalised page text (or `links`, when `detectIn` is "links"). */
  readonly detector: RegExp;
  /** Which surface the detector runs against. Defaults to visible text. */
  readonly detectIn?: "text" | "links";
  /** Short paraphrase in the inventory's own words. */
  readonly summary: string;
  /** Which AE version / OS the statement is scoped to, per the page itself. */
  readonly scope: string;
  /** True when the page itself does not state an AE version for the statement. */
  readonly versionUnstated: boolean;
  readonly osSpecific: boolean;
};

/**
 * Claims are ordered by source, then by document order. `id` is provisional; the
 * final capability-ID grammar belongs to issue #11.
 */
export const CLAIMS: readonly ClaimSpec[] = [
  {
    id: "provisional.ae.official.script-language-is-extendscript",
    sourceKey: "adobe-scripts",
    category: "es3-language",
    sectionHeading: "Scripts",
    detector: /scripts use the Adobe ExtendScript language/i,
    summary:      "Scripts in After Effects are written in ExtendScript with .jsx / .jsxbin extensions.",
    scope: "unversioned statement on a page last updated 2024-10-03",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.scripts-folder-locations",
    sourceKey: "adobe-scripts",
    category: "script-loading",
    sectionHeading: "Load and run scripts",
    detector: /Support Files/i,
    summary:
      "Scripts are loaded at startup from a per-install Scripts folder; the page gives a Windows and a macOS path shape.",
    scope: "unversioned; page gives path shapes with a <version> placeholder",
    versionUnstated: true,
    osSpecific: true,
  },
  {
    id: "provisional.ae.official.scriptui-panels-folder",
    sourceKey: "adobe-scripts",
    category: "ui-invocation",
    sectionHeading: "Load and run scripts",
    detector: /ScriptUI Panels folder are available from the bottom of the/i,
    summary:
      "Scripts placed in the ScriptUI Panels folder appear at the bottom of the Window menu as dockable panels.",
    scope: "unversioned",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.scripts-restart-required",
    sourceKey: "adobe-scripts",
    category: "script-loading",
    sectionHeading: "Load and run scripts",
    detector: /must restart After Effects for the script to appear/i,
    summary:
      "Adding a script to the Scripts folder while AE is running requires a restart before it appears in the menu; Run Script File works immediately.",
    scope: "unversioned",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.file-write-denied-by-default",
    sourceKey: "adobe-scripts",
    category: "file-permission",
    sectionHeading: "Load and run scripts",
    detector: /not allowed to write files/i,
    summary:
      "By default a script may not write files. Writing requires the Scripting & Expressions preference 'Allow Scripts To Write Files And Access Network'.",
    scope: "unversioned default-state statement",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.network-denied-by-default",
    sourceKey: "adobe-scripts",
    category: "network-permission",
    sectionHeading: "Load and run scripts",
    detector: /send or receive communication over a network/i,
    summary:
      "By default a script may not send or receive network communication; the same single preference gates both file writes and network access.",
    scope: "unversioned default-state statement",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.preference-menu-paths",
    sourceKey: "adobe-scripts",
    category: "ui-invocation",
    sectionHeading: "Load and run scripts",
    detector: /Scripting &(?:amp;)? Expressions/i,
    summary:
      "The page gives distinct menu paths to the permission preference per OS (Edit > Preferences on Windows, After Effects > Settings on macOS).",
    scope: "unversioned; OS-specific menu paths",
    versionUnstated: true,
    osSpecific: true,
  },
  {
    id: "provisional.ae.official.esc-stops-running-script",
    sourceKey: "adobe-scripts",
    category: "host-lifecycle",
    sectionHeading: "Load and run scripts",
    detector: /To stop a running script, press/i,
    summary: "A running script is stopped by pressing Esc.",
    scope: "unversioned",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.command-line-runs-in-existing-instance",
    sourceKey: "adobe-scripts",
    category: "command-line",
    sectionHeading: "Load and run scripts",
    detector: /does not open a new instance/i,
    summary:
      "The documented command-line invocation (-r with a script path) runs the script in the already-running instance rather than starting a new one.",
    scope: "unversioned; the page's example uses the Windows afterfx.exe path",
    versionUnstated: true,
    osSpecific: true,
  },
  {
    id: "provisional.ae.official.recent-script-shortcut",
    sourceKey: "adobe-scripts",
    category: "ui-invocation",
    sectionHeading: "Load and run scripts",
    detector: /10 most recently run scripts/i,
    summary:
      "AE keeps a list of the 10 most recently run scripts, with a per-OS keyboard shortcut to rerun one.",
    scope: "unversioned",
    versionUnstated: true,
    osSpecific: true,
  },
  {
    id: "provisional.ae.official.symbol-reference-deferred-to-community",
    sourceKey: "adobe-scripts",
    category: "documentation-scope",
    sectionHeading: "Scripts",
    detector: /^https:\/\/ae-scripting\.docsforadobe\.dev\//i,
    detectIn: "links",
    summary:
      "Adobe's scripting page does not enumerate the scripting object model; it points readers to ae-scripting.docsforadobe.dev for the scripting capabilities themselves. Recorded as the reason this inventory's symbol set comes from the community tier.",
    scope: "unversioned",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.automation-routes-are-distinct",
    sourceKey: "adobe-automation",
    category: "documentation-scope",
    sectionHeading: "Automation",
    detector: /aerender/i,
    summary:
      "Adobe separates expressions, scripts, plug-ins and aerender/network-render automation as distinct automation routes.",
    scope: "unversioned overview page, last updated 2023-11-03",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.legacy-extendscript-engine-is-es3",
    sourceKey: "adobe-legacy-extendscript-engine",
    category: "es3-language",
    sectionHeading: "Legacy ExtendScript engine is based on ECMAScript 3",
    detector: /Legacy ExtendScript expression engine is based on ECMAScript 3/i,
    summary:
      "Adobe states that the legacy ExtendScript expression engine targets ECMAScript 3, and identifies ExtendScript as the language used for scripting in AE.",
    scope: "statement about the legacy engine, from a page last updated 2026-05-05",
    versionUnstated: true,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.js-expression-engine-is-es2018",
    sourceKey: "adobe-legacy-extendscript-engine",
    category: "es3-language",
    sectionHeading: "Legacy ExtendScript engine is based on ECMAScript 3",
    detector: /JavaScript expression engine in After Effects 16\.0 is based on ECMAScript 2018/i,
    summary:
      "Adobe states that the JavaScript expression engine in AE 16.0 is based on ECMAScript 2018. This concerns the expression engine, not the ExtendScript scripting engine.",
    scope: "AE 16.0 and later for the JavaScript expression engine",
    versionUnstated: false,
    osSpecific: false,
  },
  {
    id: "provisional.ae.official.variable-font-axis-scripting",
    sourceKey: "adobe-variable-font-axes",
    category: "documentation-scope",
    sectionHeading: "Scripting support for Variable Font Axes",
    detector: /addVariableFontAxis/,
    summary:
      "Adobe names individual scripting symbols (addVariableFontAxis, fontObject, designAxesData) in a worked example rather than in reference form, and gives no version range on this page.",
    scope: "unversioned; page last updated 2026-01-21",
    versionUnstated: true,
    osSpecific: false,
  },
];

export type ClaimEvidence = {
  id: string;
  category: ClaimCategory;
  summary: string;
  scope: string;
  versionUnstated: boolean;
  osSpecific: boolean;
  sourceKey: string;
  publisher: string;
  tier: "adobe-official";
  /** Explicit: these are Adobe-published statements, not community ones. */
  authority: "primary";
  url: string;
  anchor: string;
  sectionHeading: string;
  /** Nearby heading the anchor was resolved against, for traceability. */
  anchorResolvedBy: "exact-heading" | "page-root";
};

/**
 * Resolve every claim against a fetched Adobe page. Throws when a detector no
 * longer matches, which is the drift gate: an upstream rewrite must be reviewed
 * rather than silently changing what the inventory asserts.
 */
export function resolveClaims(
  pages: ReadonlyMap<string, AdobePageText>,
  urlForKey: (key: string) => string,
): ClaimEvidence[] {
  const out: ClaimEvidence[] = [];
  const failures: string[] = [];

  for (const claim of CLAIMS) {
    const page = pages.get(claim.sourceKey);
    if (!page) {
      failures.push(`${claim.id}: source "${claim.sourceKey}" was not fetched`);
      continue;
    }
    if (claim.detectIn === "links") {
      if (!page.links.some((link) => claim.detector.test(link))) {
        failures.push(
          `${claim.id}: link detector /${claim.detector.source}/ no longer matches ${claim.sourceKey}`,
        );
        continue;
      }
    } else if (!claim.detector.test(page.text)) {
      failures.push(
        `${claim.id}: detector /${claim.detector.source}/ no longer matches ${claim.sourceKey}`,
      );
      continue;
    }

    const headings = extractHeadings(page.text);
    const match = headings.find(
      (h) => h.text.trim().toLowerCase() === claim.sectionHeading.toLowerCase(),
    );
    out.push({
      id: claim.id,
      category: claim.category,
      summary: claim.summary,
      scope: claim.scope,
      versionUnstated: claim.versionUnstated,
      osSpecific: claim.osSpecific,
      sourceKey: claim.sourceKey,
      publisher: "Adobe",
      tier: "adobe-official",
      authority: "primary",
      url: urlForKey(claim.sourceKey),
      anchor: match ? slugify(match.text) : "",
      sectionHeading: claim.sectionHeading,
      anchorResolvedBy: match ? "exact-heading" : "page-root",
    });

    if (!match) {
      // Not fatal: the anchor is a locator hint. Recorded so a reader can see the
      // claim is page-level rather than attached to a specific section.
      continue;
    }
  }

  if (failures.length > 0) {
    throw new Error(`Adobe-official claim drift:\n - ${failures.join("\n - ")}`);
  }
  return out;
}
