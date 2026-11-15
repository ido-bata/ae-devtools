# minimal-plugin — ae-a8n read-only AEGP probe (Issue #17, CAP038)

`NativeProbe.plugin` is **our own** minimal AEGP (AE General Plug-in,
PiPL Kind `AEgx`) written for this repository. It is original code —
no Adobe sample source is copied. It exists to prove the
compile → link → `.plugin` bundle path for a hand-written AEGP plug-in,
and to be the smallest possible vehicle for a later authorized
real-host load/execution proof.

> **Verification state: build/artifact verified on the build host
> only.** AE plug-in load, registration and execution are **UNVERIFIED**
> — they require an authorized real-AE session (see
> `../LOAD-PROOF.md`). Nothing here is `verified-real-host` evidence.
> Windows is entirely UNVERIFIED.

## What it does at load time

The PiPL-declared entry point `AEProbePluginEntry`
(`src/probe.cpp`, signature `AEGP_PluginInitFuncPrototype`) runs once
when AE loads the plug-in. It acquires four AEGP suites through
`SPBasicSuite::AcquireSuite` and performs **read-only queries only**,
reporting each result via `AEGP_WriteToDebugLog` (subsystem
`ae-a8n`, event `nativeprobe`). It registers no menu commands, no
hooks, and mutates no project state. Suite-acquisition failure aborts
the probe and returns an error (fail closed); individual query errors
are logged and skipped.

### Suites acquired (all via `SPBasicSuite::AcquireSuite`)

| Suite | Version requested | Struct |
| --- | --- | --- |
| `kAEGPUtilitySuite` ("AEGP Utility Suite") | `kAEGPUtilitySuiteVersion6` (13) | `AEGP_UtilitySuite6` |
| `kAEGPProjSuite` ("AEGP Proj Suite") | `kAEGPProjSuiteVersion6` (9) | `AEGP_ProjSuite6` |
| `kAEGPItemSuite` ("AEGP Item Suite") | `kAEGPItemSuiteVersion9` (14) | `AEGP_ItemSuite9` |
| `kAEGPMemorySuite` ("AEGP Memory Suite") | `kAEGPMemorySuiteVersion1` (1) | `AEGP_MemorySuite1` |

All are released with `ReleaseSuite` before the entry point returns.

### Read-only calls used, and why each cannot mutate project state

| Call | Suite | Why read-only |
| --- | --- | --- |
| `AEGP_RegisterWithAEGP` | Utility | Registers the plug-in's *identity* (name → `AEGP_PluginID`) for subsequent AEGP calls; touches no project contents. Falls back to the host-passed id if unavailable. |
| `AEGP_GetDriverPluginInitFuncVersion` | Utility | Returns AE plug-in API version numbers. Getter. |
| `AEGP_GetDriverImplementationVersion` | Utility | Returns AE implementation version numbers. Getter. |
| `AEGP_GetSuppressInteractiveUI` | Utility | Returns a host-mode flag. Getter. |
| `AEGP_HostIsActivated` | Utility | Returns license-activation boolean. Getter. |
| `AEGP_WriteToDebugLog` | Utility | Writes to AE's debug log / stdout console. The only side effect, and it is diagnostic output, not project state. |
| `AEGP_GetNumProjects` / `AEGP_GetProjectByIndex` | Proj | Enumerate open projects (always ≤1 in modern AE). Getters. |
| `AEGP_GetProjectName` | Proj | Copies the project name into a caller buffer. Getter. |
| `AEGP_ProjectIsDirty` | Proj | Returns dirty flag. Getter. |
| `AEGP_GetProjectBitDepth` | Proj | Returns bit-depth enum. Getter. |
| `AEGP_GetProjectRootFolder` | Proj | Returns an `AEGP_ItemH` handle to the root folder. Getter — the project path (`AEGP_GetProjectPath`) is deliberately **not** queried to avoid writing local paths into the debug log. |
| `AEGP_GetFirstProjItem` / `AEGP_GetNextProjItem` | Item | Iterate top-level project items (capped at 4096). Getters. |
| `AEGP_GetItemType` | Item | Returns item-type enum of first item. Getter. |
| `AEGP_GetItemName` | Item | Returns UTF-16 item name in an AE-allocated mem handle (disposed via `AEGP_FreeMemHandle`). Getter — the handle disposal is required memory hygiene, not mutation. |
| `AEGP_LockMemHandle` / `AEGP_UnlockMemHandle` / `AEGP_GetMemHandleSize` / `AEGP_FreeMemHandle` | Memory | Mem-handle access for the two name strings above. Lock/read/free only. |

Deliberately **not** used: every `Set*`/`Create*`/`Delete*`/`Save*`/
`Open*`/`New*` entry point, `AEGP_ExecuteScript`, menu/command hooks,
undo groups, render, IO and persistent-data suites.

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
time only and never committed.

## Verification status

| Item | State |
| --- | --- |
| Compiles + links on macOS arm64 / Xcode 27.2 | verified on **build host** |
| `.plugin` bundle structure, arch, linkage, signature | verified on **build host** (see `../EVIDENCE.md`) |
| Load into After Effects | **UNVERIFIED** — needs authorized AE session |
| Entry-point execution / AEGP query results | **UNVERIFIED** — same gate |
| Windows build/load | **UNVERIFIED** — no Windows host |
