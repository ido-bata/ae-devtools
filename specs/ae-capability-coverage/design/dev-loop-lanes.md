# Design note — dev-loop completion lanes (Issue #51)

- Status: **Proposed design note**, not an accepted contract. ADR-0005 remains
  Proposed; nothing here selects a transport, a debugger protocol, or a
  packaging format.
- Parent spec: [spec.md](../spec.md); plan: [plan.md](../plan.md);
  catalog contract: [contracts/capability-catalog.md](../contracts/capability-catalog.md).
- Scope: map the seven "practical AE integrated development environment"
  areas onto existing Spec Kit tasks / Issues / ADRs, record the concrete
  implementation method and real-host acceptance criteria for each, and
  register only the work that had no owner.

## 0. Verified baseline (what already exists)

| Capability | State | Evidence |
| --- | --- | --- |
| Trusted ExtendScript execution pipeline (codec, permissions, outcomes, mutation guard, runner) | merged groundwork on `release-0-1-0` (`packages/ae-devtools-cli/trusted-execution`) | automated test (fake) |
| Owned-session JSX dispatch via `aeDevtools.trustedEval` on `@ido-bata/ae-a8n` | branch `49`, Draft PR #50 | **verified on real host**: AE 27.0.0 + 26.5.3, 4 consecutive green runs (`packages/ae-devtools-cli/a8n-transport/EVIDENCE.md` on `origin/49`) |
| Read-only probe / session pinning / outcome model | merged (`experiments/read-only-probe`) | verified on real host (read-only) |
| Capability catalog + drift gate + domain coverage metadata | merged (`packages/capability-catalog`) | automated test |
| Dev-loop core `discover/inspect/execute/verify` | branch `20`, Draft PR #48 — stacked on unmerged #46/#47 | fake/mock only |
| Agent dev-loop (error→fix→rerun→regression) | branch `38`, Draft PR #45 | fake/mock only |
| Diagnostics record schema + collector registry | branch `37`, Draft PR #41 | fake/mock only |
| CEP scaffold + lifecycle machine | branch `36`, Draft PR #40 | fake/mock only; real load proof gated |
| cep-panel contract fixes | branch `43`, Draft PR #44 | fake/mock only |
| Native SDK macOS build probe (AEGP/Effect samples) | merged groundwork (`experiments/native-sdk`) | build probe only; no load proof |
| ae-a8n owned-session fixes (#103 extension prelude, #105 LaunchServices dual-process) | Draft PRs ae-a8n#104/#106; verified combo `be78ca6` (`verify-105-103`) | verified on real host via a8n-transport gate runs |

Consequence: the **execution foundation and the first real-host loop are
proven**, but every higher lane (build toolchain, debugger, CLI, SDK
lifecycle, CEP lifecycle, crash/modal recovery) still lacks a real-host
vertical slice. Windows remains UNVERIFIED everywhere.

## 1. Lane map

```text
P0  execution foundation ──► failure diagnosis & recovery      [#14 #37 #38 #49 + ae-a8n #105-#109]
P1  build toolchain (TS→ES3, types, lint, sourcemap)          [#52 NEW]
P2  developer clients: CLI / MCP / VSCode / debugger           [#54 NEW, #53 NEW, #20]
P3  scripting domain coverage (Engine Room-class ops)         [#15 #16]
P4  native SDK lifecycle (build/load/debug/render/verify)      [#17 #18 #19]
P5  CEP/UXP extension lifecycle                                [#36 #43]
P6  conformance & release gate                                 [#21, ae-test #21]
```

P0 is the only hard serial dependency for real-host work: every other lane
either consumes the owned-session dispatch (#49 transport) or is
transport-independent (build toolchain, catalog, inventories). Lanes P1–P5
may proceed in parallel **after** their contract prerequisites; they must
not create a second dispatch path.

## 2. Lane details

### 2.1 P0 — AE runtime, pre/post state verification, Engine Room-class operations

- **Implementation**: owned-session launch via `@ido-bata/ae-a8n`
  (`AfterEffects.launch`, ownership `owned` only); dispatch through the
  trusted-codec envelope → `aeDevtools.trustedEval` extension method
  (statically declared, built by `ae-a8n extension build`). Pre/post state
  verification re-reads observable state through registered read ops
  (`devloop.verify()` pattern — success is never inferred from the write
  outcome). Engine Room-class operation coverage is the union of
  `inventories/tools` Engine-Room adapter rows (90 ops incl. comp/layer/
  keyframe/effect/render-queue families) mapped onto the scripting
  domain registries (#15/#16), not a new transport.
- **Depends on**: ae-a8n #105 fix (PR #106) + #103 fix (PR #104) for
  AE 27.0; #49 transport; #15/#16 adapters for named ops.
- **Real-host acceptance**: owned macOS session, disposable project;
  each exercised op records typed outcome + evidence level; UNKNOWN never
  resent; `attached`/`unknown` ownership refuses before dispatch
  (already demonstrated in `run-failpath-attached-2027.json`).
- **Issues**: #14, #15, #16, #38, #49; ae-a8n #97–#99, #105.

### 2.2 P1 — TypeScript/JSX build, typecheck, lint, ES3 compat, sourcemaps [#52 NEW]

- **Implementation**: a build toolchain package/experiment that (a) bundles
  TS/modern JS to a single ES3-compatible JSX (esbuild or tsc emit +
  ES3 transform pass; ExtendScript has no `let/const`, no native `JSON`
  assumption, no ES5+ builtins beyond what the host ships), (b) typechecks
  against typings generated from `inventories/scripting` (the canonical
  symbol snapshot — not hand-maintained `.d.ts`), (c) lints for
  ES3-incompatible constructs and host-object misuse, (d) emits a sourcemap
  consumed by diagnostics (#37 CAP064) so host `{line}` errors map back to
  TS source. CLI surface: `build` / `check` / `lint`.
- **Depends on**: #51 (this note); execution verification reuses the #49
  transport — no new dispatch path. Sourcemap contract feeds #37.
- **Real-host acceptance**: on an owned macOS session, a built artifact
  runs via `trustedEval`; a deliberate type error is caught at `check`
  time, a deliberate runtime error is reported at the **TS source
  position** via the sourcemap, and lint rejects ES3-incompatible syntax
  before dispatch. Fake-level: sourcemap round-trip, ES3 lint rules.
- **Issue**: #52 (new). Related: #14 (codec), #37 (diagnostics), #20
  (client surface).

### 2.3 P2 — VSCode debugger, runtime inspector, MCP/CLI [#53 #54 NEW, #20]

- **VSCode debugger (#53 NEW)**: use Adobe's official
  `Adobe.extendscript-debug` extension (DAP over the ExtendScript debug
  protocol; `attach`/`launch` requests; breakpoints, conditional
  breakpoints, logpoints, variables/watch/call-stack, `$.bp()`). We do
  **not** implement a DAP server. Deliverables: generated `launch.json`
  pinned to the owned session's AE, an attach-only default (the DAP
  `launch` request evals files directly and must not bypass consent),
  and sourcemap-aware error mapping via #52. Open verification item:
  whether the ExtendScript debug protocol is still accepted by AE
  2026/2027 — ESTK is deprecated; treat as UNVERIFIED until a real attach
  is recorded. Fail closed on non-responsive hosts.
- **CLI (#54 NEW)**: thin wrapper over the dev-loop core
  (`discover/inspect/execute/verify`, PR #48) — `doctor`, `discover`,
  `inspect`, `execute`, `verify`, `evidence`. JSON + human output; every
  result carries its evidence level; transport selectable via
  `--ae-a8n-root`. No CLI-specific permission path.
- **MCP / VSCode commands**: remain #20 (CAP049–CAP052); MCP tools stay
  few developer-loop verbs (inspect/execute/verify), never per-primitive
  proliferation (vision.md).
- **Depends on**: #49 transport; #52 sourcemaps (debugger); PR #48 dev-loop
  core (CLI); #20 for the client surfaces.
- **Real-host acceptance**: debugger — attach to owned session, breakpoint
  stop, variables/call-stack visible, continue; CLI — `execute`+`verify`
  on owned session returns typed outcome + evidence artifact; MCP/VSCode —
  same capability IDs and evidence status as CLI (no divergent truth).
- **Issues**: #20 (umbrella), #53 (debugger), #54 (CLI).

### 2.4 P3 — SDK build / load / native debug / render / re-verify [#17 #18 #19]

- **Implementation**: AEGP plug-in vertical slice first (#17): pinned SDK
  version + headers, reproducible build (`experiments/native-sdk/
  build-macos.sh` exists as probe groundwork), load into owned AE,
  read-only AEGP suite command, result recovery, unload/restart/crash/
  version-mismatch recording. Effect SDK slice (#18): minimal PF plug-in
  build/load/parameter-change/frame-output on the render path — **no
  synchronous IPC from render callbacks**; SmartFX/MFR/GPU stay fixture
  tests with explicit thread-safety notes. Native debugging uses the
  platform debugger (Xcode/lldb attach; VSCode `lldb-dap` is acceptable);
  macOS 15+ requires ad-hoc `codesign --force --deep --sign -` for unsigned
  plug-ins during development (Adobe plugin guide). Re-verify = re-render
  + artifact hash comparison, recorded per #21 evidence schema.
- **Depends on**: #10/#11 inventories (merged), #12 ADR-0005 (Proposed —
  D3 assigns capability manifest to ae-devtools; native adapter ownership
  split per D2 is partially open), #13 probe semantics, owned-session
  lifecycle from ae-a8n.
- **Real-host acceptance**: Windows and macOS evidenced **separately**;
  unsigned/unpermitted/ABI-mismatched plug-ins fail closed; a plug-in that
  fails to load never reports fake success; render-callback path proven
  without blocking IPC.
- **Issues**: #17, #18, #19 (suite-family expansion stays sub-issues).

### 2.5 P4 — CEP/UXP build / load / DevTools / logs / reload / removal [#36 #43]

- **CEP**: scaffold generator + manifest XSD validation + lifecycle
  machine (install/uninstall/status/cleanup/logs) exist on branch `36`
  (Draft PR #40); cep-panel contract fixes on branch `43` (Draft PR #44).
  Remaining real-host work: panel load → `CSInterface.evalScript`
  round-trip → reload → unload on an **owned** session (CAP059),
  PlayerDebugMode/`.zxp` signing handling per OS, and panel log
  collection feeding #37 CAP063. CEP DevTools (Chromium remote debugging
  into CEPHtmlEngine) is a candidate for live panel inspection — verify
  port/flag availability per AE version before claiming.
- **UXP**: Adobe's position (aescripts author wiki, forums) is that AE
  UXP is not available in released builds; a public beta was expected
  ~Nov 2026. ADR-0005 D5 already fixes "UXP not adopted for v1/beta".
  CAP060 stays **BLOCKED/UNVERIFIED**: track per-row whether the installed
  AE build exposes UXP plugin loading; never mark supported without
  released-build evidence. Re-evaluate when Adobe ships GA.
- **Depends on**: #36/#43 PRs; #13 probe; #21 evidence schema.
- **Real-host acceptance**: macOS owned session only; install/reload/
  unload idempotent with no residue; `.zxp` unsigned debug-load path
  documented per OS; UXP rows remain BLOCKED with reason.
- **Issues**: #36, #43.

### 2.6 P5 — GUI/modal observation, crash, repair options, Crash Reporter, evidence, session rebuild [#55 NEW; ae-a8n #107 #108 #109]

- **Implementation**: three sub-lanes.
  1. **GUI/modal observation** — consume ae-a8n #109 `guiState()`
     (read-only windows + `classifyDialog` verdict). Devtools maps
     `safe-to-press` / `human-only` / `unknown` onto its dialog gate:
     human-only (licence/sign-in/permission) **escalates, never
     auto-approves**; unknown refuses press and reports.
  2. **Crash detection & evidence** — consume ae-a8n #107 (owned-pid
     observation on timeout paths → classify `HOST_DIED` vs timeout;
     collect `~/Library/Logs/DiagnosticReports` + AE-side logs **for the
     owned session's artifacts only**). Wire into diagnostics source kind
     `native-crash` (#37 CAP061/063). Evidence bundle = #21 manifest +
     trace + crash artifact + GUI screenshot, SHA-pinned.
  3. **Session rebuild** — consume ae-a8n #108 resume/adopt **only when
     it exists**; until then a crashed session ends the run as
     `HOST_DIED` + evidence, and rebuild is BLOCKED (no silent AE
     relaunch). Crash-repair dialogs on relaunch go through the same
     classifyDialog rules — never auto-pressed.
- **Depends on**: #37 diagnostics schema; #38 loop; #21 evidence; ae-a8n
  #107/#108/#109 (API availability gates lanes 1–3 respectively).
- **Real-host acceptance**: disposable fixture induces a host fault;
  outcome classifies as crash (not timeout), bundle contains only owned-
  session artifacts, modal classification returns without pressing,
  rebuild path recorded or explicitly BLOCKED. UNKNOWN is never resent
  after possible dispatch.
- **Issues**: #55 (new, this lane), #37, #38; ae-a8n #107, #108, #109.

### 2.7 P6 — Conformance, evidence, release gate [#21; ae-test #21]

- Unchanged from plan.md §6: matrix generated from inventory; per-row
  `NOT_RUN|BLOCKED|PASS|FAIL|UNKNOWN` × evidence level; Windows stays
  UNVERIFIED; fake-only success never promotes to real-host verified;
  consumer evidence must match published bytes (SHA binding, ae-test #21).

## 3. Registered work → Issue map

| Area | Existing | New |
| --- | --- | --- |
| Runtime/state-verification/ops | #14 #15 #16 #20 #38 #49; ae-a8n #97–#99 #105 | — |
| Build toolchain | — | **#52** |
| VSCode debugger | #20 (CAP050) | **#53** |
| CLI | — (plan.md diagram only) | **#54** |
| MCP/VSCode commands | #20 (CAP049–CAP052), PR #48 | — |
| SDK lifecycle | #17 #18 #19 | — |
| CEP/UXP | #36 #43 | — |
| Diagnostics core | #37 | — |
| GUI/crash/rebuild orchestration | — (ae-a8n #107–#109 own the APIs) | **#55** |
| Conformance/release | #21; ae-test #21; ae-a8n #102 | — |

## 4. Standing constraints (restated for every lane)

- Owned macOS AE session + disposable fixtures only; no interference with
  the user's AE, projects, or desktop. `attached`/`unknown` ownership
  refuses before dispatch.
- UNKNOWN outcome is never resent; ambiguous targets never executed;
  licence/auth/permission dialogs are never auto-approved.
- Windows evidence stays UNVERIFIED until a Windows host run exists.
- `fake/mock only` is never reported as working; every claim carries its
  evidence level.
- Merging to `release-0-1-0` and publishing are human-authorized side
  effects; agents open Draft PRs only.
