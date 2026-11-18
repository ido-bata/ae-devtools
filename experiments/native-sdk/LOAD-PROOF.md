# LOAD-PROOF — AEGP / CPU-Effect plugin load & execution proof plan (Issues #17/#18 groundwork)

> Status: **procedure definition, not yet executed.** This document fixes
> *what must be true* before a `.plugin` built by `build-macos.sh` may be
> loaded into After Effects, and *what evidence counts* as load/execution
> proof. Nothing here has run against a real AE session. Every claim below
> stays `UNVERIFIED` until an authorized session produces the recorded
> evidence — see `README.md` "Independent verification states".

Scope: `Sweetie` (AEGP suite export, CAP040), `Checkout` (CPU-only
Effect, CAP042-adjacent) and `NativeProbe` (ae-a8n's own minimal
read-only AEGP probe, CAP038 — load + entry-point query execution).
The GPU/SmartFX/MFR path (`SDK_Invert_ProcAmp`) is **out of scope** —
it is build-blocked on `metal_common` + Boost and is tracked under
Issue #18, not here.

## 1. Authorization gate (hard prerequisite)

A load proof may run **only** in an explicitly owned and authorized AE
session. Before any step below:

- [ ] The operator has named the session in writing (issue comment or
  equivalent): which AE installation, which OS user/account, and that it
  is dedicated to this proof — **never** the operator's interactive
  session.
- [ ] The target project is disposable (created for the proof, deleted
  after); the user's real projects are never opened.
- [ ] AE quit/launch lifecycle for the session is owned by the proof
  runner; no other worker touches the same AE instance.
- [ ] Windows is untouched — no Windows host exists for this work
  (Issue #21).

If any box is unchecked, the proof does not run. "The AE window happened
to be open" is not authorization.

## 2. Prerequisites

| Item | Requirement |
| --- | --- |
| Build artifacts | `Sweetie.plugin`, `Checkout.plugin`, `NativeProbe.plugin` produced by `build-macos.sh` on this machine (see `EVIDENCE.md`) |
| AE version | Recorded exactly (e.g. 26.5.3 / 27.0.0) — load behaviour may differ per version; evidence binds to one |
| Install location | macOS: `~/Library/Application Support/Adobe/After Effects/<ver>/Plug-ins/` (or a session-scoped equivalent the operator designates) |
| Signing | Samples are ad-hoc "Sign to Run Locally". Whether AE accepts ad-hoc signatures on this macOS version is itself a verification item — if AE refuses to load, that is a `FAIL`/`BLOCKED` finding, not something to silently re-sign around |
| Fixture project | disposable `.aep` built per §3 |

## 3. Fixtures

Both fixtures are disposable projects created inside the authorized
session. They are *specifications*, not binaries — build them through AE's
own UI or Scripting DOM during the session and record what was created.

### F-A: AEGP load fixture (Sweetie)

- Empty project is sufficient — Sweetie registers a PICA suite at load
  time and does not touch project contents.
- Success signal is load-time only: AE stays alive, no crash report, and
  (see §4) the suite registration is confirmed by an attributable caller.

### F-P: read-only AEGP probe fixture (NativeProbe)

- Any disposable project state is acceptable — the probe only reads
  (project count/name/dirty/bit-depth, root-folder and top-level item
  names, host version/UI/activation flags). An empty project is the
  minimal case; a project with a few items exercises the item walk.
- **Lifecycle (post-restructure):** the PiPL entry point
  `AEProbePluginEntry` performs registration only — suite acquisition,
  `AEGP_RegisterWithAEGP` identity registration, and
  `AEGP_RegisterIdleHook`. All project/item queries run inside the
  registered **idle hook**, the host-dispatched main-thread context —
  the probe fires when the project-set fingerprint (count + per-project
  name/path, capped at 4 projects) changes, on the first dispatch
  (`probe.reason=initial`), and on recovery from a query-failure
  window (`probe.reason=recovery`); steady-state ticks stay silent.
  No menu command is registered.
- Success signal: AE stays alive, no crash report, and the debug log
  contains the `probe.start` … `probe.end` line sequence with the
  expected keys (`driver.*`, `host.*`, `app.numProjects`,
  `project[0].*`, `project.items.*`). If the probe loads before any
  project is open, the first run legitimately logs
  `app.numProjects=0`; opening the fixture project changes the
  fingerprint and produces the full `project[*]` sequence on the next
  dispatch. If no `probe.*` lines appear at all, idle-hook dispatch
  itself is the finding (record as FAIL/UNKNOWN — see REVIEW.md
  "Remaining UNVERIFIED").

### F-E: CPU-Effect fixture (Checkout)

- One comp `Probe` — e.g. 640×360, 30 fps, 90 frames.
- Two layers: `Plate` (full-frame solid, e.g. red) and `Top` (full-frame
  solid, e.g. blue, above `Plate`).
- Apply effect **`ADBE Checkout`** (PiPL Name `Checkout`, Category
  `Sample Plug-ins`) to `Top`.
- Expected render semantics (from `Checkout.cpp`): each output frame's
  **top half** shows the layer selected by the `CHECK_LAYER` parameter at
  `CHECK_FRAME` time; the **bottom half** shows the effect's own input.
  With default/self params the visible result is a horizontal split —
  enough to prove `PF_Cmd_RENDER` executed.

## 4. Procedure and verification conditions

Run order is fixed; each step's evidence is recorded before proceeding.
A failure at any step stops the proof — later steps are not attempted on
a broken load.

| # | Step | Verification condition | Evidence to capture | Level if met |
| --- | --- | --- | --- | --- |
| 1 | Install `.plugin` into the designated Plug-ins dir | file present, hash recorded | `shasum -a 256` of all three bundles | build-host fact |
| 2 | Launch the authorized AE session | AE process up, version string recorded | AE version/build, pid, OS user | session record |
| 3 | Sweetie load | AE remains alive ≥ N minutes with plugin installed; **no new crash report** in `~/Library/Logs/DiagnosticReports` for the session window | crash-report absence check + console/log excerpt | `UNVERIFIED→candidate real-host` for *load only* |
| 4 | Sweetie execution | `DuckSuite1.Quack` is a PICA suite callable by other plug-ins, **not** by ExtendScript — automated invocation needs a caller plugin that does not exist yet. Until then: manual/visual confirmation of the alert sound in the authorized session, or defer execution proof | session log noting who invoked and what was observed | `manual/visual` — honestly labelled, never automated-test |
| 5 | NativeProbe load | AE remains alive ≥ N minutes with `NativeProbe.plugin` installed; **no new crash report**; entry point completed registration (suites acquired, identity + idle hook registered) without returning an error | crash-report absence check + console/log excerpt | `UNVERIFIED→candidate real-host` for *load/registration only* |
| 6 | NativeProbe execution | Debug log contains `ae-a8n`/`nativeprobe` `probe.start`→`probe.end` sequence emitted from the **idle-hook** context with expected keys (`probe.reason`, `driver.pluginInitVersion`, `driver.implementationVersion`, `host.suppressInteractiveUI`, `host.isActivated`, `app.numProjects`, `app.activeItem*`, `project[0].name/isDirty/bitDepth/path/timeDisplay`, `project.rootFolder.name`, `project.items.*` incl. per-item `type`/`typeName`/`id`/`flags`/`selected`/`label`/`duration`/`currentTime`/`dimensions`/`pixelAspect`/`parentFolder`/`comment`/`mruView`, `view.*` when a view exists, `comp.*` for COMP items, `app.mruComp`, `renderQueue.*`, `rq[*].*`) and `op <Suite>.<member> err=` records for the calls made; a `app.numProjects=0` first run followed by a full sequence after opening the fixture project is the expected two-phase pattern; values cross-checked against the same session's scripting DOM (`app.project.name`, item count) where comparable | debug-log excerpt + scripting transcript + plugin sha256 | real-host for read-only AEGP query path |
| 7 | Checkout visibility | Effect appears under Effects & Previews → `Sample Plug-ins` → `Checkout`, or `layer.Effects.addProperty("ADBE Checkout")` succeeds via Scripting DOM | scripting transcript / UI observation | real-host (script path) |
| 8 | Checkout render | Render `Probe` (Render Queue or `renderFrame`-equivalent in-session) → top half shows the checked-out layer, bottom half the input; no render error, no crash | rendered frame artifact + its sha256, render log | real-host for CPU effect path |
| 9 | Checkout unload/cleanup | Remove all `.plugin`s, relaunch session, effects/probe absent, no residual state; disposable project deleted | post-cleanup session record | real-host for clean removal |

Rules carried over from the probe outcome model and Issue #21's
conformance note:

- Crash, hang or AE quit at any step is `FAIL`/`UNKNOWN` with the artifact
  retained — never retried silently, never reclassified after the fact.
- Evidence records follow `specs/ae-capability-coverage/design/
  conformance-evidence.md` (on the #21 branch): platform, AE version+build,
  plugin binary sha256, `sourceSha`, `runId`, artifact hashes,
  `sideEffects: "none-observed"` assertion.
- A `PASS` here is per-step and per-plugin; load success for Sweetie says
  nothing about Checkout, and vice versa.

## 5. Explicit non-goals

- GPU/SmartFX/MFR kernels (`SDK_Invert_ProcAmp`) — build-blocked, Issue #18.
- Windows SDK build or load — no Windows host; agents never connect.
- Notarization/signing-policy changes — ad-hoc signing acceptance is
  measured, not worked around.
- Any transport, consent or dispatcher work — ADR-0005 / ae-a8n #97–#99.
- The operator's interactive AE session — off-limits by definition.
