# vscode-extension — VSCode dev-loop surface (Issues #152/#153, CAP050 slices 1–2)

Thin VSCode wrapper over the **same** dev-loop core the MCP server and
CLI use. It adds no dispatch path and no permission path of its own:

- `controller.mjs` — vscode-free logic, unit-tested with `node:test`
  against the codec-faithful fake session.
- `diagnostics.mjs` — `ae-devtools.diagnostics/v1` records → Problems-panel
  publish plan (Issue #153): severity mapping, sourcemap-resolved
  original-TS positions via `diagnostics/source-map.mjs`, honest
  `no-position`/`no-map`/`unmapped` handling (positions are never
  fabricated), and collectors for execute outcomes
  (`fromAeError`/`fromTransportOutcome`) and agent-loop reports.
- `extension.mjs` — activation entry; adapts `vscode` UI (input boxes,
  modal confirms, information messages) to the controller's injected
  `ui` surface, and publishes diagnostics plans to the Problems panel.
- `package.json` — VSCode extension manifest (`main`, `engines`,
  contributed commands + `ae-devtools.*` configuration).

## Commands

| Command | Maps to | Consent |
| --- | --- | --- |
| `ae-devtools.discover` | `devloop.discover()` | none — registry metadata, never opens a session |
| `ae-devtools.inspect` | `devloop.inspect(opId)` | none — metadata only, never executes |
| `ae-devtools.execute` | `devloop.execute()` → `runOperation()` | modal confirms for destructive / render ops, then explicit consent → forwarded as `consent:"grant"` + confirm flags to the canonical gates. Failure outcomes emit a diagnostics publish plan → Problems panel |
| `ae-devtools.verify` | `devloop.verify()` | explicit consent → `consent:"grant"`; read-back reports host-observed state only; same diagnostics collection |

Every result surfaces `session.evidenceLevel` verbatim — fake/mock
results are never presented as real-host verification.

## Sessions

`ae-devtools.session` setting: `fake` (default, codec-faithful mock)
or `a8n` (owned AE session via `ae-a8n`; set `ae-devtools.aeA8nRoot`,
optional `ae-devtools.installDir`). The session is opened lazily on the
first consented execute/verify and shared for the extension lifetime.

## Safety contract (unchanged from MCP/CLI)

- UI confirmation is collected in the extension layer and forwarded as
  `consent:"grant"`; the core consent scope, `confirmDestructive` /
  `confirmRender` gates, trusted runner and UNKNOWN quarantine in
  `runOperation` are untouched.
- A declined confirmation is a structured `DECLINED_BY_USER` refusal
  and the session is never opened.
- UNKNOWN outcomes are never retried.

## Tests

```sh
node tests/run.mjs
```

Covers discover/inspect metadata, consent default-deny at the UI gate,
destructive/render confirm ordering, execute→verify on the fake host,
and session lifecycle, plus the diagnostics publish plan (mapped /
unmapped / no-position / no-map records, execute-outcome and
loop-report collectors, controller-attached plans). **Fake/mock level
only** — real AE acceptance is a release-candidate item
(Issues #152/#153 verification level).

## Packaging status

The manifest is VSCode-ready (`engines.vscode ^1.102.0`, ESM entry).
`vsce package` / install verification is tracked under the release
distribution work (#143 lane) — this directory ships inside the
`@ido-bata/ae-devtools-cli` tarball via the parent `files` list.
