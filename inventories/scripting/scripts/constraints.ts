/**
 * Constraint classification (CAP007) and the real-host requirement list (CAP008).
 *
 * Two different things are produced here and they must not be confused:
 *
 *  1. `CONSTRAINTS` — classified constraints that a *documented source* states.
 *     Each row cites the tier and URL of the statement it came from, and carries the
 *     classification category the spec asks for (ES3, host object lifetime, undo,
 *     AE UI, file permission, ...).
 *
 *  2. `REAL_HOST_REQUIREMENTS` — behaviours that no documentation can settle because
 *     they depend on the running host: object identity across undo, stale handles,
 *     interruptibility, locale-dependent value representation, and so on. These are
 *     explicitly NOT tested in this issue. They are listed so the absence of a result
 *     is visible rather than implied.
 */

export type ConstraintCategory =
  | "es3-language"
  | "host-object-lifetime"
  | "undo"
  | "ae-ui"
  | "file-permission"
  | "network-permission"
  | "host-lifecycle"
  | "platform-difference"
  | "version-difference"
  | "value-representation"
  | "error-behavior";

export type ConstraintEvidence = {
  id: string;
  category: ConstraintCategory;
  /** Statement in the inventory's own words, not copied prose. */
  statement: string;
  /** Which tier the statement comes from. Never blended. */
  tier: "adobe-official" | "community-reference";
  publisher: string;
  authority: "primary" | "community-maintained";
  url: string;
  anchor: string;
  /** AE version scope when the source states one, else null. */
  aeVersionScope: string | null;
  /** OS scope when the source states one, else null. */
  osScope: string | null;
  /** True when the source does not state a version bound for this statement. */
  versionStated: boolean;
  /** Why this matters for a programmatic automation surface. */
  implication: string;
};

export type RealHostRequirement = {
  id: string;
  /** What a real host run would have to establish. */
  behaviour: string;
  category: ConstraintCategory;
  /** Why documentation cannot settle it. */
  whyDocumentationIsInsufficient: string;
  /** Which inventory surface is affected. */
  affects: string[];
  /** Explicit marker required by the issue. */
  evidenceRequired: "requires real host";
};

/**
 * Documented constraints. `sourceKey` resolves to a URL at build time; community
 * entries point at the pinned guide revision's page and anchor.
 */
export type ConstraintSpec = {
  id: string;
  category: ConstraintCategory;
  statement: string;
  tier: "adobe-official" | "community-reference";
  sourceKey: string;
  /** Page path or Adobe page key, resolved to a URL by the build. */
  page: string;
  anchorHeading: string | null;
  /** Substring that must appear in the cited block, or the build fails. */
  detector: RegExp;
  aeVersionScope: string | null;
  osScope: string | null;
  implication: string;
};

export const CONSTRAINTS: readonly ConstraintSpec[] = [
  // ---- ES3 language -------------------------------------------------------
  {
    id: "provisional.ae.constraint.es3-ecma262-3rd-edition",
    category: "es3-language",
    statement:
      "The AE scripting engine implements ECMA-262 3rd Edition and also implements E4X (ECMA-357).",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "introduction/overview",
    anchorHeading: "The ExtendScript language",
    detector: /3rd Edition of the ECMA-262 Standard/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Language features from ES5 and later (let/const, arrow functions, Array.prototype.map, JSON, getters) must not be assumed present in host-side script. A codec that transpiles to ES3 is required rather than optional.",
  },
  {
    id: "provisional.ae.constraint.es3-no-getter-setter",
    category: "es3-language",
    statement:
      "The documented keyword and operator tables describe only ES3 syntax; ES5+ statements are absent from the supported language surface.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "introduction/javascript",
    anchorHeading: "Keywords and Statement Syntax",
    detector: /Standard JavaScript; exit the currently executing loop/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Syntax support must be validated against the ES3 operator/keyword table, not against a generic JavaScript parser configured for an older target.",
  },
  {
    id: "provisional.ae.constraint.expression-engine-es2018-not-scripting",
    category: "es3-language",
    statement:
      "Adobe states the AE 16.0+ JavaScript *expression* engine is ECMAScript 2018 while the *legacy* expression engine is ECMAScript 3. This is a statement about the expression engine, not about the ExtendScript scripting engine.",
    tier: "adobe-official",
    sourceKey: "adobe-legacy-extendscript-engine",
    page: "adobe-legacy-extendscript-engine",
    anchorHeading: "Legacy ExtendScript engine is based on ECMAScript 3",
    detector: /JavaScript expression engine in After Effects 16\.0 is based on ECMAScript 2018/i,
    aeVersionScope: "16.0+ for the JavaScript expression engine",
    osScope: null,
    implication:
      "Do not infer that scripting gained ES2018 features. The two engines are separate and the ingestion path must not share a syntax assumption with the expression path.",
  },

  // ---- Host object lifetime ----------------------------------------------
  {
    id: "provisional.ae.constraint.script-globals-persist-per-session",
    category: "host-object-lifetime",
    statement:
      "Scripts share one global environment: variables and functions defined by a script persist into later scripts within the same AE session and are cleared when AE quits.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "introduction/javascript",
    anchorHeading: "Javascript Variables",
    detector: /persist in subsequent scripts during a given After Effects session/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Globals are a cross-call state channel. A dispatcher must reclaim or namespace its own globals every call, or a second call can observe a previous call's state.",
  },
  {
    id: "provisional.ae.constraint.collection-index-is-1-based",
    category: "host-object-lifetime",
    statement:
      "Collection indexing starts at 1, not 0, and collection membership updates automatically as objects are created or deleted.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "other/collection",
    anchorHeading: null,
    detector: /index numbering of a collection starts with 1/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "An index is a position, not an identity. Any handle scheme keyed on an index is invalidated by insertion, deletion or reordering.",
  },
  {
    id: "provisional.ae.constraint.base-only-class-instantof-caveat",
    category: "host-object-lifetime",
    statement:
      "Some classes exist only as base classes; `instanceof` against them either returns false or throws because the class name is undefined.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "introduction/classhierarchy",
    anchorHeading: "Symbol Legend",
    detector: /is always/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Type checks performed by an adapter must target the most specific class, and must tolerate undefined class names rather than assuming `instanceof` is total.",
  },

  // ---- Undo ---------------------------------------------------------------
  {
    id: "provisional.ae.constraint.undo-group-nesting",
    category: "undo",
    statement:
      "beginUndoGroup/endUndoGroup pairs nest; nested groups join the outer group and inner group names are discarded. An unmatched endUndoGroup is an error.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/application",
    anchorHeading: "app.beginUndoGroup()",
    detector: /pairs can be nested/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "A script that opens a group and fails before closing it changes the undo semantics of the whole session. Write operations need a finally-style close.",
  },
  {
    id: "provisional.ae.constraint.undo-group-auto-closes-at-script-end",
    category: "undo",
    statement:
      "If a script never calls endUndoGroup, the system closes the group automatically at the end of the script.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/application",
    anchorHeading: "app.endUndoGroup()",
    detector: /will close the undo group automatically/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Undo grouping is script-scoped by default, so splitting one logical operation across two script invocations creates two undo steps unless grouping spans them.",
  },
  {
    id: "provisional.ae.constraint.undo-purge-target-exists",
    category: "undo",
    statement:
      "The purge API exposes an UNDO_CACHES target, so undo history is a purgeable host resource.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/application",
    anchorHeading: "app.purge()",
    detector: /UNDO_CACHES/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Purging undo caches discards recovery state. It must never be used as a cleanup step after a failed mutation.",
  },

  // ---- AE UI --------------------------------------------------------------
  {
    id: "provisional.ae.constraint.suppress-dialogs-is-explicit-scope",
    category: "ae-ui",
    statement:
      "Error dialog suppression is explicitly begun and ended by the script; suppression does not extend beyond the call pair.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/application",
    anchorHeading: "app.beginSuppressDialogs()",
    detector: /Begins suppression of script error dialog boxes/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Headless execution depends on suppressing dialogs, but suppression covers error dialogs only. A modal panel or alert raised by a script is not covered by this pair.",
  },
  {
    id: "provisional.ae.constraint.scriptui-panel-is-dockable-ui",
    category: "ae-ui",
    statement:
      "Scripts in the ScriptUI Panels folder behave like dockable AE panels and appear at the bottom of the Window menu.",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /ScriptUI Panels folder are available from the bottom of the/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "A panel-based adapter runs inside the AE UI event loop. Blocking the UI thread from a panel is a user-visible failure mode, not a background stall.",
  },

  // ---- File permission ----------------------------------------------------
  {
    id: "provisional.ae.constraint.file-write-off-by-default",
    category: "file-permission",
    statement:
      "Scripts may not write files by default; a Scripting & Expressions preference must be enabled.",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /not allowed to write files/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "A file-transport bridge (write request, read result) fails closed on a default install. Permission state must be discovered and reported, not assumed.",
  },
  {
    id: "provisional.ae.constraint.network-off-by-default-same-switch",
    category: "network-permission",
    statement:
      "Network send/receive is disabled by default and is gated by the same single preference as file writing.",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /send or receive communication over a network/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "File and network permission cannot be requested independently. Enabling socket transport necessarily also enables file writes.",
  },

  // ---- Host lifecycle -----------------------------------------------------
  {
    id: "provisional.ae.constraint.esc-interrupts-running-script",
    category: "host-lifecycle",
    statement: "Pressing Esc stops a running script.",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /To stop a running script, press/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Any long host operation is interruptible by a human at any point, so a partial mutation is always reachable and cleanup cannot be assumed to run.",
  },
  {
    id: "provisional.ae.constraint.command-line-runs-in-existing-instance",
    category: "host-lifecycle",
    statement:
      "The documented command-line script invocation runs in the already-running AE instance instead of starting a new one.",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /does not open a new instance/i,
    aeVersionScope: null,
    osScope: "statement is OS-neutral; the example uses the Windows afterfx.exe path",
    implication:
      "Invoking a script from the command line does not isolate the run from a user's open project. Session ownership must be established separately.",
  },
  {
    id: "provisional.ae.constraint.adding-script-needs-restart",
    category: "host-lifecycle",
    statement:
      "A script added to the Scripts folder while AE is running needs an AE restart before it appears in the menu, though Run Script File works immediately.",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /must restart After Effects for the script to appear/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "Installing an adapter by copying it into the Scripts folder requires a restart cycle; loading it per-invocation avoids that lifecycle cost.",
  },

  // ---- Platform differences ----------------------------------------------
  {
    id: "provisional.ae.constraint.prefs-menu-path-differs-by-os",
    category: "platform-difference",
    statement:
      "The permission preference is reached through different menu paths on Windows (Edit > Preferences) and macOS (After Effects > Settings).",
    tier: "adobe-official",
    sourceKey: "adobe-scripts",
    page: "adobe-scripts",
    anchorHeading: "Load and run scripts",
    detector: /Scripting &(?:amp;)? Expressions/i,
    aeVersionScope: null,
    osScope: "macOS vs Windows menu paths",
    implication:
      "A guidance string for enabling permissions is OS-specific. A single message is wrong on one platform.",
  },
  {
    id: "provisional.ae.constraint.exit-after-launch-windows-only",
    category: "platform-difference",
    statement:
      "The exitAfterLaunchAndEval attribute only has an effect when AE is launched from the Windows command line and has no effect on Mac OS.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/application",
    anchorHeading: "app.exitAfterLaunchAndEval",
    detector: /It has no effect in Mac OS/i,
    aeVersionScope: null,
    osScope: "Windows only; explicitly no effect on Mac OS",
    implication:
      "Fire-and-exit behaviour is not portable. A launcher must not depend on this attribute to reap a headless run on macOS.",
  },
  {
    id: "provisional.ae.constraint.exit-code-channel-differs-by-os",
    category: "platform-difference",
    statement:
      "The exit code is returned on the Windows command line but as an AppleScript DoScript result on Mac OS.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/application",
    anchorHeading: "app.exitCode",
    detector: /AppleScript `DoScript` result/i,
    aeVersionScope: null,
    osScope: "Windows command line vs macOS AppleScript",
    implication:
      "Exit status is not a portable success channel. A result envelope must carry its own status rather than relying on process exit.",
  },
  {
    id: "provisional.ae.constraint.os-name-blank-on-modern-windows",
    category: "platform-difference",
    statement:
      "system.osName returns a blank value on Windows 7 and later; the guide directs scripts to $.os instead.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "general/system",
    anchorHeading: "System.osName",
    detector: /As of Windows 7, this attribute returns a blank value/i,
    aeVersionScope: null,
    osScope: "Windows 7 and later",
    implication:
      "OS detection must not trust system.osName. Host identity reported through this attribute is unreliable on modern Windows.",
  },

  // ---- Value representation ----------------------------------------------
  {
    id: "provisional.ae.constraint.property-value-kinds-are-typed",
    category: "value-representation",
    statement:
      "Property values are typed by PropertyValueType; spatial values are float arrays, colors are four floats, shapes and text documents are host objects.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "property/property",
    anchorHeading: "Property.propertyValueType",
    detector: /PropertyValueType\.TEXT_DOCUMENT/i,
    aeVersionScope: null,
    osScope: null,
    implication:
      "A generic JSON codec cannot round-trip every value: host objects such as Shape and TextDocument have no documented plain-data form, so they need per-type adapters or must be refused.",
  },
  {
    id: "provisional.ae.constraint.guide-enum-integers-differ-between-versions",
    category: "version-difference",
    statement:
      "The integer values behind guide orientationType and positionType differ between AE versions; scripts must compare against the named constants, not raw integers.",
    tier: "community-reference",
    sourceKey: "dfad",
    page: "other/guideoptions",
    anchorHeading: "GuideOrientationType",
    detector: /underlying integer values differ between versions/i,
    aeVersionScope: "changed at 26.5; prior versions expose plain integers",
    osScope: null,
    implication:
      "An enum wire encoding that serialises the integer rather than the name is not stable across AE versions. Enum values must travel as names.",
  },
];

/**
 * Behaviours that a running host must settle (CAP008).
 *
 * Nothing here was executed. The point of the list is that a reader can see exactly
 * which statements this issue does NOT make, instead of inferring support from the
 * presence of a symbol in the inventory.
 */
export const REAL_HOST_REQUIREMENTS: readonly RealHostRequirement[] = [
  {
    id: "provisional.ae.realhost.member-exists-on-build",
    behaviour:
      "Each inventoried member is actually present on the named AE build (26.5.3 and 27.0.0), which the documentation alone cannot establish for a specific install.",
    category: "version-difference",
    whyDocumentationIsInsufficient:
      "The community guide describes a rolling current state and is not versioned per AE build. Adobe publishes no per-build member list, so presence on a specific build is only observable in that build.",
    affects: ["all scripting members"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.object-identity-across-calls",
    behaviour:
      "Whether a host object obtained in one script invocation still designates the same underlying entity in a later invocation, and how that identity fails after undo, redo, layer reorder, item deletion or project close.",
    category: "host-object-lifetime",
    whyDocumentationIsInsufficient:
      "The guide documents that indices shift and that collections update automatically, but states no contract for reference survival across script boundaries.",
    affects: ["Item", "Layer", "Property", "RenderQueueItem", "CompItem"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.stale-handle-error-shape",
    behaviour:
      "The exact error type, message and recoverability produced when a stale or invalid host object is used.",
    category: "error-behavior",
    whyDocumentationIsInsufficient:
      "No enumerated error taxonomy is published for stale handles; the guide describes behaviours anecdotally per method.",
    affects: ["all object-returning members"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.undo-step-cardinality",
    behaviour:
      "How many undo steps a given multi-mutation script produces, and whether an interrupted script leaves a partially applied but undoable state.",
    category: "undo",
    whyDocumentationIsInsufficient:
      "Grouping rules are documented, but the resulting step count per operation and behaviour under Esc interruption are runtime facts.",
    affects: ["write operations", "app.beginUndoGroup", "app.endUndoGroup"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.dialog-blocking-under-automation",
    behaviour:
      "Which host operations raise a modal dialog or panel that beginSuppressDialogs does not suppress, and whether such a dialog blocks a non-interactive run indefinitely.",
    category: "ae-ui",
    whyDocumentationIsInsufficient:
      "Documented suppression covers script error dialogs only; the set of other modals is not enumerated anywhere.",
    affects: ["render", "import", "save", "preferences", "app.open"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.permission-preference-default-state",
    behaviour:
      "The actual default state of the file-write/network permission preference on a fresh install of each target build, and whether the state is readable from script.",
    category: "file-permission",
    whyDocumentationIsInsufficient:
      "Adobe documents that the default denies writes; it does not document a scripting API that reads the current state, nor installation-time variation.",
    affects: ["File", "Folder", "Socket", "any output path"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.locale-value-formatting",
    behaviour:
      "How numeric, time and enumerated values are stringified under a non-English UI language, and whether match-name lookup is locale-independent.",
    category: "value-representation",
    whyDocumentationIsInsufficient:
      "The guide gives English display names and documents match names as the stable identifier, but does not state locale behaviour for value conversion or error text.",
    affects: ["Property.value", "TextDocument", "time formatting", "match-name lookup"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.render-completion-signal",
    behaviour:
      "Whether a render launched from script signals completion synchronously, and what a caller observes if AE is busy or the render is cancelled.",
    category: "host-lifecycle",
    whyDocumentationIsInsufficient:
      "Render queue objects are documented as data; the completion and cancellation signalling contract for a script caller is not.",
    affects: ["RenderQueue", "RenderQueueItem", "OutputModule"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.expression-engine-selection-effect",
    behaviour:
      "Which engine actually evaluates an existing project's expressions after project.expressionEngine is changed, and whether stored expressions are migrated or reinterpreted.",
    category: "version-difference",
    whyDocumentationIsInsufficient:
      "Adobe documents that two engines exist and differ in ECMAScript level, but not the migration semantics for stored expression text.",
    affects: ["Project.expressionEngine", "expression-enabled properties"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.globals-collision-across-scripts",
    behaviour:
      "Whether two independently authored scripts that define the same global name interfere, and whether a dispatcher can reliably observe and clear globals it did not create.",
    category: "host-object-lifetime",
    whyDocumentationIsInsufficient:
      "The guide warns that globals persist per session and advises unique names; it gives no isolation or enumeration contract.",
    affects: ["all scripts sharing one AE session"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.interrupt-partial-write-state",
    behaviour:
      "What state a project is left in when Esc interrupts a script midway through a multi-step mutation, and whether the partial state is saved, dirty, or rolled back.",
    category: "undo",
    whyDocumentationIsInsufficient:
      "Esc is documented as a stop mechanism, but no transactional guarantee is stated.",
    affects: ["write operations", "Project.save"],
    evidenceRequired: "requires real host",
  },
  {
    id: "provisional.ae.realhost.parameter-value-range-enforcement",
    behaviour:
      "Whether documented parameter ranges are enforced by the host or silently clamped, and which error surfaces when out of range.",
    category: "error-behavior",
    whyDocumentationIsInsufficient:
      "The guide states ranges as documentation of intent; enforcement location and failure mode are not specified per method.",
    affects: ["methods with documented ranges"],
    evidenceRequired: "requires real host",
  },
];
