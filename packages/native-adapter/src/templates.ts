/**
 * Adapter kit template renderer — CAP046 (Issue #19).
 *
 * Produces one `kit.md` per coverage-matrix class under
 * `templates/<class>/`. Every kit carries the class's matrix status
 * verbatim (`state`, `implemented`, `verifiedOnRealHost`, symbol
 * count, release) so an implementer can never mistake an
 * inventory-only family for a callable one. Kits are generated, not
 * hand-edited: `bun run render` regenerates them and `bun run verify`
 * fails on drift.
 *
 * These are contract-level templates. Nothing here compiles a plug-in,
 * launches AE, or claims real-host behaviour.
 */

import {
  SUITE_FAMILIES,
  familyAvailability,
  type CoverageMatrix,
  type SuiteFamily,
} from "./matrix.ts";

export type RenderedFile = { path: string; content: string };

const RESULT_STATES = ["not-sent", "refused", "completed", "failed", "unknown"] as const;

function statusBanner(matrix: CoverageMatrix, family: SuiteFamily): string {
  const row = matrix.classes[family];
  const { state } = familyAvailability(matrix, family);
  const evidence = matrix.evidenceLevel ?? {};
  return [
    `> **Coverage-matrix status: \`${state}\`** — implemented=\`${row?.implemented ?? false}\`, verifiedOnRealHost=\`${row?.verifiedOnRealHost ?? false}\`, symbols=${row?.symbols ?? 0}.`,
    `> Source: \`inventories/sdk/generated/aggregate.coverage-matrix.json\` (schema \`${matrix.schema}\`, SDK release ${matrix.release.identifier} ${matrix.release.distribution}).`,
    `> Evidence level — inventory: \`${evidence.inventory ?? "unknown"}\`, verification: \`${evidence.verification ?? "unknown"}\`, realHost: \`${evidence.realHost ?? "unknown"}\`.`,
    `> ${row?.note ?? "no coverage-matrix note for this class"}`,
  ].join("\n");
}

function stateGuidance(state: string): string {
  switch (state) {
    case "dispatchable":
      return [
        "This family is the only state negotiation accepts by default. Even so, `dispatchable` is a *negotiation* state, not an authorization: per-capability dispatch still passes through the capability-catalog `assertDispatchAllowed` gate, and real-host evidence requirements are unchanged.",
      ].join("\n");
    case "build-probe-only":
      return [
        "SDK sample projects compile on this build host (macOS arm64); plug-in **load and execution inside After Effects are UNVERIFIED**. Build-test templates below exercise the compile path only. Do not report load/execution evidence from a successful build.",
      ].join("\n");
    case "inventory-only":
      return [
        "Symbols in this family are **structurally attributed from headers only**. No adapter exists and no real-host dispatch evidence exists. The command/fixture templates below are contract shapes for a *future* adapter: filling them in does not make this family callable, and negotiation will refuse it unless the client explicitly widens `acceptableStates` for non-dispatch use (e.g. inspection).",
      ].join("\n");
    default:
      return [
        "The extractor could not attribute these symbols to a call direction. They remain in the denominator and require per-family review (CAP047) before any adapter work. The template below is a **refusal/waiver record**, not a command contract — do not invent operations for this family.",
      ].join("\n");
  }
}

function commandTemplate(family: SuiteFamily, state: string): string {
  if (state === "unsupported-or-unknown") {
    return [
      "### Adapter command — refusal/waiver record (FR-013)",
      "",
      "This family has no command contract. An implementer records a per-family",
      "decision instead:",
      "",
      "```json",
      "{",
      `  "family": "${family}",`,
      '  "decision": "unsupported | deferred-to-issue | waived",',
      '  "rationale": "<technical basis from inventories/sdk/constraints.md or header evidence>",',
      '  "reevaluationCondition": "<what would change the decision, e.g. new SDK release, CAP047 review>",',
      '  "followUpIssue": "<issue URL or number; required before exclusion from supported coverage>",',
      '  "matrixState": "unsupported-or-unknown"',
      "}",
      "```",
      "",
      "An explicit waiver or follow-up issue is required before this family is",
      "excluded from supported coverage (spec FR-013).",
    ].join("\n");
  }
  return [
    "### Adapter command envelope (template)",
    "",
    "```json",
    "{",
    '  "commandId": "<uuid, unique per dispatch>",',
    `  "family": "${family}",`,
    '  "operation": "<suite-or-selector name from the inventory; never an invented remote name>",',
    '  "params": {},',
    '  "deadlineMs": 30000',
    "}",
    "```",
    "",
    `Result states are exactly: ${RESULT_STATES.map((s) => `\`${s}\``).join(", ")}.`,
    "A timeout after possible dispatch is `unknown` and is never retried.",
    "Negotiation precondition: `negotiate()` in `src/negotiate.ts` must return",
    "`compatible` for this family at an acceptable state before any command is",
    "sent. A compatible negotiation is not dispatch authorization — the",
    "capability-catalog per-capability gate still applies.",
  ].join("\n");
}

function fixtureTemplate(family: SuiteFamily, state: string): string {
  if (state === "unsupported-or-unknown") {
    return [
      "### Fixture — N/A",
      "",
      "No fixture may be authored for this family until CAP047 review assigns",
      "it a concrete class. A fixture here would fabricate coverage.",
    ].join("\n");
  }
  return [
    "### Fixture template",
    "",
    "```json",
    "{",
    '  "fixtureId": "<stable id>",',
    `  "family": "${family}",`,
    '  "sdkRelease": { "identifier": "<e.g. 26.5>", "distribution": "<e.g. macOS>" },',
    `  "matrixState": "${state}",`,
    '  "preconditions": ["<owned or explicitly-attached AE session>", "<negotiation compatible>"],',
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

function buildTestTemplate(family: SuiteFamily, state: string): string {
  if (state === "unsupported-or-unknown") {
    return [
      "### Build-test — N/A",
      "",
      "No build-test path exists for this family. Building or loading",
      "anything here would assert coverage the matrix does not have.",
    ].join("\n");
  }
  const loadProof =
    family === "build-test-lifecycle"
      ? "For the concrete compile probe see `experiments/native-sdk/build-macos.sh`\n(Sweetie = AEGP, Checkout = Effect/CPU) and the gated load procedure in\n`experiments/native-sdk/LOAD-PROOF.md`."
      : "There is no build/load path for this family yet; the load-proof\nprocedure in `experiments/native-sdk/LOAD-PROOF.md` is the template to\nfollow once an adapter exists.";
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

const CONCRETE_EXAMPLE = `## Concrete example — Sweetie/Checkout build probe

Tied to \`experiments/native-sdk/\` (Issue #17 groundwork, CAP037):

- \`build-macos.sh\` compiles two SDK samples with xcodebuild on macOS arm64:
  - **Sweetie** — AEGP plug-in sample (external-command family surface)
  - **Checkout** — Effect/CPU plug-in sample (in-host-plugin-command surface)
- \`EVIDENCE.md\` records BUILD SUCCEEDED for both; \`Effect/SDK_Invert_ProcAmp\`
  (GPU) BUILD FAILED — \`metal_common\` and Boost headers absent.
- \`LOAD-PROOF.md\` is the gated procedure for real-AE load proof; it has
  **not been run** — load/execution remain UNVERIFIED.

A build-test fixture for this family starts from
\`templates/build-test-lifecycle/fixture.sweetie-checkout.json\`.
`;

/** Render the kit for one coverage-matrix class. */
export function renderKit(matrix: CoverageMatrix, family: SuiteFamily): string {
  const { state } = familyAvailability(matrix, family);
  const parts = [
    `# Native adapter kit — \`${family}\``,
    "",
    "<!-- GENERATED FILE — do not edit. Regenerate: cd packages/native-adapter && bun run render -->",
    "",
    statusBanner(matrix, family),
    "",
    "## What this status permits",
    "",
    stateGuidance(state),
    "",
    "## 1. Adapter command",
    "",
    commandTemplate(family, state),
    "",
    "## 2. Fixture",
    "",
    fixtureTemplate(family, state),
    "",
    "## 3. Build-test",
    "",
    buildTestTemplate(family, state),
  ];
  if (family === "build-test-lifecycle") {
    parts.push("", CONCRETE_EXAMPLE);
  }
  parts.push("");
  return parts.join("\n");
}

/** All generated files for the current matrix. */
export function renderAllTemplates(matrix: CoverageMatrix): RenderedFile[] {
  return SUITE_FAMILIES.map((family) => ({
    path: `templates/${family}/kit.md`,
    content: renderKit(matrix, family),
  }));
}
