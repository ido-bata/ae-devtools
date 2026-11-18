# dev-loop

Developer-loop core for `@ido-bata/ae-devtools-cli` (Issue #20): the thin
orchestration layer that VSCode commands and MCP tools wrap. It adds **no
permission path** — `execute`/`verify` delegate to
`scripting-adapters/execute.mjs` `runOperation()`, the only dispatch path
(consent scope, required consentProvider, confirm gates, trusted runner,
quarantine).

## Public surface

| Function | Contract |
| --- | --- |
| `discover({ domain? })` | Registry ops with honest metadata. Unimplemented inventory members are NOT listed as executable. Returned `args` arrays are copies — mutating them cannot corrupt the registry. |
| `inspect(opId)` | Operation schema/metadata. Never executes. Unknown id → `{ status: "unknown-operation" }`. |
| `execute(input)` | Dispatch via `runOperation`. `null`/missing input produces the structured `UNKNOWN_OPERATION` refusal, never a TypeError. |
| `verify(input)` | Post-execution read-back (default `read.projectSummary`, or any registered read-only `readOpId`). **Verification never infers success from the write outcome** — it reports host-observed state only. Refusals use the canonical `{status:"refused", stage, reason, detail}` shape. |

## Evidence level

`fake/mock only` until an owned AE session runs the conformance suite —
see the package README and `scripting-adapters/README.md`.

## Session lifecycle helpers

- `session-open.mjs` — the single fake/a8n session-kind dispatch shared
  by CLI, MCP and VSCode (ADR-0016).
- `session-close.mjs` — bounded `session.close()` shared by all
  surfaces.
- `surface-guard.mjs` — run-guard residue markers for non-CLI surfaces
  (Issue #198). MCP/VSCode **a8n** sessions write
  `ae-devtools.cli.run-guard/v1` markers (`surface: "mcp"|"vscode"`)
  into the shared runs dir so a crashed/killed server leaves
  attributable residue. Markers carry **no** `session.process`
  attestation — the a8n slice handle is stripped upstream — so
  `reap`/recovery `authorizeRecovery` still refuse them (fail-closed).
  Fake sessions record nothing (no AE residue is possible).
