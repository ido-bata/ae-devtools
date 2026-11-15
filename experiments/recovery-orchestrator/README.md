# recovery-orchestrator (Issue #55)

Crash / modal / session-rebuild orchestration between ae-devtools callers
and ae-a8n's macOS GUI recovery surface (ae-a8n #109 observation, #111
lease + dialog classes).

## What it does

- `collectCrashEvidence` — copies `.ips` (DiagnosticReports) and Sentry
  `*.envelope` files produced since a cutoff into an evidence dir with a
  manifest. Copy-only; never deletes or submits anything.
- `observeScreen` — wraps `MacGuiRecovery.listWindows()` + `capture()`.
  AX-empty + WindowServer-visible surfaces as `axSuspect`; observation
  failure is `unknown`, never "no windows".
- `runTimeoutRecovery` — pre/post observation around ae-a8n's
  `HostRecovery.attempt()`. The timed-out request is **never resent**.
- `verifyHostExit` — after an exit/crash, requires pid-gone AND
  WindowServer-census agreement AND evidence collection before `clean`.
  Census unavailable → `unknown`, never `clean`.

## Verdicts

`await-original` | `quarantined` | `refused` | `residue` | `clean` |
`unknown` — see `orchestrator.mjs` header for semantics.

## Usage

```sh
node cli.mjs evidence --since <ISO> --out <dir>
node cli.mjs observe --pid N --session-uid U --session-asid A \
  --ae-a8n-root <built-ao-a8n-checkout> [--shot-dir <dir>]
node cli.mjs recover --pid N --session-uid U --session-asid A \
  --request-id R --method M --ae-a8n-root <dir>
node cli.mjs verify-exit --pid N --session-uid U --session-asid A \
  --ae-a8n-root <dir> [--evidence-dir <dir>]
```

`observe` is read-only. `recover` may press a measured dialog button and
requires the ae-a8n GUI mutation lease — a held lease refuses the press.

## Evidence level

**fake only** — `tests/run.mjs` covers the orchestration against injected
fakes. The real-host path (cli.mjs + ae-a8n exports) is **UNVERIFIED**
while macOS GUI testing is frozen; it requires a built ae-a8n checkout
containing the #109/#111 exports (not yet in a published package).
