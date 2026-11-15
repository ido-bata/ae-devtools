# vscode-debugger — VSCode `extendscript-debug` integration (Issue #53)

Generates and contract-validates `.vscode/launch.json` configurations for
Adobe's official **ExtendScript Debugger** VS Code extension
(`Adobe.extendscript-debug`, V2). No custom DAP server — we consume the
official extension only.

## Commands

| Command | Purpose |
| --- | --- |
| `vscode-debugger gen --host-app-specifier aftereffects-27.0 [--engine-name main] [--project-dir .]` | writes/merges `.vscode/launch.json` with an **attach** configuration pinned to the declared host specifier |
| `vscode-debugger validate <launch.json>` | contract-checks a launch.json (real JSONC parse — comments/trailing commas legal, `//` inside strings is not a comment); exit 1 on errors, warnings reported |
| `vscode-debugger preflight [--host-app-specifier …] [--owned-pid <pid>]` | attach precondition checks: installed-app plausibility, running-instance count, owned-session attestation. **Never claims debug completion** — see below |

Requires: VS Code ≥1.62 and the `Adobe.extendscript-debug` extension
installed. One runtime dependency: `jsonc-parser` (JSONC tokenize +
surgical edits).

## JSONC safety (launch.json read/update)

`launch.json` is JSONC and users keep arbitrary settings in it. The
update path (`src/jsonc.mjs`) therefore:

- parses with `jsonc-parser` — **never** regex-strips comments (a `//`
  inside a string literal is not a comment),
- edits **surgically** via `modify`/`applyEdits` on the
  `configurations` array only — comments, trailing commas, key order,
  and foreign configs survive byte-for-byte,
- refuses to write when the existing file is not parseable JSONC, and
  re-validates the post-edit document before touching disk.

## Contract verification (vs official Adobe docs)

Checked against `Adobe.extendscript-debug` marketplace docs +
`extendscript.docsforadobe.dev` (2026-11):

- V2 renamed `targetSpecifier→hostAppSpecifier`, `program→script`,
  `excludes→hiddenTypes`; other V1 props removed → validator rejects.
- `hostAppSpecifier` selects **app family + version, not a PID**. The
  authoritative specifier string is only shown by the extension's app
  picker — offline checks can only establish *plausibility* against
  installed `.app` bundles (`preflight` reports `candidate-match` with
  `proof: "unverified"`).
- `engineName`: official default is `""`; AE's main engine is
  officially named **`main`** → `gen` default is correct for this lane.
- AE quirk (official docs): breakpoints inside **callback sections**
  require the evaluated script to set `$.level = 1`; adjusting
  breakpoints mid-session triggers the next breakpoint once.
- `attach` never evaluates files; `launch` does → `gen` emits attach
  only, `validate` warns on launch.

## Preflight verdicts (`preflight`)

| verdict | meaning |
| --- | --- |
| `ready-owned-session` | exactly one AE running AND `--owned-pid` attests it is the owned session — the **only** attachable verdict. Attestation-grade, not ae-a8n contract-grade (see below) |
| `unowned-single-instance` | exactly one AE running, but **ownership UNPROVEN** — attach refused (fail closed) |
| `ambiguous-multiple-instances` | >1 AE process → **always refused**. `--owned-pid` cannot aim the debugger at a PID, so attestation never rescues this verdict |
| `no-running-instance` | nothing to attach to |
| `blocked-specifier` | specifier malformed / out of lane scope / no installed app plausibly matches |

`debugCompletionClaimed` is **always false**: even a clean preflight
leaves protocol acceptance (ESTK-derived debug protocol on AE
2026/2027) UNVERIFIED — that requires a real attach.

`--owned-pid` is a **caller attestation, not a debugger target**:
`hostAppSpecifier` selects app family+version and the ExtendScript
debugger offers no PID pinning, so the flag only records which process
the ae-a8n session owns. It is graded against the ae-a8n ownership
contract (`HostOwnership` in ae-a8n `src/driver/transport.ts`): contract
"owned" requires launch provenance plus a pinned process start time,
while `--owned-pid` is a bare claim — hence `ready-owned-session` is
attestation-grade. Contract-grade proof (the debugger actually landing
on the owned instance) remains a real-session acceptance item.

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
  freeze is in effect, so nothing here has touched a live AE. (Note:
  an AE 2026 instance was observed running on this machine during
  development — preflight only *read* process/app state; no attach,
  no launch, no GUI action was performed.)
- `hostAppSpecifier` existence can only be confirmed by the
  extension's picker or a real attach — `preflight` reports
  plausibility, never proof.
- `engineName: "main"` targets AE's main engine; CEP/transient engines
  are host-dependent.
- Breakpoints, stepping, variables, call stack, `$.bp()`: all
  UNVERIFIED pending a disposable owned session + human authorization.
- Windows: UNVERIFIED (preflight's app/process discovery is macOS-only;
  `evaluatePreflight` is platform-neutral).

## Verification

- `node tests/run.mjs` — 33 contract/unit tests (fixtures for valid
  attach, wrong type, V1 properties, launch request, malformed fields,
  JSONC preservation/surgical edits, merge/idempotency, preflight
  verdicts, CLI exit codes).
