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

## What IS proven on a real host so far

- ExtendScript `this` semantics divergence (probe transcripts above).
- ae-a8n correctly refuses owned-session operations when process
  attribution is ambiguous — no unsafe dispatch occurred.
- The full connect→exec→error→fix→verify loop remains **fake/mock only**;
  it is blocked on ae-a8n#105 (and #103 merge/publish for the npm path).

## Not yet attempted

- Any `aeDevtools.trustedEval` dispatch against real AE (blocked by #105).
- GUI observation, modal-dialog recovery, crash/log collection,
  session rebuild — no implementation exists yet.
