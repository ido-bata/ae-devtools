# EVIDENCE — a8n-transport real-host attempts (Issue #49)

Recorded honestly per the repo verification taxonomy. Nothing below is
presented as "working" beyond what actually ran.

## Environment

- macOS 27.2.1 (arm64), Node v24.x
- AE installs present: "Adobe After Effects 2026" = 26.5.3, "Adobe After Effects 2027" = 27.0.0
- ae-a8n consumed: local build of branch `103` (includes the #103 extension fix), via `--ae-a8n-root`; npm pin `0.1.0-alpha.2` used for the first attempt

## Attempt 1 — npm 0.1.0-alpha.2, default AE discovery (27.0.0)

`node real-run.mjs` → `session.launch failed: host script raised past its
own handler: extensions were declared without an __a8n host context`.

Root cause found by direct ExtendScript probes on AE 27.0.0 (DoScript +
`$.evalFile`, the same path the driver uses):

- `this` inside `(function(){})()` = the function itself, **not** the
  global object
- `this` inside a named function declaration called plainly = `$.global`
- top-level `this` === `$.global`; `var __a8n` lands on `$.global.__a8n`

The generated prelude read `this.__a8n` inside an IIFE → always undefined on
a real host. The fake vm runtime gives sloppy-mode `this`=global everywhere
and cannot reproduce this. Filed as **ae-a8n#103**, fixed in ae-a8n PR #104
(named-function registration). Level reached: **verified on real host**
(probe), fix automated-tested only so far.

## Attempt 2 — local ae-a8n@103 build, AE 2027 (default) and AE 2026 (`--install-dir`)

Both runs refused before any dispatch:

```
ownership {"kind":"unknown","code":"A8N-AE-004",
  "evidence":"after launch: 2 instance(s), 2 started since launch began;
   the process this session started is pid <N>, so no single instance can
   be tied to it"}
```

Controlled follow-up experiments (same machine):

- `open -a` → 1 process; direct `spawn(exe,{detached,stdio:ignore})` → 1
  process stable >2 min; `DoScriptFile` by bundle path against the running
  instance → still 1 process.
- The two-process state was only observed inside `AfterEffects.launch()`;
  the second process owned the GUI children and was the System Events-visible
  app; the spawned process later exited on its own once.

Filed as **ae-a8n#105** (macOS ownership attribution vs. LaunchServices
second instance). `unknown` correctly refused — the safe outcome. Level:
**verified on real host** (negative result, ownership fail-closed works).

## Attempt 3 — ae-a8n#105 LaunchServices fix + #103 extension fix, AE 2027

`node real-run.mjs --ae-a8n-root /Users/rebui/work/ae-a8n-105` (local build
of branch `105`, which includes the #103 fix): **full vertical slice green
on real AE 27.0.0** — evidence `run-105-103-a.json`.

- ownership `owned` (single instance, pid recorded), 6 transport sends for
  6 dispatched steps
- `connect.state` → `"27.0x78"`, `project.state` → `"0"`
- `error.capture` → FAILED with real host `ReferenceError`
  (`__a8nSliceUndeclaredIdentifier は未定義です`)
- `fix.rerun` → COMPLETED; `verify.counter` → `"1"` then `"2"` (shared live
  `$.global` session state)
- `consent.tampered` → BLOCKED, sends flat; `consent.denied` →
  REFUSED-BEFORE-SEND, sends flat
- `close` → `{quit:true}`, no AE process remained afterward

This is the first **verified on real host** run of the connect → execute →
error → fix → rerun → verify loop. It also re-verifies the ae-a8n#103
extension fix end-to-end (real `aeDevtools.trustedEval` dispatch through
the generated host script).

## Attempt 4 — acceptance gate, local ae-a8n be78ca6 (105+103), hardened runner

Four consecutive real runs, all exit 0, all `assertionViolations: []`:

| evidence | AE | version | ownership | sends | close | main-exe leftover |
| --- | --- | --- | --- | --- | --- | --- |
| run-gate-2027-a/b | 2027 | 27.0x78 | owned | 6 | quit:true | 0 |
| run-gate-2026-a/b | 2026 | 26.5.3x9 | owned | 6 | quit:true | 0 |

`aeA8nHead` = `be78ca6` (branch `verify-105-103` = #105 LaunchServices fix +
#103 extension fix). Post-close `ps` shows only Adobe helper processes
(crashpad_handler, dynamiclinkmanager, TeamProjectsLocalHub, CEPHtmlEngine
on 2026) — recorded separately as `aeHelpersAfterClose`; the main
`Contents/MacOS/After Effects` executable is gone in every run.

**Failure path** — `run-failpath-attached-2027.json`: AE 2027 pre-running →
launch resolves `attached` (pid recorded) → slice refuses before any
dispatch, exit 1. Evidence preserves `launchError`, `sessionRoot`, the
session `trace`, and before/after process lists showing the pre-existing
AE untouched (correctly not quit — not owned).

Note: an earlier instrumentation bug quarantined runs on *helper*
processes alone; fixed by matching only `Contents/MacOS/After Effects`.
The flawed evidence files were discarded before rerun.

## Acceptance-hardening changes (this branch, fake-tested)

- `transport.mjs`: ae-a8n wraps driver errors in `AfterEffectsError`, so
  classification now walks the `cause` chain — `TimeoutError` /
  `ProtocolError` / `ScriptInvocationError` → UNKNOWN (never resent);
  proved-not-sent names (incl. `MacSessionError`,
  `UnsupportedScriptPathError`, `HostUnavailableError`) → refusal;
  `ScriptInvocationError` carrying `-1743` → refusal (Apple Event denied =
  proved non-dispatch); structural `HostError` → FAILED with the AE error
  name. Host results missing or echoing a different `requestId` → UNKNOWN.
- `scenario.mjs`: `assertSliceOutcomes(steps)` — every step's outcome class,
  per-step send counts, counter state transition `"1"→"2"`, and flat send
  counts on both consent gates.
- `real-run.mjs`: launch/ownership failures still write evidence
  (sessionRoot + trace via `error.sliceSessionRoot`/`sliceTracePath`);
  slice assertion violations exit nonzero; close failure or a surviving
  **main** AE executable → `sessionQuarantined` + exit nonzero (Adobe
  helpers recorded separately, not quarantined); `aeA8nHead` pins the
  local build SHA; process snapshots before launch and after close.
- `session.mjs`: `sessionRoot` under workdir (trace survives for evidence),
  `ae.tracePath` recorded, `git rev-parse HEAD` captured for
  `--ae-a8n-root`, ownership-refusal errors carry the same evidence context.

## What IS proven on a real host so far

- ExtendScript `this` semantics divergence (probe transcripts above).
- ae-a8n correctly refuses owned-session operations when process
  attribution is ambiguous — no unsafe dispatch occurred.
- Full connect→exec→error→fix→verify loop on **both** AE 27.0.0 and
  AE 26.5.3, two consecutive green runs each, via local
  ae-a8n#105+#103 build (attempts 3–4) — **verified on real host**.
- Attached-session refusal + evidence preservation on real AE.

## Not yet attempted

- npm-published ae-a8n verification — separate gate after actual publish.
- GUI observation, modal-dialog recovery, crash/log collection,
  session rebuild — tracked as ae-a8n #107/#108/#109.
