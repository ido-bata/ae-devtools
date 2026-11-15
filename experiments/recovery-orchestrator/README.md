# recovery-orchestrator (Issue #55)

Crash / modal / session-rebuild orchestration between ae-devtools callers
and ae-a8n's macOS GUI recovery surface (ae-a8n #109 observation, #111
lease + dialog classes).

## What it does

- `collectCrashEvidence` — copies `.ips` (DiagnosticReports) and Sentry
  `*.envelope` files produced since a cutoff into an evidence dir. Every
  file gets a sha256; `.ips` reports are parsed and **correlated** to the
  target process: `correlated` (pid AND procPath AND app version AND
  procLaunch all proven) / `candidate` (weaker match — e.g. pid alone,
  which cannot survive PID reuse) / `unrelated` / `unclassified`.
  Copy-only — never deletes or submits. Unreadable source dirs and copy
  failures are recorded and mark the collection **incomplete**, which
  blocks `clean`/`crash-verified` downstream.
- `observeScreen` — wraps `MacGuiRecovery.listWindows()` + `capture()`.
  AX-empty + WindowServer-visible surfaces as `axSuspect`; observation
  failure is `unknown`, never "no windows".
- `runTimeoutRecovery` — pre/post observation around ae-a8n's
  `HostRecovery.attempt()`. The timed-out request is **never resent**;
  `ownerId` is derived from the verified run marker, not caller input.
- `verifyHostExit` — records process liveness, WindowServer census,
  session confirmation and evidence collection as **independent
  channels**. `clean` requires all of: process gone + session-confirmed
  census clean + evidence collection **complete** + zero correlated
  reports. `crash-verified` is the crash-side equivalent and likewise
  requires complete evidence. Any failed/missing/incomplete channel →
  `unknown`, never `clean`.
- Run-marker authorization (`loadRunMarker`/`authorizeRecovery`) —
  `recover` cannot reach a GUI mutation on self-declared flags. It
  requires a live `ae-devtools.cli.run-guard/v1` marker (written by
  devtools-cli before session open) with: non-terminal status,
  `ownership.kind === "owned"`, recorded `session.process` evidence
  (aePid + start stamp + guiSession uid/asid), the runner pid still
  alive with a matching start stamp (no PID reuse), the AE pid still
  alive with a matching start stamp, and the request's **latest**
  recorded event being `timeout` for the claimed method. Anything less
  refuses before any ae-a8n surface loads.

## Verdicts

`await-original` | `quarantined` | `refused` | `residue` | `clean` |
`crash-verified` | `crash-unconfirmed` | `crash-suspect` | `unknown` —
see `orchestrator.mjs` header for semantics.

## Usage

```sh
node cli.mjs evidence --since <ISO> --out <dir> \
  [--pid N] [--proc-name NAME] [--app-version V] [--proc-path P] \
  [--proc-launch "<ps lstart>"] [--run-id ID]

node cli.mjs observe --pid N --session-uid U --session-asid A \
  --ae-a8n-root <built-ae-a8n> [--shot-dir <dir>]          # read-only

node cli.mjs recover --run-id <runId> --request-id R --method M \
  --ae-a8n-root <built-ae-a8n> [--runs-dir <dir>]          # GUI mutation

node cli.mjs verify-exit --pid N --session-uid U --session-asid A \
  --expectation exit|crash --evidence-dir <dir> \
  --ae-a8n-root <built-ae-a8n>
```

`recover` authorizes via the run marker; the marker's recorded
uid/asid is then cross-checked against live `lsappinfo` attribution of
the AE pid before any GUI object is constructed — a marker claim that
does not match the live session refuses. The ae-a8n #111 GUI lease
still serializes the actual mutation on top. `verify-exit` runs the
census inside the confirmed GUI session (`readGuiSession` +
`censusRunnerInSession`); an unconfirmed session — missing asid,
asid mismatch, or pid not attributable to that session — degrades the
census channel to unavailable → `unknown`.

## Evidence level

**fake only** — `tests/run.mjs` covers parsing, correlation,
marker authorization, completeness gating and verdict honesty against
fakes (33 tests). The real-host path is **UNVERIFIED** while macOS GUI
testing is frozen; it requires a built ae-a8n checkout containing the
#109/#111 exports (`censusRunnerInSession`, `readGuiSession`,
`listAppInstances`) and a devtools-cli run that recorded
`session.process` evidence via `AfterEffects.recoveryTarget()`.
