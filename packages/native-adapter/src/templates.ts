/**
 * Adapter kit template renderer — CAP046 (Issue #19), updated for the
 * class-vs-operation split.
 *
 * Produces one `kit.md` per coverage-matrix **class** under
 * `templates/<class>/`. A kit is a *reporting* artefact: it records
 * the class's matrix status verbatim (`state`, `implemented`,
 * `verifiedOnRealHost`, symbol count, release) and explains that the
 * class itself is never dispatchable — dispatchability lives per
 * operation entry in `src/operations.ts`. Kits are generated, not
 * hand-edited: `bun run render` regenerates them and `bun run verify`
 * fails on drift.
 *
 * These are contract-level templates. Nothing here compiles a plug-in,
 * launches AE, or claims real-host behaviour.
 */

import {
  MATRIX_CLASSES,
  matrixClassRow,
  type CoverageMatrix,
  type MatrixClass,
} from "./matrix.ts";

export type RenderedFile = { path: string; content: string };

const RESULT_STATES = ["not-sent", "refused", "completed", "failed", "unknown"] as const;

function statusBanner(matrix: CoverageMatrix, cls: MatrixClass): string {
  const row = matrixClassRow(matrix, cls);
  const evidence = matrix.evidenceLevel ?? {};
  return [
    `> **Coverage-matrix class: \`${cls}\` — reporting metadata only, never dispatchable.** State=\`${row?.state ?? "unknown"}\`, implemented=\`${row?.implemented ?? false}\`, verifiedOnRealHost=\`${row?.verifiedOnRealHost ?? false}\`, symbols=${row?.symbols ?? 0}.`,
    `> Source: \`inventories/sdk/generated/aggregate.coverage-matrix.json\` (schema \`${matrix.schema}\`, SDK release ${matrix.release.identifier} ${matrix.release.distribution}).`,
    `> Evidence level — inventory: \`${evidence.inventory ?? "unknown"}\`, verification: \`${evidence.verification ?? "unknown"}\`, realHost: \`${evidence.realHost ?? "unknown"}\`.`,
    `> ${row?.note ?? "no coverage-matrix note for this class"}`,
  ].join("\n");
}

function stateGuidance(state: string): string {
  switch (state) {
    case "build-probe-only":
      return [
        "SDK sample projects compile on this build host (macOS arm64); plug-in **load and execution inside After Effects are UNVERIFIED**. Build-test templates below exercise the compile path only. Do not report load/execution evidence from a successful build.",
      ].join("\n");
    case "inventory-only":
      return [
        "Symbols in this class are **structurally attributed from headers only**. No adapter exists and no real-host dispatch evidence exists. The command/fixture templates below are contract shapes for *future per-operation entries*: a class row can never be dispatched — only concrete operation ids in `src/operations.ts` can, and only when the registry marks them `implemented && verifiedOnRealHost`.",
      ].join("\n");
    case "unsupported-or-unknown":
      return [
        "The extractor could not attribute these symbols to a call direction. They remain in the denominator and require per-cluster review (CAP047 child Issues) before any adapter work. The template below is a **refusal/waiver record**, not a command contract — do not invent operations for this class.",
      ].join("\n");
    default:
      return [
        "This class carries no dispatchable state of its own. Dispatchability is defined per operation entry (`src/operations.ts`), each requiring `implemented && verifiedOnRealHost` before a host may advertise `dispatchable`.",
      ].join("\n");
  }
}

function commandTemplate(cls: MatrixClass, state: string): string {
  if (state === "unsupported-or-unknown") {
    return [
      "### Adapter command — refusal/waiver record (FR-013)",
      "",
      "This class has no command contract. An implementer records a per-cluster",
      "decision instead:",
      "",
      "```json",
      "{",
      `  "matrixClass": "${cls}",`,
      '  "decision": "unsupported | deferred-to-issue | waived",',
      '  "rationale": "<technical basis from inventories/sdk/constraints.md or header evidence>",',
      '  "reevaluationCondition": "<what would change the decision, e.g. new SDK release, CAP047 review>",',
      '  "followUpIssue": "<issue URL or number; required before exclusion from supported coverage>",',
      '  "matrixState": "unsupported-or-unknown"',
      "}",
      "```",
      "",
      "An explicit waiver or follow-up issue is required before this class is",
      "excluded from supported coverage (spec FR-013).",
    ].join("\n");
  }
  return [
    "### Adapter command envelope (template)",
    "",
    "Dispatch is per **operation id** (`\"<Suite>.<member>\"`), never per",
    "matrix class. Operation ids come from the committed registry in",
    "`src/operations.ts`; a class name here is malformed.",
    "",
    "```json",
    "{",
    '  "commandId": "<uuid, unique per dispatch>",',
    '  "operation": "<operation id from src/operations.ts; never an invented remote name>",',
    '  "params": {},',
    '  "deadlineMs": 30000',
    "}",
    "```",
    "",
    `Result states are exactly: ${RESULT_STATES.map((s) => `\`${s}\``).join(", ")}.`,
    "A timeout after possible dispatch is `unknown` and is never retried.",
    "Negotiation precondition: `negotiate()` in `src/negotiate.ts` must return",
    "`compatible` for this **operation** at an acceptable state before any",
    "command is sent. A compatible negotiation is not dispatch authorization —",
    "the capability-catalog per-capability gate still applies.",
  ].join("\n");
}

function fixtureTemplate(cls: MatrixClass, state: string): string {
  if (state === "unsupported-or-unknown") {
    return [
      "### Fixture — N/A",
      "",
      "No fixture may be authored for this class until CAP047 review assigns",
      "its symbols to concrete operation entries. A fixture here would",
      "fabricate coverage.",
    ].join("\n");
  }
  return [
    "### Fixture template",
    "",
    "```json",
    "{",
    '  "fixtureId": "<stable id>",',
    `  "matrixClass": "${cls}",`,
    '  "operations": ["<operation ids under test>"],',
    '  "sdkRelease": { "identifier": "<e.g. 26.5>", "distribution": "<e.g. macOS>" },',
    `  "matrixState": "${state}",`,
    '  "preconditions": ["<owned or explicitly-attached AE session>", "<negotiation compatible for each operation>"],',
    '  "steps": ["<ordered adapter commands>"],',
    '  "expected": { "resultState": "<one of the result states>", "evidence": "<artifact paths>" },',
    '  "evidenceLevel": "unverified"',
    "}",
    "```",
    "",
    "`evidenceLevel` must be promoted only by real recorded runs; a fixture",
    "that has never executed stays `unverified`.",
  ].join("\n");
}

function buildTestTemplate(cls: MatrixClass, state: string): string {
  if (state === "unsupported-or-unknown") {
    return [
      "### Build-test — N/A",
      "",
      "No build-test path exists for this class. Building or loading",
      "anything here would assert coverage the matrix does not have.",
    ].join("\n");
  }
  const loadProof =
    cls === "build-test-lifecycle"
      ? "For the concrete compile probe see `experiments/native-sdk/build-macos.sh`\n(Sweetie = AEGP, Checkout = Effect/CPU, minimal-plugin = NativeProbe)\nand the gated load procedure in\n`experiments/native-sdk/LOAD-PROOF.md`."
      : "There is no build/load path for this class yet; the load-proof\nprocedure in `experiments/native-sdk/LOAD-PROOF.md` is the template to\nfollow once per-operation adapters exist.";
  return [
    "### Build-test template",
    "",
    "1. **Build**: compile the plug-in/adapter against the exact SDK release",
    "   advertised by negotiation (`sdkRelease` must match; mismatch refuses).",
    `2. **Load proof**: follow \`experiments/native-sdk/LOAD-PROOF.md\` —\n   owned/dedicated AE session only; no implicit attach or quit.`,
    "3. **Execute**: run the fixture steps; record result state, trace and",
    "   artifacts per run.",
    "4. **Record**: update evidence level honestly — compile success is",
    "   `build-probe-only`, never load/execution evidence.",
    "",
    loadProof,
  ].join("\n");
}

const CONCRETE_EXAMPLE = `## Concrete example — Sweetie/Checkout/NativeProbe build probe

Tied to \`experiments/native-sdk/\` (Issue #17 groundwork, CAP037/CAP038):

- \`build-macos.sh\` compiles SDK samples with xcodebuild on macOS arm64:
  - **Sweetie** — AEGP plug-in sample (external-command class surface)
  - **Checkout** — Effect/CPU plug-in sample (in-host-plugin-command surface)
- \`minimal-plugin/build.sh\` builds **NativeProbe**, our own read-only
  AEGP plug-in (\`src/probe.cpp\`); its 21 AEGP/SPBasicSuite calls are the
  committed per-operation entries in \`src/operations.ts\` — all
  \`implemented-unverified\`, none dispatchable.
- \`EVIDENCE.md\` records BUILD SUCCEEDED for all three; \`Effect/SDK_Invert_ProcAmp\`
  (GPU) BUILD FAILED — \`metal_common\` and Boost headers absent.
- \`LOAD-PROOF.md\` is the gated procedure for real-AE load proof; it has
  **not been run** — load/execution remain UNVERIFIED.

A build-test fixture for this class starts from
\`templates/build-test-lifecycle/fixture.sweetie-checkout.json\`.
`;

/** Render the kit for one coverage-matrix class (reporting only). */
export function renderKit(matrix: CoverageMatrix, cls: MatrixClass): string {
  const row = matrixClassRow(matrix, cls);
  const state = row?.state ?? "unknown";
  const parts = [
    `# Native adapter kit — \`${cls}\` (coverage-matrix class)`,
    "",
    "<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->",
    "",
    statusBanner(matrix, cls),
    "",
    "> This kit documents a **reporting class**, not a capability. No",
    "> matrix class is dispatchable; only per-operation entries in",
    "> `src/operations.ts` can be negotiated, and only with",
    "> `implemented && verifiedOnRealHost` evidence.",
    "",
    "## What this status permits",
    "",
    stateGuidance(state),
    "",
    "## 1. Adapter command",
    "",
    commandTemplate(cls, state),
    "",
    "## 2. Fixture",
    "",
    fixtureTemplate(cls, state),
    "",
    "## 3. Build-test",
    "",
    buildTestTemplate(cls, state),
  ];
  if (cls === "build-test-lifecycle") {
    parts.push("", CONCRETE_EXAMPLE);
  }
  parts.push("");
  return parts.join("\n");
}

/** All generated files for the current matrix. */
export function renderAllTemplates(matrix: CoverageMatrix): RenderedFile[] {
  return MATRIX_CLASSES.map((cls) => ({
    path: `templates/${cls}/kit.md`,
    content: renderKit(matrix, cls),
  }));
}
