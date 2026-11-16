/**
 * Source registry for the After Effects Scripting API inventory (CAP005-CAP008).
 *
 * Two source tiers are recorded separately and are never merged into one
 * authority claim:
 *
 *   - `adobe-official`      : pages published on adobe.com / helpx.adobe.com.
 *   - `community-reference` : the docsforadobe After Effects Scripting Guide,
 *                             which is community maintained. It is NOT an
 *                             Adobe-official mirror.
 *
 * Every fetched source is pinned by commit/tag where the source is a Git
 * repository, and by a SHA-256 content hash of the exact bytes used. The
 * extractor refuses to run against unpinned bytes.
 */

export type SourceTier = "adobe-official" | "community-reference";

export type SourceSpec = {
  /** Stable short id used in inventory ids and provenance blocks. */
  readonly key: string;
  readonly tier: SourceTier;
  /** Human-facing publisher string, kept explicit so reports cannot blur tiers. */
  readonly publisher: string;
  readonly title: string;
  /** Canonical public URL a reader can open. */
  readonly publicUrl: string;
  /** URL the extractor actually downloads bytes from. */
  readonly fetchUrl: string;
  /** Kind of payload, which selects the parser. */
  readonly parser: "docsforadobe-markdown" | "adobe-helpx-article";
  readonly authority: "primary" | "community-maintained";
  /** Immutable revision pin. Commit SHA for Git sources, `http-<date>` for live pages. */
  readonly revision: string;
  /** AE versions the source itself claims to describe, when stated. */
  readonly declaredVersions?: string;
  readonly note?: string;
};

export const DOCS_FOR_ADOBE_COMMIT =
  "7137a990db4bd8dc9f5869b8ca431c7dfed52bdc";

const DFAD_RAW = `https://raw.githubusercontent.com/docsforadobe/after-effects-scripting-guide/${DOCS_FOR_ADOBE_COMMIT}`;
const DFAD_TREE = `https://codeload.github.com/docsforadobe/after-effects-scripting-guide/tar.gz/${DOCS_FOR_ADOBE_COMMIT}`;

/**
 * The community guide is fetched as one archive so the whole symbol set comes
 * from a single pinned revision. Downloading ~60 pages individually would let
 * a mid-run upstream change mix revisions in one inventory.
 */
export const COMMUNITY_ARCHIVE: SourceSpec = {
  key: "dfad",
  tier: "community-reference",
  publisher: "docsforadobe (community)",
  title: "After Effects Scripting Guide (community-maintained)",
  publicUrl: "https://ae-scripting.docsforadobe.dev/",
  fetchUrl: DFAD_TREE,
  parser: "docsforadobe-markdown",
  authority: "community-maintained",
  revision: DOCS_FOR_ADOBE_COMMIT,
  note:
    "Community maintained. Derived from the Adobe CS6 Scripting Guide but extended " +
    "upstream by contributors. Explicitly not an Adobe-official publication and " +
    "not treated as a mirror of current Adobe documentation.",
};

/** Adobe-official pages that carry scripting-relevant statements. */
export const ADOBE_PAGES: readonly SourceSpec[] = [
  {
    key: "adobe-scripts",
    tier: "adobe-official",
    publisher: "Adobe",
    title: "Scripts in After Effects",
    publicUrl:
      "https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html",
    fetchUrl:
      "https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/scripts.html",
    parser: "adobe-helpx-article",
    authority: "primary",
    revision: "http-2026-11-12",
    note:
      "Official page for script loading, the Scripts/ScriptUI Panels folders, the " +
      "file-write and network permission preference, and command-line invocation. " +
      "It states that symbol-level capabilities are described elsewhere and links " +
      "to the community guide.",
  },
  {
    key: "adobe-automation",
    tier: "adobe-official",
    publisher: "Adobe",
    title: "Automation in After Effects",
    publicUrl:
      "https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/automation.html",
    fetchUrl:
      "https://helpx.adobe.com/after-effects/desktop/automate-in-after-effects/automate-animation/automation.html",
    parser: "adobe-helpx-article",
    authority: "primary",
    revision: "http-2026-11-12",
    note:
      "Official overview that separates expressions, scripts, plug-ins and " +
      "aerender automation. Carries no per-symbol reference.",
  },
  {
    key: "adobe-legacy-extendscript-engine",
    tier: "adobe-official",
    publisher: "Adobe",
    title: "Legacy and ExtendScript engine",
    publicUrl:
      "https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/legacy-and-extend-script-engine.html",
    fetchUrl:
      "https://helpx.adobe.com/after-effects/desktop/work-with-expressions/expression-basics/legacy-and-extend-script-engine.html",
    parser: "adobe-helpx-article",
    authority: "primary",
    revision: "http-2026-11-12",
    note:
      "Official statement that the legacy ExtendScript engine is based on " +
      "ECMAScript 3 (1999) and that the JavaScript expression engine in AE 16.0 " +
      "is based on ECMAScript 2018. Scoped to the expression engine at the point " +
      "where it compares the two engines; ExtendScript itself is identified as the " +
      "scripting language.",
  },
  {
    key: "adobe-variable-font-axes",
    tier: "adobe-official",
    publisher: "Adobe",
    title: "Scripting support for Variable Font Axes",
    publicUrl:
      "https://helpx.adobe.com/after-effects/desktop/variable-font-axes/work-with-variable-font-axes/scripting-support-for-variable-font-axes.html",
    fetchUrl:
      "https://helpx.adobe.com/after-effects/desktop/variable-font-axes/work-with-variable-font-axes/scripting-support-for-variable-font-axes.html",
    parser: "adobe-helpx-article",
    authority: "primary",
    revision: "http-2026-11-12",
    note:
      "One of the few Adobe-official pages that names individual scripting " +
      "symbols, in worked examples rather than in reference form.",
  },
];

export const ALL_SOURCES: readonly SourceSpec[] = [
  COMMUNITY_ARCHIVE,
  ...ADOBE_PAGES,
];

/** AE builds that the inventory is cross-referenced against. Local installs are
 *  recorded as environment facts only; they are not execution evidence. */
export const REFERENCE_HOSTS = [
  {
    product: "Adobe After Effects 2026",
    version: "26.5.3",
    os: "darwin",
    role: "local install present; NOT used for runtime verification in this issue",
  },
  {
    product: "Adobe After Effects 2027",
    version: "27.0.0",
    os: "darwin",
    role: "local install present; NOT used for runtime verification in this issue",
  },
] as const;

export { DFAD_RAW };
