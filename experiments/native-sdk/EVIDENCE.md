# EVIDENCE — native-sdk build probe

Measured 2026-11-14 (SDK samples), 2026-11-15, 2026-11-16 and
2026-11-18 (minimal-plugin, incl. lifecycle restructure, render-queue
slice, Issue #63 extended read-only slice, Issue #64 comp + layer read-only slices + mock-host tests) on the
macOS development host. **SDK build-machine evidence only** —
`BUILD SUCCEEDED` means the sample compiles; it is not plugin-load
evidence, not execution evidence, and not `verified-real-host`
catalog evidence. **No After Effects process was launched** and no
plugin was loaded. The independent states (SDK build / own-plugin
build / AE load / execution / Windows) are tracked separately in
`README.md` and must not be collapsed.

## Environment

| Fact | Value |
| --- | --- |
| Host | macOS arm64 (Apple Silicon), operator's dev machine |
| Xcode | 27.2 (build 27B52), `xcode-select` → `/Applications/Xcode.app` |
| SDK | After Effects SDK 26.5 macOS, operator-supplied at `~/Documents/projects/adobe/AeSDK` (never vendored; archive sha256 in `inventories/sdk/generated/provenance.json`) |
| AE installed | After Effects 2026 (26.5.3) and 2027 (27.0.0) — **not launched for this probe** |

## Results

| Sample | Suite family | Command | Result |
| --- | --- | --- | --- |
| `AEGP/Sweetie` | AEGP (general plug-in) | `build-macos.sh` → xcodebuild Debug | **BUILD SUCCEEDED** → `Sweetie.plugin` (arm64, ad-hoc "Sign to Run Locally") |
| `Effect/Checkout` | Effect (PF, CPU path) | same | **BUILD SUCCEEDED** → `Checkout.plugin` |
| `minimal-plugin/` (`NativeProbe`) | AEGP (general plug-in, own code, read-only) | `build-macos.sh` → `minimal-plugin/build.sh` (clang++ + Rez + codesign) | **BUILD SUCCEEDED** → `NativeProbe.plugin` — artifact verification below |
| `Effect/SDK_Invert_ProcAmp` | Effect + GPU kernels | same | **BUILD FAILED** — see blockers |

Full logs: `build/<name>.build.log`, `build/minimal-plugin/NativeProbe.*.log`
(gitignored; regenerate with `build-macos.sh`).

## NativeProbe.plugin artifact verification (build host, 2026-11-16, post-restructure)

Path: `experiments/native-sdk/build/minimal-plugin/NativeProbe.plugin`
(gitignored build output; rebuild via `minimal-plugin/build.sh`).

| Check | Command | Result |
| --- | --- | --- |
| Bundle structure | `find` | `Contents/{MacOS/NativeProbe, Resources/NativeProbe.rsrc, Info.plist, PkgInfo, _CodeSignature/CodeResources}` |
| Mach-O type/arch | `file` | `Mach-O 64-bit bundle arm64` |
| Fat/thin | `lipo -info` | `Non-fat file … architecture: arm64` |
| Dynamic linkage | `otool -L` | `/usr/lib/libSystem.B.dylib` only — no SDK/Adobe dylibs |
| Signature | `codesign -dv` | `Signature=adhoc`, `flags=0x2(adhoc)`, `Identifier=dev.ae-a8n.NativeProbe` |
| Entry symbol | `nm -gU` | `_AEProbePluginEntry` exported (unmangled `extern "C"`) |
| PiPL resource | `DeRez -useDF … NativeProbe.rsrc` | `data 'PiPL' (16000)`: Kind `AEgx`, Name `NativeProbe`, Category `General Plugin`, `CodeMacIntel64`/`CodeMacARM64` → `"AEProbePluginEntry"` |
| PkgInfo | `xxd` | `AEgxFXTC` (package type AEGx, creator FXTC — matches SDK sample convention) |
| Content hashes (sha256) | `shasum -a 256` | executable hash recorded post-#64-layer rebuild (see build log), rsrc `9e5d258d…7249f3` (unchanged), Info.plist `89aad984…d662d` (gitignored; hashes recorded for the load-proof fixture step) |

## NativeProbe mock-host unit tests (2026-11-16, extended 2026-11-18)

`minimal-plugin/test/run_tests.sh` compiles the real `src/probe.cpp`
against a fake `SPBasicSuite`/AEGP suite-table host — plain `clang++`,
no After Effects, no GUI:

```
1312 checks, 0 failures
```

Coverage: init-time suite-acquire failure (utility, register),
null `SPBasicSuite`, idle-hook registration failure,
`AEGP_RegisterWithAEGP` failure fallback, per-suite acquire failure
inside the idle hook (utility/proj/memory at fingerprint stage, item
at probe stage, item-view non-fatal), null function-table entries
(proj count/path/time-display, mem free/size, debug log, item detail
entries fail-closed, item-view entries non-fatal), `AEGP_GetItemName`
alloc/lock/size failures with handle still freed and locks balanced,
NULL handle with success, unterminated + odd-sized UTF-16 payloads,
lone-surrogate → U+FFFD, `numProjects` 0/1/2, fingerprint triggers
(initial, identity-change incl. same-count project switch and
same-name/different-path, recovery from `GetNumProjects`/name/path
query failures and from a missing project), silent steady-state
ticks (no markers, no op records), read-only render-queue slice
(`AEGP_RenderQueueSuite1`/`AEGP_RQItemSuite4` getters, non-fatal
acquire failure, per-item op records), the Issue #63 extended
read-only slice (`AEGP_GetProjectTimeDisplay`, per-item metadata
getters, `AEGP_GetActiveItem`, `AEGP_GetItemMRUView` +
`AEGP_ItemViewSuite2` getters, per-call failure paths), the Issue
#64 comp read-only slice (`AEGP_CompSuite13` getters for COMP
items, `AEGP_GetMostRecentlyUsedComp`) and the Issue #64 layer
read-only slice (`AEGP_LayerSuite9` layer enumeration +
per-layer read-only getters inside COMP items), per-call failure
paths, non-fatal suite degradation, and `op <Suite>.<member>` record
emission for entry and probe calls. Suite acquire/release counts
balance on every path.

**Level: automated test against a fake host — unit-level evidence
only.** It exercises our code's control flow and memory discipline;
it says nothing about real AE dispatch, real suite semantics, or real
timing. Not `fake/mock only`-as-working for the plugin itself — the
plugin remains UNVERIFIED below build-host level.

The suite also covers the Issue #267 Slice A native intake channel
(`native-channel/v1`, `src/native_intake.cpp` + `src/native_json.cpp`):
opt-in gating, claim/validate/execute/publish, every refusal code,
duplicate/stale/token/session/target mismatch, suite and publish
failure, channel privacy violation, and channel-token non-leakage —
all at fake-host level only. No intake result promotes any registry
operation; `verifiedOnRealHost`/`externalDispatchVerified` remain
false pending the #223 authorized real-host session (Slice C).

AE load/registration/execution of this bundle: **UNVERIFIED** — see
blocker 2 below and `LOAD-PROOF.md`.

## Blockers recorded (real missing dependencies only)

1. **GPU kernel path (#18, CAP043 scope):** `SDK_Invert_ProcAmp` fails in
   the kernel-preprocessing build phase:
   - `metal_common` header not found — part of the AE GPU SDK component,
     not present in the base 26.5 distribution on this machine.
   - `boost/preprocessor/...` not found — `BOOST_BASE_PATH` unset; Boost is
     not vendored anywhere under `AeSDK/`.
   CPU-only effect samples are unaffected. Obtaining the GPU SDK addendum
   and/or Boost is a **real blocker** for SmartFX/MFR/GPU fixtures; it does
   not block the CPU effect vertical slice.
2. **Plugin load/registration:** unverified for all three bundles
   (`Sweetie.plugin`, `Checkout.plugin`, `NativeProbe.plugin`) — a
   distinct state from the build results above. Loading a `.plugin`
   requires launching After Effects; the operator's interactive AE
   session is off-limits for this work and no dedicated host exists
   yet. Ad-hoc signing acceptance by AE on this macOS version is
   unknown until then.
3. **Plugin execution:** unverified — even a successful load would not
   prove command registration, effect render, or crash/unload behaviour.
4. **Windows:** entirely UNVERIFIED — no Windows host, per Issue #21.

## Reproduce

```sh
cd experiments/native-sdk
AE_SDK_ROOT=/path/to/AeSDK ./build-macos.sh ./build
```

Expected: `Sweetie: BUILD SUCCEEDED`, `Checkout: BUILD SUCCEEDED`,
`NativeProbe.plugin built` (under `build/minimal-plugin/`).
