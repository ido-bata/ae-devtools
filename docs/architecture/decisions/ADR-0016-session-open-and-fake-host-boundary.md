# ADR-0016 — Shared Session-Open Contract and Fake-Host Boundary

> Status: **Proposed** (2026-11-18). Records the session-opener
> consolidation delivered under Issue #183 and fixes the ownership
> boundary between the two fake AE hosts and the two consent layers.

---

## Status

**Proposed.** The code structure described here is implemented
(`dev-loop/session-open.mjs`, consumers migrated); promotion to
Accepted follows the usual evidence bar — the boundary statements are
the durable part, not the file layout.

---

## Context

The system-quality review for the post-0.3.0 release found three
responsibility questions that were answered only implicitly in code:

1. `openSession`-equivalent logic existed twice — `devtools-cli/cli.mjs`
   (with CLI-only recovery attestation) and `mcp-server/session.mjs`
   (reused by `vscode-extension/controller.mjs`). The fake/a8n kind
   dispatch, the `A8N_TRANSPORT_MISSING` refusal and the dynamic
   `openSliceSession` import could drift per surface.
2. Two fake AE hosts exist —
   `scripting-adapters/fake-host.mjs` + `fake-app.mjs` and
   `agent-loop/fake-host.mjs` — with no recorded statement of whether
   they are duplicates to converge or distinct contracts.
3. Consent is checked twice on the VSCode path: a UI pre-gate in
   `vscode-extension/controller.mjs` and the core gate
   (`authorizeExecution` / `consentScopeFor` in
   `trusted-execution/permissions.mjs`). Which layer is the source of
   truth for consent *semantics* was undocumented.

---

## Decision

### 1. One session-kind dispatch: `dev-loop/session-open.mjs`

- `openSession(kind, { aeA8nRoot, installDir })` in
  `dev-loop/session-open.mjs` is the single implementation of the
  session-kind decision for every dev-loop surface.
- It returns the common session shape
  `{ kind, evidenceLevel, runner, pin, close, meta, slice }`.
  `slice` is the raw `openSliceSession` result (a8n) or `null` (fake)
  and is **internal**: surfaces that serialize sessions (MCP tool
  payloads, VSCode controller results) must strip it.
- `devtools-cli/cli.mjs` consumes `slice` to build its CLI-only
  recovery attestation (`processEvidence` / `attestation` for the run
  marker). `mcp-server/session.mjs` delegates and strips `slice`;
  `vscode-extension/controller.mjs` inherits the same contract through
  it unchanged.
- Surfaces must not re-implement the kind dispatch, the
  `A8N_TRANSPORT_MISSING` check, or the `openSliceSession` call.

### 2. Two fake hosts, two contracts — not duplicates

- `scripting-adapters/fake-host.mjs` + `fake-app.mjs` is the
  **codec-faithful adapter transport**: it executes *generated adapter
  sources* inside `node:vm` against `createAdapterFakeApp`, carries the
  trusted-codec envelope contract, and backs the dev-loop tests, the
  CLI fake session and therefore the MCP/VSCode fake sessions. Its
  evidence claim is "wiring is correct", nothing more.
- `agent-loop/fake-host.mjs` is the **probe evaluator** for the
  agent-loop E2E fixture (Issue #38): it runs caller-supplied probe
  sources with a caller-supplied `app` stub so ordinary JavaScript
  errors carry real stack positions for source-map regression checks.
  It does not implement the adapter app or the codec envelope.
- They are **not** consolidated: merging them would force one contract
  to serve two evidence purposes. Any future third fake host must
  declare which contract it implements. Both remain fake/mock evidence
  only — neither may be cited as real-host verification.

### 3. Consent semantics SoT: `trusted-execution/permissions.mjs`

- `authorizeExecution` + `consentScopeFor` are the **only** authority
  on consent *semantics* (execution class, consent scope equality,
  opt-in requirements). Every dispatch path — CLI, MCP, VSCode —
  reaches it through `trusted-execution/runner.mjs`.
- UI pre-gates (VSCode controller confirmations, CLI `--consent`
  flag, MCP consent argument) are **UX/policy layers** that decide
  whether to *present* consent; they never weaken or replace the core
  gate. A pre-gate approving something the core refuses still refuses;
  a pre-gate denying something is a UX decision, not a security one.
- New surfaces must not add a third consent implementation; they may
  only add presentation-layer checks documented as such.

---

## Consequences

- Session-open behavior (missing transport, unknown kind, fake/a8n
  selection) is identical on CLI, MCP and VSCode by construction.
- The run-marker **attestation** stays CLI-owned; MCP/VSCode sessions
  do not gain recovery-marker fields they do not use. Since Issue #198
  they DO write residue markers (see Addendum below) — visibility
  without authority.
- Fake-host consolidation, if ever wanted, is a public-API change
  (both modules are packaged exports' dependencies) and requires a
  deprecation/migration path — not a silent merge.
- Consent-rule changes land in `permissions.mjs` once and apply to all
  surfaces; surface tests must not encode divergent consent semantics.

---

## Addendum — run-guard residue markers on MCP/VSCode (Issue #198)

The consequence above originally read as "MCP/VSCode write no run
markers at all". Issue #198 adopted design **案 C** (marker recording
only): `dev-loop/surface-guard.mjs` wraps the shared
`devtools-cli/session-guard.mjs` lifecycle for the two non-CLI
surfaces.

- `--session a8n` MCP servers and VSCode controllers write
  `ae-devtools.cli.run-guard/v1` markers with an honest `surface` label
  (`"mcp"` / `"vscode"`) into the same runs dir the CLI's
  `runs`/`doctor`/`reap` already read — a SIGKILLed or crashed surface
  now leaves attributable residue instead of an invisible orphaned AE.
- Request lifecycle events (`dispatched`/`resolved`/`timeout`) are
  recorded at the surfaces' natural request boundary: the `req-mcp-N`
  dispatch requestId minted in `mcp-server/tools.mjs` (shared by the
  VSCode controller, which delegates to `callTool`).
- **Attestation is unchanged and CLI-only.** `mcp-server/session.mjs`
  still strips the a8n `slice` handle, so `session.process`
  (aePid/guiSession/`recoveryTarget()` attestation) is never recorded
  on these surfaces. `reapRun` and `authorizeRecovery` therefore keep
  refusing MCP/VSCode markers — `NO_A8N_ATTESTATION` — preserving the
  fail-closed boundary. Only the ownership *kind* string reported via
  `session.meta` is recorded, as a bare claim with no evidence.
- Fake sessions write no marker: they launch no AE and can leave no
  host residue.
- Rejected alternative (案 B): re-exposing the slice for attestation
  was deferred — it would make MCP/VSCode runs recoverable and force a
  per-surface ownership/attribution design whose cost outweighs the
  residue-visibility benefit.
