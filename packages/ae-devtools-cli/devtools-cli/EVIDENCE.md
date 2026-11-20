# EVIDENCE — devtools-cli real-host runs

Artifacts in `evidence/` are `ae-devtools.cli.run/v1` / `ae-devtools.cli.error/v1`
records produced by `devtools-cli/cli.mjs --out`. The attached-session (#366)
follow-up section moved here from `../a8n-transport/EVIDENCE.md` because those
artifacts are CLI run records, not `a8n-transport/real-run` records.

## Issue #366 follow-up — attach pre-flight + project pin + comp/layer loop (macOS, AE 2027 `27.0x78`)

Branch `366` @ `9e9f5d4`+ (pre-flight census, `ATTACHED_TARGET_AMBIGUOUS`,
`--project-file` / `ae-devtools.attachedProjectFile` pin, Project-handle
read fix). All runs `--ae-a8n-root` = local ae-a8n `release-0-5-0` @
`50e712b`; every session reports `ownership: "attached"`,
`evidenceLevel: verified on real host (attach to a running AE)`,
`policy.readOnly` or scoped `mutation.allowedOps`; `cleanup.quit` is
always `null` (the host is never quit).

- `run-366-attached-preflight-norun-2027.json` — **pre-flight refuse, no
  launch**: with zero AE processes the opener refuses
  `ATTACHED_TARGET_NOT_RUNNING` in ~0.4 s. No `AfterEffects.launch`,
  no cold start, no quit (previously this path cold-started AE and then
  closed it).
- `run-366-attached-verify-2027.json` — read-only attach verify on a
  user-launched AE 2027 (pid 22873): `read.projectSummary` COMPLETED,
  `target.ownershipEvidence` = `already running before launch: pid
  22873`, install dir + app path recorded.
- Comp/layer lifecycle on the attached host (each op its own attached
  session, explicit `--allow-mutation` scope + `--consent grant`):
  `project.new` → `item.addComp` (Comp1 1920x1080@30) →
  `comp.addNullLayer` ("Null 1") → `read.compLayers` shows the layer →
  `layer.setTransformPosition` x=100 y=200 → `read.layerDetail`
  read-back `position: [100,200,0]` → `project.save`
  `/tmp/ae-att-test.aep` → `project.open` of that file →
  `read.projectSummary` on the reopened project (3 items).
- `run-366-attached-projectpin-2027.json` — `--project-file
  /tmp/ae-att-test.aep` matches the open project (`target.project.file`
  recorded, verify COMPLETED); `--project-file` pointing elsewhere
  refuses `ATTACHED_TARGET_MISMATCH` before dispatch.
- Real-host bug found and fixed by this evidence: `ae.project()` is
  async and resolves to a `Project` handle — the previous
  `ae.project().info()` read was always `null` on real hosts (the
  fixture's sync stub masked it). Every attached session's
  `target.project` was silently null until `9e9f5d4`.

Not yet covered here: Windows comp/layer loop, MCP/VSCode surfaces on a
real attached session, multi-instance ambiguity on a real host (unit
tested only).

## Issue #366 follow-up — Windows attach pre-flight findings (Windows 11, AE 2027 `27.0x78`)

Branch `366` @ `77dcdcd`. Target: user-launched AE pid 12912
(`D:\4_apps\adobe\Adobe After Effects 2027\Support Files\AfterFX.exe`,
open user project). Runs from `C:\Users\rebui\src\ae-devtools` @
`C:\Users\rebui\src\att-verify-win*.json`.

- `att-verify-win3.json` — attach + session open COMPLETED earlier the
  same evening (ownership `attached`); `read.projectSummary` dispatch
  returned UNKNOWN (`NO_REPLY_BEFORE_DEADLINE`) against the busy
  2514-item project — honest non-green, no false pass.
- `att-verify-win4.json` / `att-verify-win5.json` — later the same
  night, `AfterEffects.launch` inside ae-a8n spawned NEW AfterFX pids
  (15316, then 58416) instead of attaching to 12912; both died before
  answering `app.info` (`A8N-AE-005` after ~178 s). No orphan process
  remained (`Get-CimInstance` afterwards lists only 12912); the user's
  AE was never terminated or mutated.
- Census diagnosis: `Get-CimInstance Win32_Process` DOES disclose
  `ExecutablePath` for 12912 from this session, so the pre-flight
  correctly counts it as exactly one attributed match and defers to
  ae-a8n. The duplicate-spawn behavior is inside ae-a8n's
  `AfterEffects.launch` attach path when the running instance is busy
  (tracked under ae-a8n #74/#99) — ae-devtools cannot fix it from the
  opener side.
- Policy tightened at `77dcdcd`: unattributable AE rows now refuse
  `ATTACHED_TARGET_UNVERIFIED` and foreign-only rows refuse
  `ATTACHED_TARGET_NOT_RUNNING` instead of falling through to a
  possible duplicate cold start (unit-tested; the unattributed-row
  case is what an elevated/other-session AE looks like).

Not yet covered: a Windows attached comp/layer mutation loop (needs a
responsive, preferably disposable, AE target), MCP/VSCode surfaces on
Windows, `ae-a8n` attach reliability against a busy host.

## Issue #366 follow-up — attach-only boundary + target re-validation (macOS, AE 2027 `27.0x78`)

Branch `366` @ `ad32a1d`. Target: AE pid 56305 launched via `open -a`
(user-session instance, `ownership: "attached"`,
`ownershipEvidence: "already running before launch: pid 56305"`).
`--ae-a8n-root` = local ae-a8n `release-0-5-0` @ `716dada`; every
session reports `target.attachApi:
"AfterEffects.launch(transitional)"` — the ae-a8n attach-only API has
not shipped yet, so the transitional launch fallback ran under the
pre-flight census + ownership check (see `a8n-transport/attach-target.mjs`).

New in this round: `target.identity` records pid `56305`, process start
`Sat Nov 21 01:30:06 2026`, executable path, AE version `27.0x78`, and
open-project file/name; every mutating dispatch re-validates that
identity via `targetGuard` → `revalidateTarget()` after consent
approval and immediately before send (fail-closed on pid/start-stamp
drift, multiple instances, unreadable census, version drift, project
switch — unit-tested in `a8n-transport/tests/attached-session.test.mjs`).

- `run-366-attached-revalidate-verify-2027.json` — read-only attach
  verify; identity block present, `read.projectSummary` COMPLETED,
  `cleanup.quit: null`.
- Comp/layer loop with per-op mutation scope + targetGuard live:
  `run-366-attached-revalidate-addcomp-2027.json` (`item.addComp`
  "DevToolsProbeComp" 320x240@30 → COMPLETED) →
  `run-366-attached-revalidate-addnull-2027.json` (`comp.addNullLayer`
  "ProbeNull" → COMPLETED) →
  `run-366-attached-revalidate-move-2027.json` (`layer.setTransformPosition`
  x=100 y=200 → COMPLETED) →
  `run-366-attached-revalidate-readlayers-2027.json` (`read.compLayers`
  shows ProbeNull index 1) →
  `run-366-attached-revalidate-readdetail-2027.json` (`read.layerDetail`
  read-back `position: [100,200,0]`).
- Recovery (no app-level Undo — on a user's live AE, `app.undo` could
  revert the user's own last edit; targeted removal of objects this
  session created is the honest recovery): `item.remove` of
  DevToolsProbeComp (`run-366-attached-revalidate-remove-2027.json`),
  then AE's auto-created null footage `ヌル 1` and its `平面` folder
  (`run-366-attached-revalidate-cleanup-footage-2027.json`,
  `run-366-attached-revalidate-cleanup-folder-2027.json`).
- `run-366-attached-revalidate-final2-2027.json` — `read.projectSummary`
  back to `numItems: 0`; pid 56305 still running afterwards; every
  `cleanup.quit` is `null` (connection release only, never a quit).

Not yet covered: a REAL drift refusal (pid/project switch mid-session —
unit-tested only; each CLI invocation opens a fresh session so a
mid-session drift cannot be produced through the CLI), the
`AfterEffects.attach` primary path (pending ae-a8n), Windows re-run of
this loop, MCP/VSCode surfaces on the attached session.

## 2026-11-21 — attach-only API + VSCode attempt (branch 366)

- `devtools-cli/evidence/run-366-attached-a8n-attach-api-2026.json` —
  read-only `verify --session a8n-attached` against the USER's running
  AE 2026 (26.5.3x9, pid 34792, uid/asid evidence) using a local
  ae-a8n build of PR #270 (`AfterEffects.attach` present). Result:
  `session.target.attachApi: "AfterEffects.attach"`, ownership
  `attached`, `read.projectSummary` COMPLETED, `cleanup.quit: null`.
  **verified on real host** for the attach-only seam on macOS.
  Transitional `AfterEffects.launch` fallback remains until ae-a8n
  PR #270 lands in a pinned dependency.
- `jsx-toolchain/evidence/run-real-2027-366.json` — owned-session
  AE 2027 vertical slice (issue #38 chain): broken JSX build →
  runtime-error dispatch → sourcemap to-source → mystery detect/
  diagnose → fix → rerun → verify → regression, all 11 steps ok,
  bound to source SHA 2660089.
- VSCode real-host attempt (issue #172): packaged VSIX installed in
  an isolated `--extensions-dir`/`--user-data-dir` instance,
  `ae-devtools.session: "a8n"`, qa-driver `mode=verify`. The
  extension activated via the real `onCommand:ae-devtools.verify`
  event and reached the modal consent gate — then settlement was
  BLOCKED because the macOS screen locked (loginwindow frontmost,
  window not on-screen, AX sees 0 windows). No dispatch completed,
  no Problems-panel diagnostics were produced. Evidence:
  `vscode-extension/evidence/vscode-iso-a8n-366/`. Status:
  **BLOCKED (environmental)** — needs an unlocked GUI session to
  settle consent, then Problems-panel verification.

## 2026-11-21 — attach-only hardening (branch 374, issue #374)

- `attach-target.mjs` no longer has any `AfterEffects.launch` path:
  an ae-a8n build without `AfterEffects.attach` refuses with
  `ATTACHED_TARGET_UNSUPPORTED` before any session object exists.
- Real-host refusal proof: `verify --session a8n-attached` against
  registry-pinned ae-a8n 0.2.0 (no attach API) exits with
  `ATTACHED_TARGET_UNSUPPORTED`; no AE process was spawned
  (user AE 2026 pid 34792 untouched).
- Real-host attach proof via `aeA8nRoot` → ae-a8n release-0-5-0 tree
  (c104e39, identical to merge a9af7e0):
  `devtools-cli/evidence/run-374-attached-no-fallback-2026.json` —
  `attachApi: "AfterEffects.attach"`, ownership attached,
  `read.projectSummary` COMPLETED, `cleanup.quit: null`.
- Packed-tarball verification (branch 366, same code path):
  `run-366-attached-a8n-050-tarball-2026.json` — npm-installed
  `ido-bata-ae-a8n-0.5.0.tgz` from release-0-5-0 HEAD
  (sha512 `cmJJNuJp/88N32qNLaFZiA1/WinfP6D+Y+pjCsb0+QOQ6UGITWBsEM3cTL5DVtvXkrnU/1IWat9t5VXhWrRI6g==`).
- Dependency note: `@ido-bata/ae-a8n` stays pinned at 0.2.0 in this
  PR so `npm ci` keeps working before ae-a8n 0.5.0 is published;
  the spec flips to the published 0.5.0 at release time (human-gated
  npm publish). Until then the attached lane refuses honestly on
  registry installs and works via `aeA8nRoot`/tarball installs.
