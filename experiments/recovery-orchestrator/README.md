# recovery-orchestrator (Issue #55)

Crash / modal / session-rebuild orchestration between ae-devtools callers
and ae-a8n's macOS GUI recovery surface (ae-a8n #109 observation, #111
lease + dialog classes).

## What it does

- `collectCrashEvidence` — copies `.ips` (DiagnosticReports) and Sentry
  `*.envelope` files produced since a cutoff into an evidence dir. Every
  file gets a sha256; `.ips` reports are parsed and **correlated** to the
  target process: `correlated` (pid or path+version proven) /
  `candidate` (same app, unproven) / `unrelated`. Copy-only — never
  deletes or submits. Unrelated crashes are never attributed to the run.
- `observeScreen` — wraps `MacGuiRecovery.listWindows()` + `capture()`.
  AX-empty + WindowServer-visible surfaces as `axSuspect`; observation
  failure is `unknown`, never "no windows".
- `runTimeoutRecovery` — pre/post observation around ae-a8n's
  `HostRecovery.attempt()`. The timed-out request is **never resent**;
  `ownerId` comes from the verified run proof.
- `verifyHostExit` — records process liveness, WindowServer census and
  evidence collection as **independent channels**. `clean` requires all
  of: process gone + session-confirmed census clean + evidence collected
  + zero correlated reports. `crash-verified` is the crash-side
  equivalent. Any failed/missing channel → `unknown`, never `clean`.
- Run proof (`loadRunProof`/`verifyRunProof`) — `recover` cannot reach a
  GUI mutation on self-declared flags. A proof JSON binds aePid + GUI
  session + the recorded timed-out request + ownerId; contradictory
  flags are rejected before any ae-a8n surface loads.

## Verdicts

`await-original` | `quarantined` | `refused` | `residue` | `clean` |
`crash-verified` | `crash-unconfirmed` | `crash-suspect` | `unknown` —
see `orchestrator.mjs` header for semantics.

## Usage

```sh
node cli.mjs evidence --since <ISO> --out <dir> \
  [--pid N] [--proc-name NAME] [--app-version V] [--proc-path P] [--run-id ID]

node cli.mjs observe --pid N --session-uid U --session-asid A \
  --ae-a8n-root <built-ae-a8n> [--shot-dir <dir>]          # read-only

node cli.mjs recover --run-proof <proof.json> --request-id R --method M \
  --ae-a8n-root <built-ae-a8n>                             # GUI mutation

node cli.mjs verify-exit --pid N --session-uid U --session-asid A \
  --expectation exit|crash --evidence-dir <dir> \
  --ae-a8n-root <built-ae-a8n>
```

`recover` authorizes via run proof; the ae-a8n #111 GUI lease still
serializes the actual mutation on top. `verify-exit` runs the census
inside the confirmed GUI session (`readGuiSession` + `censusRunnerInSession`);
an unconfirmed session degrades the census channel to unavailable →
`unknown`.

## Evidence level

**fake only** — `tests/run.mjs` covers orchestration, correlation,
run-proof authorization and verdict honesty against fakes (27 tests).
The real-host path is **UNVERIFIED** while macOS GUI testing is frozen;
it requires a built ae-a8n checkout containing the #109/#111 exports
(including `censusRunnerInSession`, `readGuiSession`).
