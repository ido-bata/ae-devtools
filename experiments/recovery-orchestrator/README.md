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
  `recover` cannot reach a GUI mutation on self-declared flags. The run
  marker is an **attribution record** (which run, which request timed
  out), not an authority. Authorization requires a live
  `ae-devtools.cli.run-guard/v1` marker (written by devtools-cli before
  session open) with: non-terminal status, `ownership.kind === "owned"`,
  recorded `session.process` evidence (aePid + start stamp +
  guiSession uid/asid) **carrying ae-a8n ownership attestation
  provenance** (`session.process.attestation.source ===
  "ae-a8n:AfterEffects.recoveryTarget()"` plus non-empty
  `ownership().evidence`, recorded from the live ae-a8n session object
  at open time — never from caller input), the runner pid still alive
  with a matching start stamp (no PID reuse), the AE pid still alive
  with a matching start stamp, and the request's **latest** recorded
  event being `timeout` for the claimed method. Anything less refuses
  before any ae-a8n surface loads. The ae-a8n #111 GUI lease still
  serializes the actual mutation; `recover` records the pre-attempt
  lease state (`guiLease`) for attribution.
- Session confirmation (`confirmGuiSession`) — split into GUI-session
  identity (`readGuiSession` uid/asid, independent of the target
  process) and pid attribution (`listAppInstances`/lsappinfo). lsappinfo
  only lists LIVE app instances, so a dead pid — the expected
  `verify-exit` state — is recorded as `pidAttribution: "dead"`, not
  treated as unconfirmed; a live pid that is not attributable to the
  claimed session still refuses.

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
still serializes the actual mutation on top; its pre-attempt state is
recorded as `guiLease` in the result. `verify-exit` runs the
census inside the confirmed GUI session (`readGuiSession` +
`censusRunnerInSession`); an unconfirmed session — missing asid or
asid mismatch — degrades the census channel to unavailable →
`unknown`. For a dead pid, lsappinfo attribution is recorded as
`pidAttribution: "dead"` (lsappinfo cannot list a dead process) and
the census simply finds no windows for that pid.

## Evidence level

**fake only** — `tests/run.mjs` covers parsing, correlation,
marker authorization (incl. attestation provenance), session
confirmation (incl. dead-pid attribution), completeness gating and
verdict honesty against fakes (39 tests). The real-host path is **UNVERIFIED** while macOS GUI
testing is frozen; it requires a built ae-a8n checkout containing the
#109/#111 exports (`censusRunnerInSession`, `readGuiSession`,
`listAppInstances`) and a devtools-cli run that recorded
`session.process` evidence via `AfterEffects.recoveryTarget()`.
