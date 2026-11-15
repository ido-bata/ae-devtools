# vscode-debugger — VSCode `extendscript-debug` integration (Issue #53)

Generates and contract-validates `.vscode/launch.json` configurations for
Adobe's official **ExtendScript Debugger** VS Code extension
(`Adobe.extendscript-debug`, V2). No custom DAP server — we consume the
official extension only.

## Commands

| Command | Purpose |
| --- | --- |
| `vscode-debugger gen --host-app-specifier aftereffects-27.0 [--engine-name main] [--project-dir .]` | writes/merges `.vscode/launch.json` with an **attach** configuration pinned to the declared host specifier |
| `vscode-debugger validate <launch.json>` | contract-checks a launch.json (JSONC tolerated); exit 1 on errors, warnings reported |

Requires: VS Code ≥1.62 and the `Adobe.extendscript-debug` extension
installed. No Node dependencies.

## Design boundary (persisted on Issue #53)

- **Attach only.** `request: "launch"` evaluates `script` directly in
  the host engine, bypassing the ae-a8n owned-session dispatch/consent
  path — `gen` never emits it, and `validate` flags it as a warning.
- Dispatch of the debugged script stays on the #49 trustedEval
  transport; the debugger attaches to breakpoints/`$.bp()`/errors in
  whatever the owned session evaluates.
- `hiddenTypes: ["builtin"]` default keeps the Variables view readable.
- Source maps: the DAP reports positions in the **compiled JSX**;
  Adobe documents no sourcemap support. Original-TS mapping stays on
  the #52 diagnostics path (`jsx-toolchain map`/`resolve`).

## Honest limitations — UNVERIFIED

- **Real attach is UNVERIFIED.** Whether AE 2026/2027 still accepts the
  ESTK-derived debug protocol is a real-host question; the launch/GUI
  freeze is in effect, so nothing here has touched a live AE.
- `hostAppSpecifier` selects app **family + version**, not a PID.
  Instance-level pinning ("the ae-a8n owned session, not another AE
  instance") cannot be expressed in launch.json — operational
  precondition is exactly one AE instance, launched via the owned
  session path. Two-instance discrimination: UNVERIFIED.
- `engineName: "main"` assumes the default engine; other engines
  (`transient`, CEP) are host-dependent.
- Breakpoints, stepping, variables, call stack, `$.bp()`: all
  UNVERIFIED pending a disposable owned session + human authorization.
- Windows: UNVERIFIED.

## Verification

- `node tests/run.mjs` — 18 contract/unit tests (fixtures for valid
  attach, wrong type, V1 properties, launch request, malformed fields,
  merge/idempotency, JSONC tolerance, CLI exit codes).
