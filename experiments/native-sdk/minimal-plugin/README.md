# minimal-plugin — ae-a8n read-only AEGP probe (Issue #17, CAP038)

`NativeProbe.plugin` is **our own** minimal AEGP (AE General Plug-in,
PiPL Kind `AEgx`) written for this repository. It is original code —
no Adobe sample source is copied. It exists to prove the
compile → link → `.plugin` bundle path for a hand-written AEGP plug-in,
and to be the smallest possible vehicle for a later authorized
real-host load/execution proof.

> **Verification state: build/artifact verified on the build host,
> plus mock-host unit tests.** AE plug-in load, registration and
> execution are **UNVERIFIED** — they require an authorized real-AE
> session (see `../LOAD-PROOF.md`). Nothing here is
> `verified-real-host` evidence. Windows is entirely UNVERIFIED.

## Lifecycle: init vs. query context

AEGP suite calls have a **host-guaranteed execution context**: they may
only run on the AE main thread while the host is dispatching plug-in
code (command/menu hooks, idle hooks). `A_Err_WRONG_THREAD` exists in
`A.h` ("calls back to AE can only be made from the same thread AE
called you on"), and no header sanctions calling project suites from
an arbitrary context — including plug-in init, where no project may
even be open.

`src/probe.cpp` therefore splits the two phases:

### Phase 1 — `AEProbePluginEntry` (PiPL entry point, registration only)

Signature: `AEGP_PluginInitFuncPrototype` (`AE_GeneralPlug.h`). Runs
once at plug-in load and performs **only registration-safe work**:

1. Stores the host `SPBasicSuite*` for later hook dispatch.
2. Acquires `kAEGPUtilitySuite` v6 (13) and `kAEGPRegisterSuite` v5
   (6) via `SPBasicSuite::AcquireSuite`.
3. `AEGP_RegisterWithAEGP` — registers the plug-in *identity*
   (name → `AEGP_PluginID`). Same call the SDK samples make inside
   their entry points (`FBIO.cpp`, `IO.cpp`). Touches no project
   contents. On failure the entry-point `AEGP_PluginID` is used as
   fallback for `AEGP_GetItemName`.
4. `AEGP_RegisterIdleHook` — registers `ProbeIdleHook` for deferred
   dispatch.
5. Releases both suites and returns.

**Fail-closed rule:** suite-acquisition failure or idle-hook
registration failure returns `A_Err_STRUCT` — a partially registered
plug-in is worse than a refused load. `AEGP_RegisterWithAEGP` failure
alone is *not* fatal (documented fallback).

**Why no project queries at init:** "no project open" is a normal host
state — `AEGP_GetNumProjects` documents it may return 0 — not a plug-in
error, and the entry point has no host guarantee that any project
context exists. Querying there would conflate "probe failed" with
"nothing to probe".

### Phase 2 — `ProbeIdleHook` (queries, host-dispatched context)

`AEGP_RegisterSuite5::AEGP_RegisterIdleHook` is the deferred mechanism
the SDK provides for exactly this (`AE_GeneralPlug.h`; used by the
SDK samples `Commando`, `Grabba`, `Easy_Cheese`, `Mangler` under
`Examples/AEGP/`). The host calls the hook on the **AE main thread**
during idle — the same class of context in which `ProjDumper`'s
`CommandHook` and `Commando`'s hooks run their AEGP queries.

Inside the hook the probe:

1. Acquires the fingerprint suites (`Utility` v6/13, `Proj` v6/9,
   `Memory` v1/1), validates every function-table entry it will
   dereference, and releases all of them before returning — on every
   path. The `Item` suite is acquired **only** when a probe run is
   triggered, so steady-state ticks do not churn it.
2. Computes a **project-set fingerprint**: project count plus, for up
   to `MAX_PROJECTS_SCANNED` (4) projects, name and path
   (`AEGP_GetProjectName` + `AEGP_GetProjectPath`). The full probe
   body runs **only when the fingerprint differs** from the last
   successful one. Triggers are `probe.reason=initial` (first
   dispatch), `probe.reason=identity-change` (fingerprint differs —
   covers same-count project switches), and `probe.reason=recovery`
   (the previous fingerprint attempt failed, e.g. `GetNumProjects` or
   a per-project query errored, and now succeeds again). A
   steady-state idle loop therefore stays completely silent — no
   probe markers and no op records reach the debug log.
3. `num_projects == 0` is logged as `app.numProjects=0` and per-project
   queries are skipped — normal state, not an error.
4. All results go to `AEGP_WriteToDebugLog` (subsystem `ae-a8n`,
   event `nativeprobe`). Query-level errors are logged and skipped;
   they never fail the hook. Only infrastructure failures (suite
   acquisition, missing suite entries) return an error.

### Per-call evidence records

Every `AEGP_*`/`SPBasicSuite` call emits one record:

```
op <Suite>.<member> err=<A_Err> [k=v ...]
```

Records made outside a probe run (suite acquires, `GetNumProjects`,
fingerprint queries, suite releases on quiet ticks) accumulate in a
per-tick buffer and are **discarded** unless a probe run follows; a
run flushes the buffer after `probe.start` and then records live
through the suite releases. `k=v` suffixes carry observed scalars
(`value=`, composite `v=`) or call context (`suite=`, `version=`,
`i=`). `AEGP_WriteToDebugLog` cannot self-evidence — its evidence is
the existence of the run's output. The result contract these lines
feed is `specs/ae-capability-coverage/contracts/native-probe-result.md`
(branch `19`).

The probe registers **no menu commands** (unlike `ProjDumper`): the
idle hook needs no user interaction, which keeps the later load proof
automatable. It still performs no mutation — dispatch context is used
for reads only.

### Suites acquired

| Suite | Version requested | Struct | Phase |
| --- | --- | --- | --- |
| `kAEGPUtilitySuite` ("AEGP Utility Suite") | `kAEGPUtilitySuiteVersion6` (13) | `AEGP_UtilitySuite6` | init + idle |
| `kAEGPRegisterSuite` ("AEGP Register Suite") | `kAEGPRegisterSuiteVersion5` (6) | `AEGP_RegisterSuite5` | init only |
| `kAEGPProjSuite` ("AEGP Proj Suite") | `kAEGPProjSuiteVersion6` (9) | `AEGP_ProjSuite6` | idle only |
| `kAEGPItemSuite` ("AEGP Item Suite") | `kAEGPItemSuiteVersion9` (14) | `AEGP_ItemSuite9` | idle, probe branch only |
| `kAEGPMemorySuite` ("AEGP Memory Suite") | `kAEGPMemorySuiteVersion1` (1) | `AEGP_MemorySuite1` | idle only |
| `kAEGPRenderQueueSuite` / `kAEGPRQItemSuite` | v1 (1) / v4 (4) | `AEGP_RenderQueueSuite1` / `AEGP_RQItemSuite4` | idle, probe branch only, non-fatal |
| `kAEGPItemViewSuite` ("AEGP Item View Suite") | `kAEGPItemViewSuiteVersion2` (2) | `AEGP_ItemViewSuite2` | idle, probe branch only, non-fatal |
| `kAEGPCompSuite` ("AEGP Comp Suite") | `kAEGPCompSuiteVersion13` (27) | `AEGP_CompSuite13` | idle, probe branch only, non-fatal |

Every `AcquireSuite` is paired with `ReleaseSuite` on all exit paths.

### Read-only calls used, and why each cannot mutate project state

| Call | Suite | Why read-only |
| --- | --- | --- |
| `AEGP_RegisterWithAEGP` | Utility | Registers plug-in identity (name → `AEGP_PluginID`); touches no project contents. Same usage as SDK `FBIO`/`IO` samples. |
| `AEGP_RegisterIdleHook` | Register | Registers a callback. No project state. |
| `AEGP_GetDriverPluginInitFuncVersion` / `AEGP_GetDriverImplementationVersion` / `AEGP_GetSuppressInteractiveUI` / `AEGP_HostIsActivated` | Utility | Host-state getters. |
| `AEGP_WriteToDebugLog` | Utility | Diagnostic output only. |
| `AEGP_GetNumProjects` / `AEGP_GetProjectByIndex` / `AEGP_GetProjectName` / `AEGP_ProjectIsDirty` / `AEGP_GetProjectBitDepth` / `AEGP_GetProjectRootFolder` / `AEGP_GetProjectPath` / `AEGP_GetProjectTimeDisplay` | Proj | Project enumeration getters. `AEGP_GetProjectPath` is queried for the fingerprint **and** logged as `project[i].path` — it writes local paths to the AE debug log, so evidence excerpts must be redacted before sharing. |
| `AEGP_GetFirstProjItem` / `AEGP_GetNextProjItem` / `AEGP_GetItemType` / `AEGP_GetItemName` / `AEGP_GetActiveItem` / `AEGP_IsItemSelected` / `AEGP_GetTypeName` / `AEGP_GetItemID` / `AEGP_GetItemFlags` / `AEGP_GetItemParentFolder` / `AEGP_GetItemDuration` / `AEGP_GetItemCurrentTime` / `AEGP_GetItemDimensions` / `AEGP_GetItemPixelAspectRatio` / `AEGP_GetItemComment` / `AEGP_GetItemLabel` / `AEGP_GetItemMRUView` | Item | Top-level item iteration + per-item metadata getters (capped at 4096 items walked / 8 named items detailed). All are queries; the extended set runs only for the first `MAX_ITEM_NAMES` items. |
| `AEGP_GetItemViewPlaybackTime` / `AEGP_GetItemViewGuidesVisible` / `AEGP_GetItemViewGuidesSnap` / `AEGP_GetItemViewGuidesLocked` | Item View | Read-only viewer-state getters, called only for a non-NULL MRU view handle; the whole slice is skipped when the suite is unavailable (non-fatal, like the render-queue slice). |
| `AEGP_GetCompFromItem` / `AEGP_GetItemFromComp` / `AEGP_GetCompFramerate` / `AEGP_GetCompFrameDuration` / `AEGP_GetCompDownsampleFactor` / `AEGP_GetCompBGColor` / `AEGP_GetCompFlags` / `AEGP_GetShowLayerNameOrSourceName` / `AEGP_GetShowBlendModes` / `AEGP_GetCompShutterAnglePhase` / `AEGP_GetCompShutterFrameRange` / `AEGP_GetCompSuggestedMotionBlurSamples` / `AEGP_GetCompMotionBlurAdaptiveSampleLimit` / `AEGP_GetCompWorkAreaStart` / `AEGP_GetCompWorkAreaDuration` / `AEGP_GetCompDisplayStartTime` / `AEGP_GetCompDisplayDropFrame` / `AEGP_GetMostRecentlyUsedComp` | Comp | Read-only comp getters, called only for `AEGP_ItemType_COMP` items (plus one MRU-comp query per run). The whole slice is skipped when the suite is unavailable (non-fatal). `AEGP_GetCompShutterFrameRange` is evaluated at comp time zero. Comp handles are borrowed — never freed. |
| `AEGP_GetRenderQueueState` and the `AEGP_RQItemSuite4` getters | Render Queue / RQ Item | Read-only queue observation; suite acquisition failure is non-fatal. |
| `AEGP_GetMemHandleSize` / `AEGP_LockMemHandle` / `AEGP_UnlockMemHandle` / `AEGP_FreeMemHandle` | Memory | Bounded read + mandatory disposal of AE-allocated name/comment strings. Lock/read/free only. |

Deliberately **not** used: every `Set*`/`Create*`/`Delete*`/`Save*`/
`Open*`/`New*` entry point, `AEGP_ExecuteScript`, menu/command hooks,
undo groups, render, IO and persistent-data suites.

## Memory & error-path discipline

- `AEGP_GetItemName` returns an `AEGP_MemHandle` documented as a
  null-terminated UTF-16 string that **must** be disposed with
  `AEGP_FreeMemHandle`. The probe bounds reads by
  `AEGP_GetMemHandleSize` (bytes ÷ `sizeof(A_UTF16Char)` code units) —
  it does not rely on the terminator being present — converts with
  explicit surrogate-pair handling (lone surrogates → U+FFFD), pairs
  every successful `AEGP_LockMemHandle` with `AEGP_UnlockMemHandle`,
  and calls `AEGP_FreeMemHandle` on **every** exit path once the handle
  is owned (success, size-query failure, lock failure). No leak, no
  double-free, no use-after-free.
- Suite function-table entries are null-checked before first use; a
  missing entry fails closed (`A_Err_STRUCT`) rather than calling
  through a null pointer.
- `AEGP_MemSize` is `A_u_long` **bytes**; an odd trailing byte is
  ignored (cannot form a code unit).

See `REVIEW.md` for the ABI / callback-lifetime / thread-affinity
review against SDK 26.5 headers and the `Sweetie`/`ProjDumper`/
`Commando` samples.

## Build

```sh
AE_SDK_ROOT=/path/to/AeSDK ./build.sh [outdir]
# or, building the SDK samples too:
cd .. && AE_SDK_ROOT=/path/to/AeSDK ./build-macos.sh ./build
#   → ./build/minimal-plugin/NativeProbe.plugin
```

Toolchain: host `clang++` (Xcode 27.2, macOS SDK), `Rez` for the PiPL
resource, `codesign --sign -` (ad-hoc, same posture as the SDK
samples). No Xcode project is required; `build.sh` invokes the tools
directly so the procedure is auditable from docs alone.

The `.plugin` bundle layout produced:

```
NativeProbe.plugin/Contents/
├── MacOS/NativeProbe        # Mach-O 64-bit bundle, arm64
├── Resources/NativeProbe.rsrc  # PiPL: Kind AEGx, entry AEProbePluginEntry
├── Info.plist               # CFBundlePackageType AEGx / signature FXTC
├── PkgInfo                  # "AEgxFXTC"
└── _CodeSignature/          # ad-hoc signature
```

`ProbePiPL.r` + `plugin-Info.plist` are original files in this
directory; SDK headers (`Examples/Headers`) are referenced at build
time only and never committed. The PiPL declares only the entry
point — idle hooks are registered at runtime via
`AEGP_RegisterIdleHook`, so **no PiPL/menu-resource changes were
needed** (same convention as `ProjDumper`, whose PiPL also declares no
commands).

## Mock-host unit tests

`test/` contains a self-contained harness that compiles the **real**
`src/probe.cpp` against a fake `SPBasicSuite`/AEGP suite tables —
plain `clang++`, no After Effects, no GUI:

```sh
AE_SDK_ROOT=/path/to/AeSDK ./test/run_tests.sh
```

The fake captures the registered `AEGP_IdleHook` function pointer, so
tests drive the real entry point **and** the real hook dispatch path.
Coverage includes: suite-acquisition failure at init (utility,
register) and at each probe suite, idle-hook registration failure,
`RegisterWithAEGP` failure fallback, null function-table entries,
memory alloc/lock/size failures (handles still freed, locks balanced),
unterminated and odd-sized UTF-16 payloads, lone surrogates, NULL
handles, `numProjects` 0 / 1 / 2, fingerprint triggers (initial,
identity-change incl. same-count switch and same-name/different-path,
recovery from count/name/path query failures, missing project),
silent steady-state ticks (no markers, no op records), and op-record
emission for entry and probe calls, plus the Issue #63 extended
slice (project time display, per-item metadata, active item, MRU
view getters) and the Issue #64 comp read-only slice (per-comp
getters for COMP items, MRU comp, per-call failure paths,
non-fatal suite degradation). Latest run: **929 checks, 0
failures** (see `../EVIDENCE.md`).

These are **unit/mock-level** checks of our own code only — they do
not exercise real AE dispatch, real suite behaviour, or real timing.

## Verification status

| Item | State |
| --- | --- |
| Compiles + links on macOS arm64 / Xcode 27.2 | verified on **build host** |
| `.plugin` bundle structure, arch, linkage, signature | verified on **build host** (see `../EVIDENCE.md`) |
| Mock-host unit tests (`test/run_tests.sh`) | **automated test** — 929 checks green, fake host only |
| Load into After Effects | **UNVERIFIED** — needs authorized AE session |
| Entry-point execution / idle-hook dispatch / AEGP query results | **UNVERIFIED** — same gate |
| Windows build/load | **UNVERIFIED** — no Windows host |
